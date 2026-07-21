import { AsyncLocalStorage } from "node:async_hooks";
import {
  tryWithAdvisoryLocks,
  withAdvisoryLock,
  withAdvisoryLocks,
  type AdvisoryLockAttempt,
  type AdvisoryLockRequest
} from "../core/db.ts";

const storageLocationLockKey = "imageshow:storage-location";
const storageLocationLockContext = new AsyncLocalStorage<"read" | "write">();

/**
 * Hold a shared lease while code resolves a storage slug and reads or mutates
 * objects at that physical location. Shared leases are re-entrant so import
 * helpers can enforce the boundary themselves without consuming another pool
 * connection when their caller already owns it.
 */
export function withStorageLocationReadLock<T>(work: () => Promise<T>): Promise<T> {
  if (storageLocationLockContext.getStore()) return work();
  return withAdvisoryLock(
    storageLocationLockKey,
    () => storageLocationLockContext.run("read", work),
    "shared"
  );
}

export function withStorageLocationReadAndAdvisoryLock<T>(
  key: string,
  work: () => Promise<T>
): Promise<T> {
  return withStorageLocationReadAndAdvisoryLocks([{ key }], work);
}

export function withStorageLocationReadAndAdvisoryLocks<T>(
  locks: readonly Omit<AdvisoryLockRequest, "acquisition">[],
  work: () => Promise<T>
): Promise<T> {
  if (storageLocationLockContext.getStore()) {
    return withAdvisoryLocks(locks, work);
  }
  return withAdvisoryLocks(
    [
      { key: storageLocationLockKey, mode: "shared" },
      ...locks
    ],
    () => storageLocationLockContext.run("read", work)
  );
}

export function tryWithStorageLocationReadAndAdvisoryLocks<T>(
  locks: readonly AdvisoryLockRequest[],
  work: () => Promise<T>
): Promise<AdvisoryLockAttempt<T>> {
  if (storageLocationLockContext.getStore()) {
    return tryWithAdvisoryLocks(locks, work);
  }
  return tryWithAdvisoryLocks(
    [
      { key: storageLocationLockKey, mode: "shared" },
      ...locks
    ],
    () => storageLocationLockContext.run("read", work)
  );
}

export function imageStorageMutationLockKey(imageId: string) {
  return `imageshow:image-storage:${imageId}`;
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
  return withStorageLocationReadAndAdvisoryLock(
    imageStorageMutationLockKey(imageId),
    work
  );
}

/**
 * Exclusively own every configurable storage location. This is reserved for
 * physical-location changes and whole-storage maintenance. Upgrading a held
 * read lease would deadlock in PostgreSQL, so fail loudly if a caller violates
 * the lock ordering contract.
 */
export function withStorageLocationWriteLock<T>(work: () => Promise<T>): Promise<T> {
  const held = storageLocationLockContext.getStore();
  if (held === "write") return work();
  if (held === "read") {
    throw new Error("Cannot upgrade a storage location read lock to a write lock");
  }
  return withAdvisoryLock(
    storageLocationLockKey,
    () => storageLocationLockContext.run("write", work)
  );
}

export function withStorageLocationWriteAndAdvisoryLock<T>(
  key: string,
  work: () => Promise<T>
): Promise<T> {
  const held = storageLocationLockContext.getStore();
  if (held === "read") {
    throw new Error("Cannot upgrade a storage location read lock to a write lock");
  }
  if (held === "write") return withAdvisoryLock(key, work);
  return withAdvisoryLocks(
    [
      { key: storageLocationLockKey },
      { key }
    ],
    () => storageLocationLockContext.run("write", work)
  );
}
