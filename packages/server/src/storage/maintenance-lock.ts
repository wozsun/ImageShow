import { withAdvisoryLock } from "../core/db.ts";

const storageMaintenanceLockKey = "imageshow:storage-maintenance";

export function withStorageMutationLock<T>(work: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(storageMaintenanceLockKey, work, "shared");
}

/**
 * Object-location mutations may run concurrently for different images, but all
 * writers for one image must serialize. The outer shared lock still excludes
 * whole-storage maintenance such as orphan cleanup.
 */
export function withImageStorageMutationLock<T>(
  imageId: string,
  work: () => Promise<T>
): Promise<T> {
  return withStorageMutationLock(() =>
    withAdvisoryLock(`imageshow:image-storage:${imageId}`, work)
  );
}

export function withStorageMaintenanceLock<T>(work: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(storageMaintenanceLockKey, work);
}
