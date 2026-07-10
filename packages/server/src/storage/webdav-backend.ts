import type { Readable } from "node:stream";
import { XMLParser } from "fast-xml-parser";
import { ApiError } from "../core/http.ts";
import { getInputImageMaxBytes } from "../config/app-settings.ts";
import type { StorageConfig } from "./backend-config.ts";
import { contentTypeForKey, storageObjectName, type ReadablePrefix, type StoragePrefix } from "./object-keys.ts";
import { nodeReadableFromWeb, streamToBuffer } from "./stream-buffer.ts";
import type {
  CopyPrefix,
  OpenedRead,
  StorageDriver,
  StorageSelfTest
} from "./storage-backend.ts";

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>';
const WEBDAV_TIMEOUT_MS = 15_000;
const WEBDAV_RETRY_ATTEMPTS = 3;
const WEBDAV_RETRY_BASE_MS = 250;
const WEBDAV_LIST_CONCURRENCY = 4;
const WEBDAV_MAX_LIST_KEYS = 50_000;
const webdavXmlParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  removeNSPrefix: true
});

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(response: Response, attempt: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 10_000);
  }
  return WEBDAV_RETRY_BASE_MS * 2 ** attempt;
}

function shouldRetryWebdavStatus(status: number) {
  return status === 429 || (status >= 500 && status <= 599);
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function responseWithTimeout(response: Response, timer: ReturnType<typeof setTimeout>) {
  if (!response.body) {
    clearTimeout(timer);
    return response;
  }
  const reader = response.body.getReader();
  let closed = false;
  const closeTimer = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          closeTimer();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        closeTimer();
        controller.error(error);
      }
    },
    cancel(reason) {
      closeTimer();
      return reader.cancel(reason);
    }
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function webdavFetch(input: string, init: RequestInit) {
  const method = String(init.method ?? "GET").toUpperCase();
  const streamsResponseBody = method === "GET" || method === "PROPFIND";
  for (let attempt = 0; attempt < WEBDAV_RETRY_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBDAV_TIMEOUT_MS);
    let handedOffTimer = false;
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      if (!shouldRetryWebdavStatus(response.status) || attempt === WEBDAV_RETRY_ATTEMPTS - 1) {
        if (!streamsResponseBody) {
          await response.body?.cancel().catch(() => undefined);
          clearTimeout(timer);
          return response;
        }
        handedOffTimer = Boolean(response.body);
        return responseWithTimeout(response, timer);
      }
      const delayMs = retryAfterMs(response, attempt);
      clearTimeout(timer);
      await response.body?.cancel().catch(() => undefined);
      await sleep(delayMs);
    } catch (error) {
      if (isAbortError(error) && attempt === WEBDAV_RETRY_ATTEMPTS - 1) {
        throw new ApiError(504, "storage_timeout", "WebDAV request timed out");
      }
      if (attempt === WEBDAV_RETRY_ATTEMPTS - 1) {
        throw new ApiError(502, "storage_request_failed", "WebDAV request failed");
      }
      clearTimeout(timer);
      await sleep(WEBDAV_RETRY_BASE_MS * 2 ** attempt);
    } finally {
      if (!handedOffTimer) clearTimeout(timer);
    }
  }
  throw new ApiError(502, "storage_request_failed", "WebDAV request failed");
}

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

/** @internal Exported only for local storage error verification. */
export function isWebdavNotFoundStatus(status: number) {
  return status === 404;
}

export class WebdavBackend implements StorageDriver {
  private readonly base: string;
  private readonly origin: string;
  private readonly config: StorageConfig;

  constructor(config: StorageConfig) {
    this.config = config;
    this.base = config.webdav.base_url.replace(/\/+$/, "");
    this.origin = (() => { try { return new URL(this.base).origin; } catch { return this.base; } })();
  }

  private auth(): Record<string, string> {
    const { username, password } = this.config.webdav;
    if (!username) return {};
    return { Authorization: `Basic ${Buffer.from(`${username}:${password ?? ""}`).toString("base64")}` };
  }

  private objectUrl(prefix: StoragePrefix, key: string) {
    return this.joinName(storageObjectName(prefix, key));
  }

  private joinName(name: string) {
    const segs = [...trimSlashes(this.config.webdav.root_path).split("/"), ...name.split("/")].filter(Boolean);
    return segs.length ? `${this.base}/${segs.map(encodeURIComponent).join("/")}` : this.base;
  }

  private collectionUrl(prefix: StoragePrefix) {
    const segs = [...trimSlashes(this.config.webdav.root_path).split("/"), prefix].filter(Boolean);
    return `${segs.length ? `${this.base}/${segs.map(encodeURIComponent).join("/")}` : this.base}/`;
  }

  private async ensureParent(prefix: StoragePrefix, key: string) {
    const parts = storageObjectName(prefix, key).split("/").slice(0, -1);
    const segs = [...trimSlashes(this.config.webdav.root_path).split("/"), ...parts].filter(Boolean);
    let acc = this.base;
    for (const seg of segs) {
      acc += `/${encodeURIComponent(seg)}`;
      await webdavFetch(acc, { method: "MKCOL", headers: this.auth() }).catch(() => undefined);
    }
  }

