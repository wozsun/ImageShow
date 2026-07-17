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
