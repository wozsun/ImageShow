// Local-disk storage backend. All paths resolve under env.STORAGE_DIR via
// safeStoragePath; the backend is stateless (no config needed beyond the data dir).
import { createReadStream, createWriteStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile, access } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { env } from "../config/env.js";
import { ApiError } from "../core/http.js";
import { safeStoragePath, type ReadablePrefix, type StoragePrefix } from "./object-keys.js";
import { nodeReadableFromWeb } from "./stream-buffer.js";
import type {
  CopyPrefix,
  MoveFromPrefix,
  MoveToPrefix,
  OpenedRead,
  StorageDriver,
  StorageSelfTest
} from "./storage-backend.js";

export class LocalBackend implements StorageDriver {
  async exists(prefix: StoragePrefix, key: string) {
    try {
      await access(safeStoragePath(prefix, key));
      return true;
    } catch {
      return false;
    }
  }

  async openRead(prefix: StoragePrefix, key: string): Promise<OpenedRead> {
    const path = safeStoragePath(prefix, key);
    const size = (await stat(path)).size;
    return { body: createReadStream(path), size, backend: "local" };
  }

  async readBuffer(prefix: StoragePrefix, key: string) {
    return readFile(safeStoragePath(prefix, key));
  }

  async writeBuffer(prefix: StoragePrefix, key: string, body: Buffer, _type: string) {
    const target = safeStoragePath(prefix, key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }

  async remove(prefix: StoragePrefix, key: string) {
    await rm(safeStoragePath(prefix, key), { force: true });
  }

  async move(fromPrefix: MoveFromPrefix, fromKey: string, toPrefix: MoveToPrefix, toKey: string, _targetContentType?: string) {
    const source = safeStoragePath(fromPrefix, fromKey);
    const target = safeStoragePath(toPrefix, toKey);
    await mkdir(dirname(target), { recursive: true });
    try {
      await rename(source, target);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!["EXDEV", "EBUSY", "EPERM"].includes(code ?? "")) throw error;
      // Windows development and cross-device volumes can make rename unreliable
      // immediately after image inspection. Copy+remove keeps complete idempotent.
      await copyFile(source, target);
      await rm(source, { force: true }).catch(() => undefined);
    }
  }

  async copy(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string) {
    const source = safeStoragePath(fromPrefix, fromKey);
    const target = safeStoragePath(toPrefix, toKey);
    await mkdir(dirname(target), { recursive: true });
    try {
      await copyFile(source, target);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (!["ENOENT", "EXDEV", "EINVAL", "EBUSY", "EPERM"].includes(code ?? "")) throw error;
      // copyFile uses copy_file_range/sendfile, which can fail spuriously on
      // bind-mounted filesystems (e.g. Docker Desktop on Windows) even when the
      // source exists. Fall back to a plain read+write, which they handle reliably.
      await writeFile(target, await readFile(source));
    }
  }

  async writeUploadFromWeb(id: string, body: ReadableStream<Uint8Array>, expectedSize: number) {
    const part = safeStoragePath("_uploads", `${id}.part`);
    const final = safeStoragePath("_uploads", id);
    await mkdir(dirname(final), { recursive: true });
    let total = 0;
    const limiter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > expectedSize) throw new ApiError(400, "upload_too_large", "Upload too large");
        controller.enqueue(chunk);
      }
    });
    await pipeline(nodeReadableFromWeb(body.pipeThrough(limiter)), createWriteStream(part));
    if (total !== expectedSize) throw new ApiError(400, "size_mismatch", "Upload size mismatch", { expected: expectedSize, actual: total });
    await rename(part, final);
  }

  async readObject(prefix: ReadablePrefix, key: string): Promise<Readable> {
    return createReadStream(safeStoragePath(prefix, key));
  }

  async listKeys(prefix: StoragePrefix) {
    const root = prefix === "objects" ? env.STORAGE_DIR : join(env.STORAGE_DIR, prefix);
    const keys: string[] = [];
    async function walk(dir: string) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (prefix === "objects" && dir === root && entry.isDirectory() && ["objects", "thumbs", "_uploads", "trash", "link"].includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else {
          const key = relative(root, path).split(sep).join("/");
          if (prefix === "objects" && /^(thumbs|_uploads|trash|objects|link)\//.test(key)) continue;
          keys.push(key);
        }
      }
    }
    await walk(root);
    return keys;
  }

  publicObjectUrl(_prefix: ReadablePrefix, _key: string) {
    // Local objects are not directly addressable; the caller falls back to the
    // cookie-isolated static.<domain> host (see publicImageUrls).
    return "";
  }

  async selfTest(): Promise<StorageSelfTest> {
    await mkdir(join(env.STORAGE_DIR, "_uploads"), { recursive: true });
    const path = safeStoragePath("_uploads", ".storage-test");
    await writeFile(path, "ok");
    await rm(path, { force: true });
    return { backend: "local", writable: true, storage_dir: env.STORAGE_DIR };
  }

  // Depth-first prune: recurse into every subtree, then rmdir each directory that ended up
  // empty. The storage root and the top-level prefix dirs (thumbs/trash/link/_uploads,
  // maintained by ensureStorage) are never removed; rmdir only succeeds on an empty dir, so
  // a concurrent write that just repopulated one is harmless (ENOTEMPTY is swallowed).
  async pruneEmptyDirs(): Promise<number> {
    const root = env.STORAGE_DIR;
    const protectedDirs = new Set(["thumbs", "trash", "link", "_uploads"].map((name) => join(root, name)));
    let removed = 0;
    const prune = async (dir: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory()) await prune(join(dir, entry.name));
      }
      if (dir === root || protectedDirs.has(dir)) return;
      await rmdir(dir).then(() => { removed += 1; }).catch(() => undefined);
    };
    const top = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of top) {
      if (entry.isDirectory()) await prune(join(root, entry.name));
    }
    return removed;
  }
}
