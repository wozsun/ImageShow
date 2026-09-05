import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, link, mkdir, open, opendir, rm, rmdir, writeFile, access } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { runtimePaths } from "../../config/bootstrap-env.ts";
import { getIngestionMaxFileBytes } from "../../config/app-settings.ts";
import { ApiError } from "../../core/api-error.ts";
import { safeStoragePath, STORAGE_PREFIXES, type StoragePrefix } from "../objects/keys.ts";
import type {
  OpenedRead,
  StorageCopyOptions,
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
    signal?.throwIfAborted();
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
        signal?.throwIfAborted();
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
      throw new AggregateError([publishError, cleanupError], "Local publication and candidate cleanup both failed");
    }
    throw cleanupError;
  }
  if (publishFailed) throw publishError;
}

export class LocalBackend implements StorageDriver {
  async exists(
    prefix: StoragePrefix,
    key: string,
    options: StorageRequestOptions = {}
  ) {
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
    const candidate = `${target}.candidate-${randomUUID()}`;
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
      exists: (object, requestOptions) => this.exists(
        object.prefix,
        object.key,
        requestOptions
      ),
      remove: (items, requestOptions) => mapStorageObjectsBounded(
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

  async copy(
    fromPrefix: StoragePrefix,
    fromKey: string,
    toPrefix: StoragePrefix,
    toKey: string,
    options: StorageCopyOptions = {}
  ) {
    options.signal?.throwIfAborted();
    const target = safeStoragePath(toPrefix, toKey);
    await mkdir(dirname(target), { recursive: true });
    options.signal?.throwIfAborted();
    const candidateToken = options.atomicCandidateToken ?? randomUUID();
    if (
      options.atomicCandidateToken
      && !uuidV7TokenPattern.test(candidateToken)
    ) {
      throw new RangeError("Invalid local atomic candidate token");
    }
    const candidate = `${target}.candidate-${candidateToken.toLowerCase()}`;
    await withLocalCandidate(candidate, async () => {
      await copyFile(safeStoragePath(fromPrefix, fromKey), candidate);
      // Publish only a complete same-directory candidate and never overwrite a
      // target that appeared after the caller's existence check.
      options.signal?.throwIfAborted();
      await link(candidate, target);
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

  async selfTest(options: StorageRequestOptions = {}): Promise<StorageSelfTest> {
    options.signal?.throwIfAborted();
    const key = `.storage-test-${randomUUID()}`;
    let testError: unknown;
    try {
      await this.writeBuffer("_uploads", key, Buffer.from("ok"), "text/plain", options);
      if (!await this.exists("_uploads", key, options)) {
        throw new Error("Local self-test object could not be read back");
      }
    } catch (error) {
      testError = error;
    }
    try {
      // The caller may cancel after publication. Cleanup has its own budget
      // and only owns this probe's unique object, including uncertain writes.
      const [removed] = await this.removeObjects([{ prefix: "_uploads", key }], {
        signal: AbortSignal.timeout(10_000)
      });
      if (removed?.status !== "removed" && removed?.status !== "missing") {
        throw new Error("Local self-test object could not be removed");
      }
    } catch (cleanupError) {
      if (testError) {
        throw new AggregateError([testError, cleanupError], "Local self-test and cleanup both failed");
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
    let removed = 0;
    let visited = 0;
    const prune = async (dir: string): Promise<void> => {
      options.signal?.throwIfAborted();
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
        visited += 1;
        if (visited > configuredLimit) {
          throw new Error(
            `Storage directory prune exceeds bounded entry limit ${configuredLimit}`
          );
        }
        if (entry.isDirectory()) await prune(join(dir, entry.name));
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
