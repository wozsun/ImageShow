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

export async function removeStorageObject(
  prefix: StoragePrefix,
  key: string,
  slug?: string
) {
  return (await resolveStorageAccess(slug)).driver.remove(prefix, key);
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
