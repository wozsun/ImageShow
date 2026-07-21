export async function mapWithConcurrency<T, Result>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<Result>
): Promise<Result[]> {
  const size = Math.max(1, limit);
  const results: Result[] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    results.push(...await Promise.all(items.slice(offset, offset + size).map(task)));
  }
  return results;
}

export async function mapWithWorkerPool<T, Result>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<Result>,
  options: { signal?: AbortSignal } = {}
): Promise<Result[]> {
  if (items.length === 0) return [];

  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.floor(limit))
    : 1;
  const workerCount = Math.min(
    items.length,
    normalizedLimit
  );
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  let stopped = false;
  let firstError: unknown;

  const worker = async () => {
    for (;;) {
      if (stopped) return;

      try {
        options.signal?.throwIfAborted();
      } catch (error) {
        if (!stopped) {
          stopped = true;
          firstError = error;
        }
        return;
      }

      const index = nextIndex;
      if (index >= items.length) return;
      nextIndex += 1;

      try {
        results[index] = await task(items[index], index);
      } catch (error) {
        if (!stopped) {
          stopped = true;
          firstError = error;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: workerCount }, worker));
  if (stopped) {
    throw firstError;
  }
  return results;
}

type DynamicConcurrencyHooks = {
  onQueued?: () => void;
  onStarted?: () => void;
};

type DynamicConcurrencyQueueEntry = {
  signal: AbortSignal;
  abort: () => void;
  run: () => void;
};

export class DynamicConcurrencyLimiter {
  private active = 0;
  private queue: DynamicConcurrencyQueueEntry[] = [];
  private readonly limit: () => number;
  private readonly cancellationError: (signal: AbortSignal) => unknown;

  constructor(
    limit: () => number,
    cancellationError: (signal: AbortSignal) => unknown
  ) {
    this.limit = limit;
    this.cancellationError = cancellationError;
  }

  async run<Result>(
    signal: AbortSignal,
    work: () => Promise<Result>,
    hooks: DynamicConcurrencyHooks = {}
  ): Promise<Result> {
    await this.acquire(signal, hooks.onQueued);
    try {
      hooks.onStarted?.();
      return await work();
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.drain();
    }
  }

  private acquire(signal: AbortSignal, onQueued?: () => void) {
    if (signal.aborted) throw this.cancellationError(signal);
    if (this.active < this.currentLimit()) {
      this.active += 1;
      return Promise.resolve();
    }

    onQueued?.();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const entry: DynamicConcurrencyQueueEntry = {
        signal,
        abort: () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", entry.abort);
          this.queue = this.queue.filter((item) => item !== entry);
          reject(this.cancellationError(signal));
          this.drain();
        },
        run: () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", entry.abort);
          this.active += 1;
          resolve();
        }
      };
      this.queue.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
      if (signal.aborted) entry.abort();
    });
  }

  private currentLimit() {
    const configured = this.limit();
    return Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured))
      : 1;
  }

  private drain() {
    while (this.active < this.currentLimit()) {
      const next = this.queue.shift();
      if (!next) return;
      if (next.signal.aborted) {
        next.abort();
        continue;
      }
      next.run();
    }
  }
}

type DynamicWeightedQueueEntry = {
  signal: AbortSignal;
  requestedWeight: number;
  abort: () => void;
  run: (weight: number) => void;
};

/**
 * FIFO limiter for memory/bandwidth-sensitive work. An item larger than the
 * current budget may run alone, so a valid large import can never deadlock the
 * queue merely because the administrator lowered the dynamic limit.
 */
export class DynamicWeightedLimiter {
  private activeWeight = 0;
  private queue: DynamicWeightedQueueEntry[] = [];
  private readonly limit: () => number;
  private readonly cancellationError: (signal: AbortSignal) => unknown;

  constructor(
    limit: () => number,
    cancellationError: (signal: AbortSignal) => unknown
  ) {
    this.limit = limit;
    this.cancellationError = cancellationError;
  }

  async run<Result>(
    requestedWeight: number,
    signal: AbortSignal,
    work: () => Promise<Result>,
    hooks: DynamicConcurrencyHooks = {}
  ): Promise<Result> {
    const acquiredWeight = await this.acquire(
      requestedWeight,
      signal,
      hooks.onQueued
    );
    try {
      hooks.onStarted?.();
      return await work();
    } finally {
      this.activeWeight = Math.max(0, this.activeWeight - acquiredWeight);
      this.drain();
    }
  }

  private acquire(
    requestedWeight: number,
    signal: AbortSignal,
    onQueued?: () => void
  ): Promise<number> {
    if (signal.aborted) throw this.cancellationError(signal);
    const weight = this.currentWeight(requestedWeight);
    if (!this.queue.length && this.activeWeight + weight <= this.currentLimit()) {
      this.activeWeight += weight;
      return Promise.resolve(weight);
    }

    onQueued?.();
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const entry: DynamicWeightedQueueEntry = {
        signal,
        requestedWeight,
        abort: () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", entry.abort);
          this.queue = this.queue.filter((item) => item !== entry);
          reject(this.cancellationError(signal));
          this.drain();
        },
        run: (acquiredWeight) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", entry.abort);
          this.activeWeight += acquiredWeight;
          resolve(acquiredWeight);
        }
      };
      this.queue.push(entry);
      signal.addEventListener("abort", entry.abort, { once: true });
      if (signal.aborted) entry.abort();
    });
  }

  private currentLimit() {
    const configured = this.limit();
    return Number.isFinite(configured)
      ? Math.max(1, Math.floor(configured))
      : 1;
  }

  private currentWeight(requestedWeight: number) {
    const normalized = Number.isFinite(requestedWeight)
      ? Math.max(1, Math.floor(requestedWeight))
      : 1;
    return Math.min(normalized, this.currentLimit());
  }

  private drain() {
    for (;;) {
      const next = this.queue[0];
      if (!next) return;
      if (next.signal.aborted) {
        this.queue.shift();
        next.abort();
        continue;
      }
      const weight = this.currentWeight(next.requestedWeight);
      if (this.activeWeight + weight > this.currentLimit()) return;
      this.queue.shift();
      next.run(weight);
    }
  }
}
