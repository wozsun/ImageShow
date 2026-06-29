// WebDAV storage backend. Talks the WebDAV HTTP verbs (PROPFIND/MKCOL/PUT/GET/
// DELETE/MOVE/COPY) over fetch, with optional HTTP Basic auth. Object names flow
// through the shared object-keys mapper so keys agree with the other backends; the
// on-server path is base_url + root_path + objectName.
import type { Readable } from "node:stream";
import { ApiError } from "../core/http.js";
import { getUploadLimitBytes, type StorageConfig } from "../config/settings.js";
import { storageObjectName, type ReadablePrefix, type StoragePrefix } from "./object-keys.js";
import { limitedWebStream, nodeReadableFromWeb, streamToBuffer } from "./stream-buffer.js";
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

// fetch with a non-standard WebDAV method needs the duplex flag for a streamed body;
// RequestInit's types don't include it, so widen here.
type DavInit = RequestInit & { duplex?: "half" };

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

  // base_url + root_path + objectName, each appended segment percent-encoded.
  private objectUrl(prefix: StoragePrefix, key: string) {
    return this.joinName(storageObjectName(prefix, key));
  }

  private joinName(name: string) {
    const segs = [...trimSlashes(this.config.webdav.root_path).split("/"), ...name.split("/")].filter(Boolean);
    return segs.length ? `${this.base}/${segs.map(encodeURIComponent).join("/")}` : this.base;
  }

  // The collection (directory) URL for a prefix, with a trailing slash for PROPFIND.
  private collectionUrl(prefix: StoragePrefix) {
    const name = prefix === "objects" ? "" : prefix;
    const segs = [...trimSlashes(this.config.webdav.root_path).split("/"), ...(name ? [name] : [])].filter(Boolean);
    return `${segs.length ? `${this.base}/${segs.map(encodeURIComponent).join("/")}` : this.base}/`;
  }

  // Creates the ancestor collections of an object (root_path dirs + the key's parent
  // dirs). Best-effort: "already exists" responses are expected and ignored.
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
      throw new ApiError(400, "object_too_large", "Object is too large to buffer safely", { limit });
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
    // undici accepts a Buffer body at runtime; the DOM BodyInit type doesn't list
    // node's generic Buffer, so cast.
    const payload = body as unknown as BodyInit;
    const put = () => fetch(url, { method: "PUT", headers: { ...this.auth(), "Content-Type": type }, body: payload });
    let res = await put();
    // A PUT into a missing parent collection fails — Apache mod_dav answers 403 (others
    // 409/404). Create the parent chain and retry once; a genuine 403 just fails again.
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
    // The destination's parent collection must exist first — Apache mod_dav returns a
    // 500 (not a 409) for MOVE/COPY into a missing collection, so create it up front
    // rather than retrying on a status code.
    await this.ensureParent(toPrefix, toKey);
    const res = await fetch(this.objectUrl(fromPrefix, fromKey), {
      method,
      headers: { ...this.auth(), Destination: this.objectUrl(toPrefix, toKey), Overwrite: "T" }
    });
    if (!res.ok) throw new ApiError(502, "storage_transfer_failed", `WebDAV ${method} failed (${res.status})`);
  }

  async writeUploadFromWeb(id: string, body: ReadableStream<Uint8Array>, expectedSize: number) {
    // A streamed body can't be replayed, so ensure the parent collection up front
    // rather than retrying on 409.
    await this.ensureParent("_uploads", id);
    const init: DavInit = {
      method: "PUT",
      headers: { ...this.auth(), "Content-Length": String(expectedSize), "Content-Type": "application/octet-stream" },
      body: limitedWebStream(body, expectedSize),
      duplex: "half"
    };
    const res = await fetch(this.objectUrl("_uploads", id), init);
    if (!res.ok) throw new ApiError(502, "storage_write_failed", `WebDAV upload PUT failed (${res.status})`);
  }

  async readObject(prefix: ReadablePrefix, key: string): Promise<Readable> {
    const res = await fetch(this.objectUrl(prefix, key), { headers: this.auth() });
    if (!res.ok || !res.body) throw new ApiError(res.status === 404 ? 404 : 502, "storage_read_failed", `WebDAV GET failed (${res.status})`);
    return nodeReadableFromWeb(res.body);
  }

  async listKeys(prefix: StoragePrefix) {
    const rootUrl = this.collectionUrl(prefix);
    const rootPath = decodeURIComponent(new URL(rootUrl).pathname).replace(/\/+$/, "");

    // Run a PROPFIND for `url` at the given Depth; [] for a 404. Depth "infinity" lists the
    // whole subtree in one request, Depth "1" only the immediate children.
    const propfind = async (url: string, depth: "1" | "infinity") => {
      const res = await fetch(url, { method: "PROPFIND", headers: { ...this.auth(), Depth: depth, "Content-Type": "application/xml" }, body: PROPFIND_BODY });
      if (res.status === 404) return [];
      if (!res.ok) throw new ApiError(502, "storage_list_failed", `WebDAV PROPFIND failed (${res.status})`);
      return parsePropfind(await res.text(), this.origin);
    };

    // A multistatus entry → its key relative to the prefix root, or null to skip it (the
    // collection itself, any directory, anything outside the prefix, or — for "objects" —
    // a nested reserved prefix that has its own listing).
    const toKey = (entry: { path: string; collection: boolean }) => {
      if (entry.collection || !entry.path.startsWith(`${rootPath}/`)) return null;
      const rel = entry.path.slice(rootPath.length + 1);
      if (!rel) return null;
      if (prefix === "objects" && /^(thumbs|_uploads|trash|link)\//.test(rel)) return null;
      return rel;
    };

    // Fast path: one request for the whole subtree (only on servers that allow it).
    if (this.config.webdav.list_depth_infinity) {
      return (await propfind(rootUrl, "infinity")).map(toKey).filter((key): key is string => key !== null);
    }

    // Portable path: recurse Depth: 1, fanning sibling subdirectories out in parallel so a
    // deep category/theme tree isn't a chain of serial round-trips.
    const keys: string[] = [];
    const walk = async (url: string) => {
      const here = decodeURIComponent(new URL(url).pathname).replace(/\/+$/, "");
      const subdirs: string[] = [];
      for (const entry of await propfind(url, "1")) {
        if (entry.path === here) continue; // the collection itself
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

  // Empty-collection pruning is only wired up for the local backend (the documented case);
  // a write here re-creates parents via MKCOL anyway, so leaving empties is harmless.
  async pruneEmptyDirs(): Promise<number> {
    return 0;
  }
}

// Minimal, namespace-agnostic PROPFIND multistatus parser: returns each response's
// resolved URL, decoded path (no trailing slash), and whether it's a collection.
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
