import { copyFile, mkdir, open, readFile, readdir, rm, rmdir, writeFile, access } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";
import { ApiError } from "../core/api-error.ts";
import { safeStoragePath, STORAGE_PREFIXES, type ReadablePrefix, type StoragePrefix } from "./object-keys.ts";
import type {
  CopyPrefix,
  OpenedRead,
  StorageDriver,
  StorageSelfTest
} from "./driver.ts";
import { parseSingleByteRange } from "../core/http/byte-range.ts";
import { localObjectEtag } from "./object-validator.ts";
import { isMissingFileError } from "./not-found.ts";

export class LocalBackend implements StorageDriver {
  async exists(prefix: StoragePrefix, key: string) {
    try {
      await access(safeStoragePath(prefix, key));
      return true;
    } catch (error) {
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

  async openRead(prefix: StoragePrefix, key: string, rangeHeader?: string): Promise<OpenedRead> {
    const path = safeStoragePath(prefix, key);
    const handle = await open(path, "r").catch((error: unknown) => {
      if (isMissingFileError(error)) throw new ApiError(404, "storage_object_not_found", "Object not found");
      throw error;
    });
    try {
      const stats = await handle.stat({ bigint: true });
      const totalSize = Number(stats.size);
      if (!Number.isSafeInteger(totalSize) || totalSize < 0) {
        throw new ApiError(502, "storage_read_failed", "Object size is not supported");
      }
      const range = parseSingleByteRange(rangeHeader, totalSize);
      const common = {
        totalSize,
        etag: localObjectEtag(stats),
        lastModified: new Date(Number(stats.mtimeMs)).toUTCString(),
        backend: "local" as const
      };
      if (!range) return { body: handle.createReadStream(), size: totalSize, ...common };
      const size = range.end - range.start + 1;
      return {
        body: handle.createReadStream(range),
        size,
        contentRange: `bytes ${range.start}-${range.end}/${totalSize}`,
        ...common
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
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

  async copy(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string) {
    const target = safeStoragePath(toPrefix, toKey);
    await mkdir(dirname(target), { recursive: true });

    await copyFile(safeStoragePath(fromPrefix, fromKey), target);
  }

  async listKeys(prefix: StoragePrefix) {
    const root = join(runtimePaths.storageDirectory, prefix);
    const keys: string[] = [];
    async function walk(dir: string) {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else {
          const key = relative(root, path).split(sep).join("/");
          keys.push(key);
        }
      }
    }
    await walk(root);
    return keys;
  }

  publicObjectUrl(_prefix: ReadablePrefix, _key: string) {

    return "";
  }

  async selfTest(): Promise<StorageSelfTest> {
    await mkdir(join(runtimePaths.storageDirectory, "_uploads"), { recursive: true });
    const path = safeStoragePath("_uploads", ".storage-test");
    await writeFile(path, "ok");
    await rm(path, { force: true });
    return { backend: "local", writable: true, storage_dir: runtimePaths.storageDirectory };
  }

  async pruneEmptyDirs(): Promise<number> {
    const root = runtimePaths.storageDirectory;
    const protectedDirs = new Set(STORAGE_PREFIXES.map((name) => join(root, name)));
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
