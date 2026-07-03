import type { Readable } from "node:stream";
import { ApiError } from "../core/http.js";
import { getUploadLimitBytes, type StorageConfig } from "../config/settings.js";
import { isReservedRootKey, storageObjectName, type ReadablePrefix, type StoragePrefix } from "./object-keys.js";
import { nodeReadableFromWeb, streamToBuffer } from "./stream-buffer.js";
import type {
  CopyPrefix,
  MoveFromPrefix,
  MoveToPrefix,
  OpenedRead,
  StorageDriver,
  StorageSelfTest
} from "./storage-backend.js";

const PROPFIND_BODY = '<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>';

function trimSlashes(value: string) {
  return value.replace(/^\/+|\/+$/g, "");
}

export class WebdavBackend implements StorageDriver {
  private readonly base: string;
  private readonly origin: string;

  constructor(private readonly config: StorageConfig) {
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
    const name = prefix === "objects" ? "" : prefix;
    const segs = [...trimSlashes(this.config.webdav.root_path).split("/"), ...(name ? [name] : [])].filter(Boolean);
    return `${segs.length ? `${this.base}/${segs.map(encodeURIComponent).join("/")}` : this.base}/`;
  }

  private async ensureParent(prefix: StoragePrefix, key: string) {
    const parts = storageObjectName(prefix, key).split("/").slice(0, -1);
    const segs = [...trimSlashes(this.config.webdav.root_path).split("/"), ...parts].filter(Boolean);
    let acc = this.base;
    for (const seg of segs) {
      acc += `/${encodeURIComponent(seg)}`;
      await fetch(acc, { method: "MKCOL", headers: this.auth() }).catch(() => undefined);
    }
  }

  async exists(prefix: StoragePrefix, key: string) {
    try {
      const res = await fetch(this.objectUrl(prefix, key), { method: "HEAD", headers: this.auth() });
      return res.ok;
    } catch {
      return false;
    }
  }

  async openRead(prefix: StoragePrefix, key: string): Promise<OpenedRead> {
    const res = await fetch(this.objectUrl(prefix, key), { headers: this.auth() });
    if (!res.ok || !res.body) throw new ApiError(res.status === 404 ? 404 : 502, "storage_read_failed", `WebDAV GET failed (${res.status})`);
    const size = Number(res.headers.get("content-length"));
    return { body: nodeReadableFromWeb(res.body), size: Number.isFinite(size) && size >= 0 ? size : undefined, backend: "webdav" };
  }

  async readBuffer(prefix: StoragePrefix, key: string) {
    const limit = await getUploadLimitBytes();
    const opened = await this.openRead(prefix, key);
    if (opened.size !== undefined && opened.size > limit) {
      opened.body.destroy();
      throw new ApiError(400, "object_too_large", "图片大小超过限制", { limit });
    }
    try {
      return await streamToBuffer(opened.body, limit);
    } catch (error) {
      opened.body.destroy();
      throw error;
    }
  }

  async writeBuffer(prefix: StoragePrefix, key: string, body: Buffer, type: string) {
    const url = this.objectUrl(prefix, key);

    const payload = body as unknown as BodyInit;
    const put = () => fetch(url, { method: "PUT", headers: { ...this.auth(), "Content-Type": type }, body: payload });
    let res = await put();

    if (res.status === 403 || res.status === 409 || res.status === 404) {
      await this.ensureParent(prefix, key);
      res = await put();
    }
    if (!res.ok) throw new ApiError(502, "storage_write_failed", `WebDAV PUT failed (${res.status})`);
  }

  async remove(prefix: StoragePrefix, key: string) {
    const res = await fetch(this.objectUrl(prefix, key), { method: "DELETE", headers: this.auth() });
    if (!res.ok && res.status !== 404) throw new ApiError(502, "storage_delete_failed", `WebDAV DELETE failed (${res.status})`);
  }

