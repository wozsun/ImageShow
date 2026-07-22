import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";
import {
  tryWithAdvisoryLocksOnClient,
  tryWithAdvisoryLocks,
  withAdvisoryLock,
  withAdvisoryLocks,
  withAdvisoryLocksOnClient,
  type AdvisoryLockAttempt,
  type AdvisoryLockRequest
} from "../core/db.ts";

const storageLocationLockKey = "imageshow:storage-location";
type StorageLocationLockContext = {
  mode: "read" | "write";
  signal: AbortSignal;
  lockClient: PoolClient;
  additionalLockActive: boolean;
  additionalLockQueue: { tail: Promise<void> };
};
type StorageLockWork<T> = (
  signal: AbortSignal,
  lockClient: PoolClient
) => Promise<T>;
const storageLocationLockContext = new AsyncLocalStorage<StorageLocationLockContext>();

function storageLocationContext(
  mode: "read" | "write",
  signal: AbortSignal,
  lockClient: PoolClient,
  additionalLockActive: boolean
): StorageLocationLockContext {
  return {
    mode,
    signal,
    lockClient,
    additionalLockActive,
    additionalLockQueue: { tail: Promise.resolve() }
  };
}

async function queueAdditionalLockWork<T>(
  held: StorageLocationLockContext,
  work: () => Promise<T>
) {
  if (held.additionalLockActive) {
    throw new Error("Cannot nest combined storage advisory locks");
  }
  const previous = held.additionalLockQueue.tail;
  let releaseTurn!: () => void;
  held.additionalLockQueue.tail = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  await previous;
  try {
    held.signal.throwIfAborted();
    return await work();
  } finally {
    releaseTurn();
  }
}

function additionalLockContext(held: StorageLocationLockContext) {
  return {
    ...held,
    additionalLockActive: true
  };
}

/**
 * Hold a shared lease while code resolves a storage slug and reads or mutates
 * objects at that physical location. Shared leases are re-entrant so import
 * helpers can enforce the boundary themselves without consuming another pool
 * connection when their caller already owns it.
 */
export function withStorageLocationReadLock<T>(work: StorageLockWork<T>): Promise<T> {
  const held = storageLocationLockContext.getStore();
  if (held) {
    held.signal.throwIfAborted();
    return work(held.signal, held.lockClient);
  }
  return withAdvisoryLock(
    storageLocationLockKey,
    (signal, lockClient) => storageLocationLockContext.run(
      storageLocationContext("read", signal, lockClient, false),
      () => work(signal, lockClient)
    ),
    "shared"
  );
}

export function withStorageLocationReadAndAdvisoryLock<T>(
  key: string,
  work: StorageLockWork<T>
): Promise<T> {
  return withStorageLocationReadAndAdvisoryLocks([{ key }], work);
}

export function withStorageLocationReadAndAdvisoryLocks<T>(
  locks: readonly Omit<AdvisoryLockRequest, "acquisition">[],
  work: StorageLockWork<T>
): Promise<T> {
  const held = storageLocationLockContext.getStore();
  if (held) {
    held.signal.throwIfAborted();
    return queueAdditionalLockWork(held, () => withAdvisoryLocksOnClient(
      held.lockClient,
      held.signal,
      locks,
      (signal, lockClient) => storageLocationLockContext.run(
        additionalLockContext(held),
        () => work(signal, lockClient)
      )
    ));
  }
  return withAdvisoryLocks(
    [
      { key: storageLocationLockKey, mode: "shared" },
      ...locks
    ],
    (signal, lockClient) => storageLocationLockContext.run(
      storageLocationContext("read", signal, lockClient, true),
      () => work(signal, lockClient)
    )
  );
}

export function tryWithStorageLocationReadAndAdvisoryLocks<T>(
  locks: readonly AdvisoryLockRequest[],
  work: StorageLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  const held = storageLocationLockContext.getStore();
  if (held) {
    held.signal.throwIfAborted();
    return queueAdditionalLockWork(held, () => tryWithAdvisoryLocksOnClient(
      held.lockClient,
      held.signal,
      locks,
      (signal, lockClient) => storageLocationLockContext.run(
        additionalLockContext(held),
        () => work(signal, lockClient)
      )
    ));
  }
  return tryWithAdvisoryLocks(
    [
      { key: storageLocationLockKey, mode: "shared" },
      ...locks
    ],
    (signal, lockClient) => storageLocationLockContext.run(
      storageLocationContext("read", signal, lockClient, true),
      () => work(signal, lockClient)
    )
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
  work: StorageLockWork<T>
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
export function withStorageLocationWriteLock<T>(work: StorageLockWork<T>): Promise<T> {
  const held = storageLocationLockContext.getStore();
  if (held?.mode === "write") {
    held.signal.throwIfAborted();
    return work(held.signal, held.lockClient);
  }
  if (held?.mode === "read") {
    throw new Error("Cannot upgrade a storage location read lock to a write lock");
  }
  return withAdvisoryLock(
    storageLocationLockKey,
    (signal, lockClient) => storageLocationLockContext.run(
      storageLocationContext("write", signal, lockClient, false),
      () => work(signal, lockClient)
    )
  );
}

export function withStorageLocationWriteAndAdvisoryLock<T>(
  key: string,
  work: StorageLockWork<T>
): Promise<T> {
  const held = storageLocationLockContext.getStore();
  if (held?.mode === "read") {
    throw new Error("Cannot upgrade a storage location read lock to a write lock");
  }
  if (held?.mode === "write") {
    held.signal.throwIfAborted();
    return queueAdditionalLockWork(held, () => withAdvisoryLocksOnClient(
      held.lockClient,
      held.signal,
      [{ key }],
      (signal, lockClient) => storageLocationLockContext.run(
        additionalLockContext(held),
        () => work(signal, lockClient)
      )
    ));
  }
  return withAdvisoryLocks(
    [
      { key: storageLocationLockKey },
      { key }
    ],
    (signal, lockClient) => storageLocationLockContext.run(
      storageLocationContext("write", signal, lockClient, true),
      () => work(signal, lockClient)
    )
  );
}
