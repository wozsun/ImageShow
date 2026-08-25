import {
  DynamicConcurrencyLimiter,
  DynamicWeightedLimiter
} from "../../core/concurrency.ts";
export type ImportWorkerStagePoolLimits = Readonly<{
  download: () => number;
  prepare: () => number;
  commit: () => number;
  commitBytes: () => number;
}>;

/**
 * Keeps slow remote reads, CPU-heavy preparation and irreversible commits in
 * independent bounded lanes. Commit work must hold both its item permit and
 * its prepared-byte permit for the whole callback.
 */
export class ImportWorkerStagePools {
  readonly #download: DynamicConcurrencyLimiter;
  readonly #prepare: DynamicConcurrencyLimiter;
  readonly #commit: DynamicConcurrencyLimiter;
  readonly #commitBytes: DynamicWeightedLimiter;

  constructor(
    limits: ImportWorkerStagePoolLimits,
    cancellationError: (signal: AbortSignal) => unknown
  ) {
    this.#download = new DynamicConcurrencyLimiter(
      limits.download,
      cancellationError
    );
    this.#prepare = new DynamicConcurrencyLimiter(
      limits.prepare,
      cancellationError
    );
    this.#commit = new DynamicConcurrencyLimiter(
      limits.commit,
      cancellationError
    );
    this.#commitBytes = new DynamicWeightedLimiter(
      limits.commitBytes,
      cancellationError
    );
  }

  download<T>(signal: AbortSignal, work: () => Promise<T>) {
    return this.#download.run(signal, work);
  }

  prepare<T>(
    signal: AbortSignal,
    work: () => Promise<T>
  ) {
    return this.#prepare.run(signal, work);
  }

  commit<T>(
    bytes: number,
    signal: AbortSignal,
    work: () => Promise<T>
  ) {
    return this.#commit.run(signal, () => this.#commitBytes.run(
      bytes,
      signal,
      work
    ));
  }
}