  async move(fromPrefix: MoveFromPrefix, fromKey: string, toPrefix: MoveToPrefix, toKey: string, _targetContentType?: string) {
    await this.transfer("MOVE", fromPrefix, fromKey, toPrefix, toKey);
  }

  async copy(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string) {
    await this.transfer("COPY", fromPrefix, fromKey, toPrefix, toKey);
  }

  private async transfer(method: "MOVE" | "COPY", fromPrefix: StoragePrefix, fromKey: string, toPrefix: StoragePrefix, toKey: string) {

    await this.ensureParent(toPrefix, toKey);
    const res = await fetch(this.objectUrl(fromPrefix, fromKey), {
      method,
      headers: { ...this.auth(), Destination: this.objectUrl(toPrefix, toKey), Overwrite: "T" }
    });
    if (!res.ok) throw new ApiError(502, "storage_transfer_failed", `WebDAV ${method} failed (${res.status})`);
  }

  async readObject(prefix: ReadablePrefix, key: string): Promise<Readable> {
    const res = await fetch(this.objectUrl(prefix, key), { headers: this.auth() });
    if (!res.ok || !res.body) throw new ApiError(res.status === 404 ? 404 : 502, "storage_read_failed", `WebDAV GET failed (${res.status})`);
    return nodeReadableFromWeb(res.body);
  }

  async listKeys(prefix: StoragePrefix) {
    const rootUrl = this.collectionUrl(prefix);
    const rootPath = decodeURIComponent(new URL(rootUrl).pathname).replace(/\/+$/, "");

    const propfind = async (url: string, depth: "1" | "infinity") => {
      const res = await fetch(url, { method: "PROPFIND", headers: { ...this.auth(), Depth: depth, "Content-Type": "application/xml" }, body: PROPFIND_BODY });
      if (res.status === 404) return [];
      if (!res.ok) throw new ApiError(502, "storage_list_failed", `WebDAV PROPFIND failed (${res.status})`);
      return parsePropfind(await res.text(), this.origin);
    };

    const toKey = (entry: { path: string; collection: boolean }) => {
      if (entry.collection || !entry.path.startsWith(`${rootPath}/`)) return null;
      const rel = entry.path.slice(rootPath.length + 1);
      if (!rel) return null;
      if (prefix === "objects" && isReservedRootKey(rel)) return null;
      return rel;
    };

    if (this.config.webdav.list_depth_infinity) {
      return (await propfind(rootUrl, "infinity")).map(toKey).filter((key): key is string => key !== null);
    }

    const keys: string[] = [];
    const walk = async (url: string) => {
      const here = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, "");
      const subdirs: string[] = [];
      for (const entry of await propfind(url, "1")) {
        if (entry.path === here) continue;
        if (entry.collection) { subdirs.push(entry.url); continue; }
        const key = toKey(entry);
        if (key !== null) keys.push(key);
      }
      await Promise.all(subdirs.map(walk));
    };
    await walk(rootUrl);
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

function parsePropfind(xml: string, origin: string) {
  const entries: Array<{ url: string; path: string; collection: boolean }> = [];
  const blocks = xml.match(/<(?:\w+:)?response\b[\s\S]*?<\/(?:\w+:)?response>/gi) ?? [];
  for (const block of blocks) {
    const hrefMatch = block.match(/<(?:\w+:)?href\b[^>]*>([\s\S]*?)<\/(?:\w+:)?href>/i);
    if (!hrefMatch) continue;
    const href = hrefMatch[1].trim();
    if (!href) continue;
    const url = /^https?:\/\//i.test(href) ? href : origin + (href.startsWith("/") ? href : `/${href}`);
    const collection = /<(?:\w+:)?collection\b\s*\/?\s*>/i.test(block) || href.endsWith("/");
    entries.push({ url, path: decodeURIComponent(new URL(url).pathname).replace(/\/+$/, ""), collection });
  }
  return entries;
}