  async exists(prefix: StoragePrefix, key: string) {
    const res = await webdavFetch(this.objectUrl(prefix, key), { method: "HEAD", headers: this.auth() });
    if (res.ok) return true;
    if (isWebdavNotFoundStatus(res.status)) return false;
    throw new ApiError(502, "storage_read_failed", `WebDAV HEAD failed (${res.status})`);
  }

  async openRead(prefix: StoragePrefix, key: string): Promise<OpenedRead> {
    const res = await webdavFetch(this.objectUrl(prefix, key), { headers: this.auth() });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new ApiError(res.status === 404 ? 404 : 502, "storage_read_failed", `WebDAV GET failed (${res.status})`);
    }
    const size = Number(res.headers.get("content-length"));
    return { body: nodeReadableFromWeb(res.body), size: Number.isFinite(size) && size >= 0 ? size : undefined, backend: "webdav" };
  }

  async readBuffer(prefix: StoragePrefix, key: string) {
    const limit = await getInputImageMaxBytes();
    const opened = await this.openRead(prefix, key);
    if (opened.size !== undefined && opened.size > limit) {
      opened.body.destroy();
      throw new ApiError(400, "object_too_large", "图片大小超过限制", { limit });
    }
    try {
      return await streamToBuffer(opened.body, limit);
    } catch (error) {
      opened.body.destroy();
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, "storage_read_failed", "WebDAV GET failed while reading response body");
    }
  }

  async writeBuffer(prefix: StoragePrefix, key: string, body: Buffer, type: string) {
    const url = this.objectUrl(prefix, key);

    const payload = body as unknown as BodyInit;
    const put = () => webdavFetch(url, { method: "PUT", headers: { ...this.auth(), "Content-Type": type }, body: payload });
    let res = await put();

    if (res.status === 403 || res.status === 409 || res.status === 404) {
      await this.ensureParent(prefix, key);
      res = await put();
    }
    if (!res.ok) throw new ApiError(502, "storage_write_failed", `WebDAV PUT failed (${res.status})`);
  }

  async remove(prefix: StoragePrefix, key: string) {
    const res = await webdavFetch(this.objectUrl(prefix, key), { method: "DELETE", headers: this.auth() });
    if (!res.ok && res.status !== 404) throw new ApiError(502, "storage_delete_failed", `WebDAV DELETE failed (${res.status})`);
  }

  async copy(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string) {
    try {
      await this.copyNative(fromPrefix, fromKey, toPrefix, toKey);
    } catch {
      await this.writeBuffer(toPrefix, toKey, await this.readBuffer(fromPrefix, fromKey), contentTypeForKey(toKey));
    }
  }

  private async copyNative(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string) {
    await this.ensureParent(toPrefix, toKey);
    const targetExisted = await this.exists(toPrefix, toKey);
    const fromName = fromKey.split("/").at(-1) ?? fromKey;
    const toParent = toKey.includes("/") ? toKey.slice(0, toKey.lastIndexOf("/") + 1) : "";
    const sideEffectKey = `${toParent}${fromName}`;
    const sideEffectExisted = sideEffectKey === toKey || await this.exists(toPrefix, sideEffectKey);
    let status = 0;
    let requestError: unknown;
    try {
      const response = await webdavFetch(this.objectUrl(fromPrefix, fromKey), {
        method: "COPY",
        headers: { ...this.auth(), Destination: this.objectUrl(toPrefix, toKey), Overwrite: "T" }
      });
      status = response.status;
      await response.body?.cancel().catch(() => undefined);
    } catch (error) {
      requestError = error;
    }

    const targetExists = await this.exists(toPrefix, toKey);
    if (!sideEffectExisted && sideEffectKey !== toKey) {
      await this.remove(toPrefix, sideEffectKey).catch(() => undefined);
    }
    if (status >= 200 && status < 300 && targetExists) {
      if (!targetExisted) return;
      const [sourceBody, targetBody] = await Promise.all([
        this.readBuffer(fromPrefix, fromKey),
        this.readBuffer(toPrefix, toKey)
      ]);
      if (sourceBody.equals(targetBody)) return;
      await this.writeBuffer(toPrefix, toKey, sourceBody, contentTypeForKey(toKey));
      return;
    }
    if (requestError) throw requestError;
    if (targetExisted && targetExists) {
      throw new ApiError(502, "storage_transfer_failed", `WebDAV COPY failed without replacing the existing target (${status || "network error"})`);
    }
    throw new ApiError(502, "storage_transfer_failed", `WebDAV COPY failed (${status || "network error"})`);
  }

  async readObject(prefix: ReadablePrefix, key: string): Promise<Readable> {
    const res = await webdavFetch(this.objectUrl(prefix, key), { headers: this.auth() });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new ApiError(res.status === 404 ? 404 : 502, "storage_read_failed", `WebDAV GET failed (${res.status})`);
    }
    return nodeReadableFromWeb(res.body);
  }

  async listKeys(prefix: StoragePrefix) {
    const rootUrl = this.collectionUrl(prefix);
    const rootPath = decodeURIComponent(new URL(rootUrl).pathname).replace(/\/+$/, "");

    const propfind = async (url: string, depth: "1" | "infinity") => {
      const res = await webdavFetch(url, { method: "PROPFIND", headers: { ...this.auth(), Depth: depth, "Content-Type": "application/xml" }, body: PROPFIND_BODY });
      if (res.status === 404) return [];
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new ApiError(502, "storage_list_failed", `WebDAV PROPFIND failed (${res.status})`);
      }
      return parsePropfind(await res.text(), this.origin);
    };

    const toKey = (entry: { path: string; collection: boolean }) => {
      if (entry.collection || !entry.path.startsWith(`${rootPath}/`)) return null;
      const rel = entry.path.slice(rootPath.length + 1);
      if (!rel) return null;
      return rel;
    };

    if (this.config.webdav.list_depth_infinity) {
      const keys = (await propfind(rootUrl, "infinity")).map(toKey).filter((key): key is string => key !== null);
      if (keys.length > WEBDAV_MAX_LIST_KEYS) throw new ApiError(502, "storage_list_too_large", "WebDAV listing exceeded the safety limit");
      return keys;
    }

    const keys: string[] = [];
    const queue = [rootUrl];
    const pushKey = (key: string) => {
      keys.push(key);
      if (keys.length > WEBDAV_MAX_LIST_KEYS) throw new ApiError(502, "storage_list_too_large", "WebDAV listing exceeded the safety limit");
    };
    const processOne = async (url: string) => {
      const here = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, "");
      for (const entry of await propfind(url, "1")) {
        if (entry.path === here) continue;
        if (entry.collection) {
          queue.push(entry.url);
          continue;
        }
        const key = toKey(entry);
        if (key !== null) pushKey(key);
      }
    };
    await new Promise<void>((resolve, reject) => {
      let active = 0;
      let failed = false;
      const schedule = () => {
        if (failed) return;
        if (!queue.length && active === 0) {
          resolve();
          return;
        }
        while (active < WEBDAV_LIST_CONCURRENCY && queue.length) {
          const url = queue.shift();
          if (!url) continue;
          active += 1;
          processOne(url).then(() => {
            active -= 1;
            schedule();
          }).catch((error) => {
            failed = true;
            reject(error);
          });
        }
      };
      schedule();
    });
    return keys;
  }

  publicObjectUrl(prefix: ReadablePrefix, key: string) {
    const pub = this.config.webdav.public_base_url;
    if (!pub) return "";
    const segs = [...trimSlashes(this.config.webdav.root_path).split("/"), ...storageObjectName(prefix, key).split("/")].filter(Boolean);
    return `${pub.replace(/\/+$/, "")}/${segs.map(encodeURIComponent).join("/")}`;
  }

  async selfTest(): Promise<StorageSelfTest> {
    if (!this.config.webdav.base_url) throw new ApiError(400, "storage_config_incomplete", "Storage config incomplete", { missing: ["base_url"] });
    const key = `.storage-test-${Date.now()}`;
    await this.writeBuffer("_uploads", key, Buffer.from("ok"), "text/plain");
    const present = await this.exists("_uploads", key);
    await this.remove("_uploads", key).catch(() => undefined);
    if (!present) throw new ApiError(502, "storage_test_failed", "WebDAV self-test: the written object could not be read back");
    return { backend: "webdav", writable: true, endpoint: this.config.webdav.base_url, public_base_url: this.config.webdav.public_base_url };
  }

  async pruneEmptyDirs(): Promise<number> {
    return 0;
  }
}

