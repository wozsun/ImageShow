let writerQueueTail: Promise<void> = Promise.resolve();
let queuedOrActiveWriters = 0;
let activeReaders = 0;
let readersDrained: Promise<void> = Promise.resolve();
let resolveReadersDrained: (() => void) | null = null;

export type ReadyImageCacheReadLease<T> = { acquired: true; value: T } | { acquired: false };

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
  if (queuedOrActiveWriters > 0) return { acquired: false };
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
  while (queuedOrActiveWriters > 0) {
    const pendingWriters = writerQueueTail;
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
export async function withReadyImageCacheWriteFence<T>(work: () => Promise<T>): Promise<T> {
  queuedOrActiveWriters += 1;
  const previousWriter = writerQueueTail;
  const { promise, resolve: release } = Promise.withResolvers<void>();
  writerQueueTail = promise;
  await previousWriter;
  try {
    await readersDrained;
    return await work();
  } finally {
    queuedOrActiveWriters -= 1;
    release();
  }
}

export function readyImageCacheReadsAreBlocked() {
  return queuedOrActiveWriters > 0;
}
