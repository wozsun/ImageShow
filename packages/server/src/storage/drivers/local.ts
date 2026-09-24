import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { link, mkdir, open, opendir, rm, rmdir, writeFile, access } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runtimePaths } from "../../config/bootstrap-env.ts";
import { getIngestionMaxFileBytes } from "../../config/app-settings.ts";
import { ApiError } from "../../core/api-error.ts";
import { safeStoragePath, STORAGE_PREFIXES, type StoragePrefix } from "../objects/keys.ts";
import type {
  OpenedRead,
  StorageDriver,
  StorageObjectReference,
  StoragePruneOptions,
  StorageRemoveOptions,
  StorageRequestOptions,
  StorageServerCopyOptions,
  StorageServerCopySource,
  StorageSelfTest,
  StorageStreamWriteOptions
} from "./driver.ts";
import { parseSingleByteRange } from "../../core/http/byte-range.ts";
import { localObjectEtag } from "../objects/validator.ts";
import { isMissingFileError } from "../objects/not-found.ts";
import { openedReadToBuffer } from "../objects/stream-buffer.ts";
import {
  batchStorageKeys,
  STORAGE_ADMIN_LIST_MAX_KEYS,
  type StorageDirectorySnapshot,
  type StorageKeyListOptions
} from "../objects/key-listing.ts";
import {
  LOCAL_STORAGE_REMOVAL_CONCURRENCY,
  mapStorageObjectsBounded,
  removeDriverObjectsAndConfirm,
  storageRemovalFailure,
  type StorageDeleteAttemptResult
} from "./removal.ts";

const uuidV7TokenPattern = new RegExp(
  "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}" + "-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
  "iu"
);

