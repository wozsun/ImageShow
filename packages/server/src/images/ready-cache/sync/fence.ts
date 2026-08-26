let fenceTail: Promise<void> = Promise.resolve();
let pendingFenceHolders = 0;
let activeReaders = 0;
let readersDrained: Promise<void> = Promise.resolve();
let resolveReadersDrained: (() => void) | null = null;

export type ReadyImageCacheReadLease<T> =
  | { acquired: true; value: T }
  | { acquired: false };

function acquireReadFence() {
  if (activeReaders === 0) {
    readersDrained = new Promise<void>((resolve) => {
      resolveReadersDrained = resolve;
    });
  }
  activeReaders += 1;
}

function releaseReadFence() {
  activeReaders -= 1;
  if (activeReaders === 0) {
    resolveReadersDrained?.();
    resolveReadersDrained = null;
  }
}

async function runWithReadFence<T>(work: () => Promise<T>) {
  acquireReadFence();
  try {
    return await work();
  } finally {
    releaseReadFence();
  }
}

export async function tryWithReadyImageCacheReadFence<T>(
  work: () => Promise<T>
): Promise<ReadyImageCacheReadLease<T>> {
  if (pendingFenceHolders > 0) return { acquired: false };
  return { acquired: true, value: await runWithReadFence(work) };
}

function waitForFenceTurn(promise: Promise<void>, signal?: AbortSignal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new Error("Cache fence wait aborted"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    });
  });
}

/**
 * Waits behind queued writers before taking a read lease. Repair work uses
 * this path so ordinary mutations cannot be mistaken for cache degradation;
 * request reads keep using the non-blocking try variant above.
 */
export async function withReadyImageCacheReadFence<T>(
  work: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  signal?.throwIfAborted();
  while (pendingFenceHolders > 0) {
    const pendingWriters = fenceTail;
    await waitForFenceTurn(pendingWriters, signal);
  }
  signal?.throwIfAborted();
  return runWithReadFence(work);
}

/**
 * Serializes the short publish/sync boundary shared by rebuilds and image
 * mutations. The pending count closes cache reads synchronously, before a
 * mutation can begin its PostgreSQL transaction.
 */
export async function withReadyImageCacheWriteFence<T>(
  work: () => Promise<T>
): Promise<T> {
  pendingFenceHolders += 1;
  const previous = fenceTail;
  let release: () => void = () => undefined;
  fenceTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await readersDrained;
    return await work();
  } finally {
    pendingFenceHolders -= 1;
    release();
  }
}

export function readyImageCacheWriteFenceIsClosed() {
  return pendingFenceHolders > 0;
}
