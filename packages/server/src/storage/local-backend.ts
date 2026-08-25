import { randomUUID } from "node:crypto";
import { copyFile, link, mkdir, open, opendir, rm, rmdir, writeFile, access } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";
import { getInputImageMaxBytes } from "../config/app-settings.ts";
import { ApiError } from "../core/api-error.ts";
import { safeStoragePath, STORAGE_PREFIXES, type StoragePrefix } from "./object-keys.ts";
import type {
  CopyPrefix,
  OpenedRead,
  StorageCopyOptions,
  StorageDriver,
  StoragePruneOptions,
  StorageRequestOptions,
  StorageSelfTest
} from "./driver.ts";
import { parseSingleByteRange } from "../core/http/byte-range.ts";
import { localObjectEtag } from "./object-validator.ts";
import { isMissingFileError } from "./not-found.ts";
import { openedReadToBuffer } from "./stream-buffer.ts";
import {
  batchStorageKeys,
  type StorageKeyListOptions
} from "./key-listing.ts";

const uuidV7TokenPattern = new RegExp(
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}"
    + "-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "iu"
);

async function* walkLocalKeys(
  root: string,
  directoryPath: string,
  signal?: AbortSignal
): AsyncGenerator<string> {
  signal?.throwIfAborted();
  let directory;
  try {
    directory = await opendir(directoryPath, { bufferSize: 64 });
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }

  try {
    while (true) {
      signal?.throwIfAborted();
      let entry;
      try {
        entry = await directory.read();
      } catch (error) {
        if (isMissingFileError(error)) return;
        throw error;
      }
      signal?.throwIfAborted();
      if (!entry) return;
      const path = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        yield* walkLocalKeys(root, path, signal);
      } else {
        yield relative(root, path).split(sep).join("/");
      }
    }
  } finally {
    try {
      await directory.close();
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
}

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

  async openRead(
    prefix: StoragePrefix, key: string, rangeHeader?: string,
    options: StorageRequestOptions = {}
  ): Promise<OpenedRead> {
    options.signal?.throwIfAborted();
    const path = safeStoragePath(prefix, key);
    const handle = await open(path, "r").catch((error: unknown) => {
      options.signal?.throwIfAborted();
      if (isMissingFileError(error)) throw new ApiError(404, "storage_object_not_found", "Object not found");
      throw error;
    });
    try {
      options.signal?.throwIfAborted();
      const stats = await handle.stat({ bigint: true });
      options.signal?.throwIfAborted();
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
      if (!range) {
        return {
          body: handle.createReadStream({
            autoClose: true, emitClose: true, signal: options.signal
          }),
          size: totalSize,
          ...common
        };
      }
      const size = range.end - range.start + 1;
      return {
        body: handle.createReadStream({
          autoClose: true,
          emitClose: true,
          signal: options.signal,
          start: range.start,
          end: range.end
        }),
        size,
        contentRange: `bytes ${range.start}-${range.end}/${totalSize}`,
        ...common
      };
    } catch (error) {
      try {
        await handle.close();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          "Local object read failed and its file handle could not be closed"
        );
      }
      throw error;
    }
  }

  async readBuffer(
    prefix: StoragePrefix, key: string, options: StorageRequestOptions = {}
  ) {
    return openedReadToBuffer(
      await this.openRead(prefix, key, undefined, options),
      getInputImageMaxBytes()
    );
  }

  async writeBuffer(prefix: StoragePrefix, key: string, body: Buffer, _type: string) {
    const target = safeStoragePath(prefix, key);
    await mkdir(dirname(target), { recursive: true });
    const candidate = `${target}.candidate-${randomUUID()}`;
    try {
      await writeFile(candidate, body, { flag: "wx" });
      // Linking a complete same-directory candidate makes publication atomic
      // and refuses to overwrite an object that appeared concurrently.
      await link(candidate, target);
    } finally {
      await rm(candidate, { force: true }).catch(() => undefined);
    }
  }

  async remove(prefix: StoragePrefix, key: string) {
    await rm(safeStoragePath(prefix, key), { force: true });
  }

  async copy(
    fromPrefix: CopyPrefix,
    fromKey: string,
    toPrefix: CopyPrefix,
    toKey: string,
    options: StorageCopyOptions = {}
  ) {
    const target = safeStoragePath(toPrefix, toKey);
    await mkdir(dirname(target), { recursive: true });
    const candidateToken = options.atomicCandidateToken ?? randomUUID();
    if (
      options.atomicCandidateToken
      && !uuidV7TokenPattern.test(candidateToken)
    ) {
      throw new RangeError("Invalid local atomic candidate token");
    }
    const candidate = `${target}.candidate-${candidateToken.toLowerCase()}`;
    try {
      await copyFile(safeStoragePath(fromPrefix, fromKey), candidate);
      // Publish only a complete same-directory candidate and never overwrite a
      // target that appeared after the caller's existence check.
      await link(candidate, target);
    } finally {
      await rm(candidate, { force: true }).catch(() => undefined);
    }
  }

  async *listKeys(
    prefix: StoragePrefix,
    options: StorageKeyListOptions = {}
  ) {
    const root = join(runtimePaths.storageDirectory, prefix);
    return yield* batchStorageKeys(
      walkLocalKeys(root, root, options.signal),
      options
    );
  }

  async selfTest(): Promise<StorageSelfTest> {
    await mkdir(join(runtimePaths.storageDirectory, "_uploads"), { recursive: true });
    const path = safeStoragePath("_uploads", ".storage-test");
    await writeFile(path, "ok");
    await rm(path, { force: true });
    return { backend: "local", writable: true, storage_dir: runtimePaths.storageDirectory };
  }

  async pruneEmptyDirs(options: StoragePruneOptions = {}): Promise<number> {
    const root = runtimePaths.storageDirectory;
    const protectedDirs = new Set(STORAGE_PREFIXES.map((name) => join(root, name)));
    const configuredLimit = options.maxEntries ?? 100_000;
    if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 0) {
      throw new RangeError("Storage directory prune limit must be a non-negative safe integer");
    }
    const start = options.prefix ? join(root, options.prefix) : root;
    let removed = 0;
    let visited = 0;
    const prune = async (dir: string): Promise<void> => {
      options.signal?.throwIfAborted();
      let directory;
      try {
        directory = await opendir(dir, { bufferSize: 64 });
      } catch (error) {
        if (isMissingFileError(error)) return;
        throw error;
      }
      for await (const entry of directory) {
        options.signal?.throwIfAborted();
        visited += 1;
        if (visited > configuredLimit) {
          throw new Error(
            `Storage directory prune exceeds bounded entry limit ${configuredLimit}`
          );
        }
        if (entry.isDirectory()) await prune(join(dir, entry.name));
      }
      if (dir === root || protectedDirs.has(dir)) return;
      try {
        await rmdir(dir);
        removed += 1;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code;
        if (isMissingFileError(error) || code === "ENOTEMPTY" || code === "EEXIST") return;
        throw error;
      }
    };
    await prune(start);
    return removed;
  }
}
