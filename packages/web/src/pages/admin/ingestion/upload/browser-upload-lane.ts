type BrowserUploadWaiter = {
  signal: AbortSignal;
  abort: () => void;
  start: () => void;
};

function normalizedLimit(value: number) {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

function abortError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException("The operation was aborted", "AbortError");
}

/**
 * Preserve one selected batch's preview -> credential -> raw handoff before a
 * later selection can enqueue previews. This owns ordering only; capacity is
 * still owned exclusively by BrowserUploadLane.
 */
export class BrowserUploadBatchSequencer {
  #tail: Promise<void> = Promise.resolve();

  run<Result>(work: () => Promise<Result>): Promise<Result> {
    const operation = this.#tail.then(work, work);
    this.#tail = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
}

/** One FIFO owner for preview, credential and raw-transfer work in a page. */
export class BrowserUploadLane {
  #active = 0;
  #limit: number;
  #queue: BrowserUploadWaiter[] = [];

  constructor(limit: number) {
    this.#limit = normalizedLimit(limit);
  }

  setLimit(limit: number) {
    this.#limit = normalizedLimit(limit);
    this.#drain();
  }

  get limit() {
    return this.#limit;
  }

  async run<Result>(
    signal: AbortSignal,
    work: () => Promise<Result>
  ): Promise<Result> {
    await this.#acquire(signal);
    try {
      if (signal.aborted) throw abortError(signal);
      return await work();
    } finally {
      this.#active = Math.max(0, this.#active - 1);
      this.#drain();
    }
  }

  #acquire(signal: AbortSignal) {
    if (signal.aborted) throw abortError(signal);
    if (this.#queue.length === 0 && this.#active < this.#limit) {
      this.#active += 1;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const waiter: BrowserUploadWaiter = {
        signal,
        abort: () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", waiter.abort);
          this.#queue = this.#queue.filter((item) => item !== waiter);
          reject(abortError(signal));
          this.#drain();
        },
        start: () => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", waiter.abort);
          this.#active += 1;
          resolve();
        }
      };
      this.#queue.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }

  #drain() {
    while (this.#active < this.#limit) {
      const next = this.#queue.shift();
      if (!next) return;
      if (next.signal.aborted) {
        next.abort();
        continue;
      }
      next.start();
    }
  }
}