async function* walkLocalKeys(
  root: string,
  directoryPath: string,
  signal?: AbortSignal,
  snapshot?: StorageDirectorySnapshot
): AsyncGenerator<string> {
  signal?.throwIfAborted();
  let directory;
  try {
    directory = await opendir(directoryPath, { bufferSize: 64 });
  } catch (error) {
    signal?.throwIfAborted();
    if (isMissingFileError(error)) return;
    throw error;
  }

  const entries: Array<string | number> = [];
  try {
    while (true) {
      signal?.throwIfAborted();
      let entry;
      try {
        entry = await directory.read();
      } catch (error) {
        signal?.throwIfAborted();
        if (isMissingFileError(error)) return;
        throw error;
      }
      signal?.throwIfAborted();
      if (!entry) {
        if (snapshot?.complete) snapshot.directories.set(directoryPath, entries);
        return;
      }
      if (snapshot?.complete) {
        snapshot.entries += 1;
        if (snapshot.entries > STORAGE_ADMIN_LIST_MAX_KEYS) {
          snapshot.complete = false;
          snapshot.directories.clear();
          entries.length = 0;
        } else if (entry.isDirectory()) {
          entries.push(entry.name);
        } else {
          const last = entries.at(-1);
          if (typeof last === "number") entries[entries.length - 1] = last + 1;
          else entries.push(1);
        }
      }
      const path = join(directoryPath, entry.name);
      if (entry.isDirectory()) {
        yield* walkLocalKeys(root, path, signal, snapshot);
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

async function withLocalCandidate(candidate: string, publish: () => Promise<void>) {
  let publishFailed = false;
  let publishError: unknown;
  try {
    await publish();
  } catch (error) {
    publishFailed = true;
    publishError = error;
  }
  try {
    await rm(candidate, { force: true });
  } catch (cleanupError) {
    if (publishFailed) {
      throw new AggregateError(
        [publishError, cleanupError],
        "Local publication and candidate cleanup both failed"
      );
    }
    throw cleanupError;
  }
  if (publishFailed) throw publishError;
}

export class LocalBackend implements StorageDriver {
  async exists(prefix: StoragePrefix, key: string, options: StorageRequestOptions = {}) {
    options.signal?.throwIfAborted();
    try {
      await access(safeStoragePath(prefix, key));
      options.signal?.throwIfAborted();
      return true;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (isMissingFileError(error)) return false;
      throw error;
    }
  }

  async openRead(
    prefix: StoragePrefix,
    key: string,
    rangeHeader?: string,
    options: StorageRequestOptions = {}
  ): Promise<OpenedRead> {
    options.signal?.throwIfAborted();
    const path = safeStoragePath(prefix, key);
    const handle = await open(path, "r").catch((error: unknown) => {
      options.signal?.throwIfAborted();
      if (isMissingFileError(error))
        throw new ApiError(404, "storage_object_not_found", "Object not found");
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
            autoClose: true,
            emitClose: true,
            signal: options.signal
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

  async readBuffer(prefix: StoragePrefix, key: string, options: StorageRequestOptions = {}) {
    return openedReadToBuffer(
      await this.openRead(prefix, key, undefined, options),
      getIngestionMaxFileBytes()
    );
  }

  async writeBuffer(
    prefix: StoragePrefix,
    key: string,
    body: Buffer,
    _contentType: string,
    options: StorageRequestOptions = {}
  ) {
    options.signal?.throwIfAborted();
    const target = safeStoragePath(prefix, key);
    await mkdir(dirname(target), { recursive: true });
    options.signal?.throwIfAborted();
    const candidate = `${target}.candidate-${randomUUID()}`;
    await withLocalCandidate(candidate, async () => {
      await writeFile(candidate, body, { flag: "wx", signal: options.signal });
      // Linking a complete same-directory candidate makes publication atomic
      // and refuses to overwrite an object that appeared concurrently.
      options.signal?.throwIfAborted();
      await link(candidate, target);
    });
  }

  async writeStream(
    prefix: StoragePrefix,
    key: string,
    body: Readable,
    size: number,
    _contentType: string,
    options: StorageStreamWriteOptions = {}
  ) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError("Storage stream size must be a non-negative safe integer");
    }
    options.signal?.throwIfAborted();
    const target = safeStoragePath(prefix, key);
    await mkdir(dirname(target), { recursive: true });
    options.signal?.throwIfAborted();
    const candidateToken = options.atomicCandidateToken ?? randomUUID();
    if (options.atomicCandidateToken && !uuidV7TokenPattern.test(candidateToken)) {
      throw new RangeError("Invalid local atomic candidate token");
    }
    const candidate = `${target}.candidate-${candidateToken.toLowerCase()}`;
    const output = createWriteStream(candidate, { flags: "wx" });
    await withLocalCandidate(candidate, async () => {
      await pipeline(body, output, { signal: options.signal });
      if (output.bytesWritten !== size) {
        throw new ApiError(
          502,
          "storage_write_size_mismatch",
          "Storage stream length did not match its declared size"
        );
      }
      options.signal?.throwIfAborted();
      await link(candidate, target);
    });
  }

  async removeObjects(
    objects: readonly StorageObjectReference[],
    options: StorageRemoveOptions = {}
  ) {
    return removeDriverObjectsAndConfirm({
      objects,
      options,
      exists: (object, requestOptions) => this.exists(object.prefix, object.key, requestOptions),
      remove: (items, requestOptions) =>
        mapStorageObjectsBounded(
          items,
          LOCAL_STORAGE_REMOVAL_CONCURRENCY,
          async (object): Promise<StorageDeleteAttemptResult> => {
            if (requestOptions.signal?.aborted) {
              return {
                status: "not_started",
                error: storageRemovalFailure(
                  requestOptions.signal.reason,
                  "storage_delete_cancelled"
                )
              };
            }
            try {
              await rm(safeStoragePath(object.prefix, object.key), {
                force: true
              });
              return { status: "acknowledged" };
            } catch (error) {
              return {
                status: "failed",
                error: storageRemovalFailure(error)
              };
            }
          }
        )
    });
  }

  serverCopySource(
    _prefix: StoragePrefix,
    _key: string,
    _size: number
  ): StorageServerCopySource | undefined {
    return undefined;
  }

  supportsServerCopySource(_source: StorageServerCopySource) {
    return false;
  }

  async copyFromServerSource(
    _source: StorageServerCopySource,
    _toPrefix: StoragePrefix,
    _toKey: string,
    _options: StorageServerCopyOptions
  ): Promise<void> {
    throw new RangeError("Local storage does not support server-side copy");
  }

  async *listKeys(prefix: StoragePrefix, options: StorageKeyListOptions = {}) {
    const root = join(runtimePaths.storageDirectory, prefix);
    return yield* batchStorageKeys(
      walkLocalKeys(root, root, options.signal, options.directorySnapshot),
      options
    );
  }

  async selfTest(options: StorageRequestOptions = {}): Promise<StorageSelfTest> {
    options.signal?.throwIfAborted();
    const key = `.storage-test-${randomUUID()}`;
    let testError: unknown;
    try {
      await this.writeBuffer("full", key, Buffer.from("ok"), "text/plain", options);
      if (!(await this.exists("full", key, options))) {
        throw new Error("Local self-test object could not be read back");
      }
    } catch (error) {
      testError = error;
    }
    try {
      // The caller may cancel after publication. Cleanup has its own budget
      // and only owns this probe's unique object, including uncertain writes.
      const [removed] = await this.removeObjects([{ prefix: "full", key }], {
        signal: AbortSignal.timeout(10_000)
      });
      if (removed?.status !== "removed" && removed?.status !== "missing") {
        throw new Error("Local self-test object could not be removed");
      }
    } catch (cleanupError) {
      if (testError) {
        throw new AggregateError(
          [testError, cleanupError],
          "Local self-test and cleanup both failed"
        );
      }
      throw cleanupError;
    }
    if (testError) throw testError;
    options.signal?.throwIfAborted();
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
    const changedDirectories = new Set<string>();
    for (const object of options.changedObjects ?? []) {
      let dir = dirname(safeStoragePath(object.prefix, object.key));
      for (;;) {
        changedDirectories.add(dir);
        if (dir === root) break;
        dir = dirname(dir);
      }
    }
    const snapshot = options.directorySnapshot?.complete
      ? options.directorySnapshot.directories
      : undefined;
    let removed = 0;
    let visited = 0;
    const visit = (count: number) => {
      visited += count;
      if (visited > configuredLimit) {
        throw new Error(`Storage directory prune exceeds bounded entry limit ${configuredLimit}`);
      }
    };
    const prune = async (dir: string): Promise<void> => {
      options.signal?.throwIfAborted();
      const captured = changedDirectories.has(dir) ? undefined : snapshot?.get(dir);
      if (captured) {
        for (const entry of captured) {
          options.signal?.throwIfAborted();
          visit(typeof entry === "number" ? entry : 1);
          if (typeof entry === "string") await prune(join(dir, entry));
        }
      } else {
        let directory;
        try {
          directory = await opendir(dir, { bufferSize: 64 });
        } catch (error) {
          options.signal?.throwIfAborted();
          if (isMissingFileError(error)) return;
          throw error;
        }
        for await (const entry of directory) {
          options.signal?.throwIfAborted();
          visit(1);
          if (entry.isDirectory()) await prune(join(dir, entry.name));
        }
      }
      if (dir === root || protectedDirs.has(dir)) return;
      options.signal?.throwIfAborted();
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
    options.signal?.throwIfAborted();
    return removed;
  }
}
