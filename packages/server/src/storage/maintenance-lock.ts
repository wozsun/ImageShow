import { withAdvisoryLock } from "../core/db.ts";

const storageMaintenanceLockKey = "imageshow:storage-maintenance";

export function withStorageMutationLock<T>(work: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(storageMaintenanceLockKey, work, "shared");
}

export function withStorageMaintenanceLock<T>(work: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(storageMaintenanceLockKey, work);
}
