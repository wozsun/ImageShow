import { ApiError, errorMessage } from "../core/api-error.ts";
import { resolveStorageAccess } from "./backend-registry.ts";
import type { OpenedRead } from "./driver.ts";
import type {
  ReadablePrefix,
  StoragePrefix
} from "./object-keys.ts";

export async function storageObjectExists(
  prefix: StoragePrefix,
  key: string,
  slug?: string
) {
  return (await resolveStorageAccess(slug)).driver.exists(prefix, key);
}

export async function readStorageBuffer(
  prefix: StoragePrefix,
  key: string,
  slug?: string
) {
  return (await resolveStorageAccess(slug)).driver.readBuffer(prefix, key);
}

export async function writeStorageBuffer(
  prefix: StoragePrefix,
  key: string,
  body: Buffer,
  contentType: string,
  slug?: string
) {
  return (await resolveStorageAccess(slug)).driver.writeBuffer(
    prefix,
    key,
    body,
    contentType
  );
}

export async function removeStorageObjectAndConfirm(
  prefix: StoragePrefix,
  key: string,
  slug?: string
) {
  const { config, driver } = await resolveStorageAccess(slug);
  const existed = await driver.exists(prefix, key);
  // DELETE is idempotent for every driver. Issue it even after a negative
  // preflight so a stale or faulty existence response cannot make cleanup
  // terminal while the object is still present.
  await driver.remove(prefix, key);
  let stillExists: boolean;
  try {
    stillExists = await driver.exists(prefix, key);
  } catch (error) {
    throw new ApiError(
      502,
      "storage_delete_confirmation_failed",
      "存储对象删除后无法确认最终状态",
      {
        backend: config.slug,
        prefix,
        key,
        reason: errorMessage(error)
      }
    );
  }
  if (stillExists) {
    throw new ApiError(
      502,
      "storage_delete_incomplete",
      "存储后端返回删除成功，但对象仍然存在",
      { backend: config.slug, prefix, key }
    );
  }
  return existed ? "removed" as const : "missing" as const;
}

export async function listStorageKeys(
  prefix: StoragePrefix,
  slug?: string
) {
  return (await resolveStorageAccess(slug)).driver.listKeys(prefix);
}

export async function pruneEmptyStorageDirs(slug?: string) {
  return (await resolveStorageAccess(slug)).driver.pruneEmptyDirs();
}

export type ResolvedReadableObject = {
  prefix: ReadablePrefix;
  key: string;
  storageSlug: string;
  publicUrl: string;
  exists: () => Promise<boolean>;
  open: (range?: string) => Promise<OpenedRead>;
};

export async function resolveReadableObject(
  prefix: ReadablePrefix,
  key: string,
  slug?: string
): Promise<ResolvedReadableObject> {
  const { config, driver } = await resolveStorageAccess(slug);
  return {
    prefix,
    key,
    storageSlug: config.slug,
    publicUrl: driver.publicObjectUrl(prefix, key),
    exists: () => driver.exists(prefix, key),
    open: (range) => driver.openRead(prefix, key, range)
  };
}
