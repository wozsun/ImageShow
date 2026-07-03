import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile, access } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { env } from "../config/env.js";
import { isReservedRootKey, NAMESPACED_PREFIXES, safeStoragePath, STORAGE_PREFIXES, type ReadablePrefix, type StoragePrefix } from "./object-keys.js";
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

      await copyFile(source, target);
      await rm(source, { force: true }).catch(() => undefined);
    }
  }

  async copy(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string) {
    const target = safeStoragePath(toPrefix, toKey);
    await mkdir(dirname(target), { recursive: true });

    await copyFile(safeStoragePath(fromPrefix, fromKey), target);
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
        if (prefix === "objects" && dir === root && entry.isDirectory() && (STORAGE_PREFIXES as readonly string[]).includes(entry.name)) continue;
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else {
          const key = relative(root, path).split(sep).join("/");
          if (prefix === "objects" && isReservedRootKey(key)) continue;
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
    await mkdir(join(env.STORAGE_DIR, "_uploads"), { recursive: true });
    const path = safeStoragePath("_uploads", ".storage-test");
    await writeFile(path, "ok");
    await rm(path, { force: true });
    return { backend: "local", writable: true, storage_dir: env.STORAGE_DIR };
  }

  async pruneEmptyDirs(): Promise<number> {
    const root = env.STORAGE_DIR;
    const protectedDirs = new Set(NAMESPACED_PREFIXES.map((name) => join(root, name)));
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
