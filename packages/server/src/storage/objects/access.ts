import { ApiError } from "../../core/api-error.ts";
import {
  getStorageBackend,
  resolveStorageAccess
} from "../backends/registry.ts";
import type {
  PublicDatabaseReadAccess
} from "../../core/database/public-fallback.ts";
import type {
  OpenedRead,
  StoragePruneOptions,
  StorageRemovalResult,
  StorageRemoveOptions,
  StorageRequestOptions
} from "../drivers/driver.ts";
import type {
  ReadablePrefix,
  StoragePrefix
} from "./keys.ts";
import { STORAGE_PREFIXES } from "./keys.ts";
import { directStorageObjectUrl } from "./public-urls.ts";
import {
  collectStorageKeyListing,
  type StorageKeyListOptions
} from "./key-listing.ts";
import {
  withStorageObjectRemovalAdmission
} from "./removal-admission.ts";

const neverAbortedStorageRemovalSignal = new AbortController().signal;

export async function storageObjectExists(
  prefix: StoragePrefix,
  key: string,
  slug?: string,
  options?: StorageRequestOptions
) {
  return (await resolveStorageAccess(slug)).driver.exists(prefix, key, options);
}

export async function readStorageBuffer(
  prefix: StoragePrefix,
  key: string,
  slug?: string,
  options?: StorageRequestOptions
) {
  return (await resolveStorageAccess(slug)).driver.readBuffer(prefix, key, options);
}

export async function writeStorageBuffer(
  prefix: StoragePrefix,
  key: string,
  body: Buffer,
  contentType: string,
  slug?: string,
  options?: StorageRequestOptions
) {
  return (await resolveStorageAccess(slug)).driver.writeBuffer(
    prefix,
    key,
    body,
    contentType,
    options
  );
}

export type StorageRemovalRequest = Readonly<{
  prefix: StoragePrefix;
  key: string;
  storageSlug?: string;
}>;

export type ResolvedStorageRemovalResult = StorageRemovalResult & {
  storageSlug: string;
};

/**
 * Resolve one or more objects by security context, then execute one driver
 * call per shared physical client. N=1 uses this same path. A distinct
 * admission signal lets a caller cancel queued work without interrupting an
 * operation that already owns a higher-level maintenance lock.
 */
export async function removeStorageObjectsAndConfirm(
  objects: readonly StorageRemovalRequest[],
  options: StorageRemoveOptions = {},
  admissionSignal: AbortSignal = options.signal
    ?? neverAbortedStorageRemovalSignal
): Promise<ResolvedStorageRemovalResult[]> {
  if (!objects.length) {
    throw new RangeError("Storage cleanup requires at least one object");
  }
  const operationSignal = options.signal ?? neverAbortedStorageRemovalSignal;
  operationSignal.throwIfAborted();
  admissionSignal.throwIfAborted();
  const resolved = await Promise.all(objects.map(async (object, index) => ({
    index,
    object,
    access: await resolveStorageAccess(object.storageSlug)
  })));
  operationSignal.throwIfAborted();
  admissionSignal.throwIfAborted();

  type RemovalGroup = {
    driver: (typeof resolved)[number]["access"]["driver"];
    entries: typeof resolved;
  };
  const groupsByDriver = new Map<RemovalGroup["driver"], RemovalGroup>();
  for (const entry of resolved) {
    const group = groupsByDriver.getOrInsertComputed(
      entry.access.driver,
      (driver) => ({ driver, entries: [] })
    );
    group.entries.push(entry);
  }

  const ordered = new Array<ResolvedStorageRemovalResult>(objects.length);
  // Hand groups to the shared cleanup admission one at a time. Enqueuing
  // an arbitrary local window here would let one multi-backend caller reserve
  // several FIFO positions ahead of unrelated cleanup producers.
  for (const group of groupsByDriver.values()) {
    const results = await withStorageObjectRemovalAdmission(
      admissionSignal,
      () => {
        operationSignal.throwIfAborted();
        return group.driver.removeObjects(
          group.entries.map(({ object }) => ({
            prefix: object.prefix,
            key: object.key
          })),
          options
        );
      }
    );
    if (results.length !== group.entries.length) {
      throw new ApiError(
        502,
        "storage_delete_response_invalid",
        "存储后端返回了不完整的逐对象删除结果"
      );
    }
    for (const [resultIndex, result] of results.entries()) {
      const entry = group.entries[resultIndex]!;
      ordered[entry.index] = {
        ...result,
        prefix: entry.object.prefix,
        key: entry.object.key,
        storageSlug: entry.access.config.slug
      } as ResolvedStorageRemovalResult;
    }
  }
  operationSignal.throwIfAborted();

  return ordered;
}

export function assertStorageRemovalResults(
  results: readonly ResolvedStorageRemovalResult[],
  message = "一个或多个存储对象未能确认删除"
) {
  const incomplete = results.filter((result) => (
    result.status === "failed" || result.status === "unknown"
  ));
  if (incomplete.length) {
    throw new ApiError(
      502,
      "storage_delete_incomplete",
      message,
      {
        failed: incomplete.length,
        objects: incomplete.map((result) => ({
          backend: result.storageSlug,
          prefix: result.prefix,
          key: result.key,
          outcome: result.status,
          code: result.error.code,
          message: result.error.message
        }))
      }
    );
  }
}

export async function collectStorageKeys(
  prefix: StoragePrefix,
  slug?: string,
  options?: StorageKeyListOptions
) {
  const { driver } = await resolveStorageAccess(slug);
  return collectStorageKeyListing(driver.listKeys(prefix, options));
}

/** Collect every current namespace through one driver and cancel sibling scans on failure. */
export async function collectStorageNamespaceSnapshot(
  slug: string,
  options: StorageKeyListOptions = {}
) {
  const { driver } = await resolveStorageAccess(slug);
  const siblingAbort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, siblingAbort.signal])
    : siblingAbort.signal;
  const tasks = STORAGE_PREFIXES.map((prefix) => collectStorageKeyListing(
    driver.listKeys(prefix, { ...options, signal })
  ));
  try {
    const [full, thumbs, uploads] = await Promise.all(tasks);
    return { full, thumbs, _uploads: uploads };
  } catch (error) {
    siblingAbort.abort(error);
    await Promise.allSettled(tasks);
    options.signal?.throwIfAborted();
    throw error;
  }
}

export async function pruneEmptyStorageDirs(
  slug?: string,
  options?: StoragePruneOptions
) {
  return (await resolveStorageAccess(slug)).driver.pruneEmptyDirs(options);
}

export type ResolvedReadableObject = {
  prefix: ReadablePrefix;
  key: string;
  storageSlug: string;
  publicUrl: string;
  exists: (options?: StorageRequestOptions) => Promise<boolean>;
  open: (
    range?: string,
    options?: StorageRequestOptions
  ) => Promise<OpenedRead>;
};

export async function resolveReadableObject(
  prefix: ReadablePrefix,
  key: string,
  slug: string,
  database: PublicDatabaseReadAccess = {}
): Promise<ResolvedReadableObject> {
  const config = await getStorageBackend(slug, database);
  return {
    prefix,
    key,
    storageSlug: config.slug,
    publicUrl: directStorageObjectUrl(config, prefix, key),
    exists: async (options) => (
      (await resolveStorageAccess(slug, database)).driver.exists(prefix, key, options)
    ),
    open: async (range, options) => (
      (await resolveStorageAccess(slug, database)).driver.openRead(
        prefix,
        key,
        range,
        options
      )
    )
  };
}