function objectNode(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function nodeChild(value: unknown, key: string) {
  return objectNode(value)?.[key];
}

function nodeArray(value: unknown) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function nodeText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  const node = objectNode(value);
  if (!node) return "";
  return nodeText(node["#text"]);
}

function nodeContainsElement(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((item) => nodeContainsElement(item, key));
  const node = objectNode(value);
  if (!node) return false;
  if (Object.hasOwn(node, key)) return true;
  return Object.values(node).some((item) => nodeContainsElement(item, key));
}

function parsePropfind(xml: string, origin: string) {
  const entries: Array<{ url: string; path: string; collection: boolean }> = [];
  let document: unknown;
  try {
    document = webdavXmlParser.parse(xml);
  } catch {
    throw new ApiError(502, "storage_list_failed", "WebDAV PROPFIND returned invalid XML");
  }
  const root = nodeChild(document, "multistatus") ?? document;
  for (const response of nodeArray(nodeChild(root, "response"))) {
    const href = nodeText(nodeChild(response, "href")).trim();
    if (!href) continue;
    try {
      const parsed = new URL(href, origin);
      const collection = nodeContainsElement(response, "collection") || href.endsWith("/");
      entries.push({ url: parsed.toString(), path: decodeURIComponent(parsed.pathname).replace(/\/+$/, ""), collection });
    } catch {
      // Ignore malformed href entries from non-conforming WebDAV servers.
    }
  }
  return entries;
}
