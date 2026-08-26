import { appConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "../../../config/runtime-config-store.ts";
import { errorMessage } from "../../../core/api-error.ts";
import { DynamicConcurrencyLimiter } from "../../../core/concurrency.ts";
import { logger } from "../../../core/logger.ts";

type CleanupWork = () => Promise<void>;

type IngestionRetiredCleanupQueueOptions = Readonly<{
  capacity?: () => number;
  concurrency?: () => number;
  lossy?: boolean;
  maxAttempts?: () => number;
  retryDelayMs?: () => number;
}>;

function waitForRetry(delayMs: number) {
  if (delayMs <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
  });
}

/**
 * Bounds retirement cleanup across requests. The default class contract keeps
 * exact work through admission backpressure and retries. The production
 * disposable instance opts into finite best-effort mode only after formal
 * media/thumb candidates have acquired a persistent move.cleanup guard.
 */
class IngestionRetiredCleanupQueue {
  readonly #signal = new AbortController().signal;
  readonly #capacity: () => number;
  readonly #lossy: boolean;
  readonly #maxAttempts: () => number;
  readonly #retryDelayMs: () => number;
  readonly #limiter: DynamicConcurrencyLimiter;
  readonly #pending = new Set<Promise<void>>();

  constructor(options: IngestionRetiredCleanupQueueOptions = {}) {
    this.#capacity = options.capacity
      ?? (() => appConfig.ingestionRuntime.queueActionBatchSize);
    this.#lossy = options.lossy ?? false;
    this.#maxAttempts = options.maxAttempts
      ?? (() => appConfig.ingestionRuntime.retiredCleanupMaxAttempts);
    this.#retryDelayMs = options.retryDelayMs ?? (() => 1_000);
    this.#limiter = new DynamicConcurrencyLimiter(
      options.concurrency
        ?? (() => getRuntimeConfig().background_job.move_cleanup_concurrency),
      (signal) => signal.reason ?? new Error("Ingestion cleanup queue stopped")
    );
  }

  async #runBounded(work: CleanupWork) {
    const configuredAttempts = this.#maxAttempts();
    const maxAttempts = this.#lossy
      ? Number.isFinite(configuredAttempts)
        ? Math.max(1, Math.floor(configuredAttempts))
        : 1
      : Number.POSITIVE_INFINITY;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await work();
        if (attempt > 1) {
          logger.warn("ingestion_retired_cleanup_backlog_recovered", {
            attempts: attempt
          });
        }
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          logger.warn("ingestion_retired_cleanup_retry_exhausted", {
            attempts: attempt,
            error: errorMessage(error)
          });
          return;
        }
        if (attempt === 1 || (attempt & (attempt - 1)) === 0) {
          logger.warn("ingestion_retired_cleanup_deferred", {
            attempts: attempt,
            error: errorMessage(error)
          });
        }
        const configuredDelay = this.#retryDelayMs();
        const baseDelayMs = Number.isFinite(configuredDelay)
          ? Math.max(0, Math.floor(configuredDelay))
          : 1_000;
        const delayMs = baseDelayMs * Math.min(32, 2 ** (attempt - 1));
        await waitForRetry(delayMs);
      }
    }
  }

  async enqueue(work: CleanupWork) {
    for (;;) {
      const configuredCapacity = this.#capacity();
      const capacity = Number.isFinite(configuredCapacity)
        ? Math.max(1, Math.floor(configuredCapacity))
        : 1;
      if (this.#pending.size < capacity) break;
      if (this.#lossy) {
        logger.warn("ingestion_retired_cleanup_capacity_exhausted", {
          capacity,
          pending: this.#pending.size
        });
        return;
      }
      await Promise.race(this.#pending);
    }
    let task!: Promise<void>;
    task = this.#limiter.run(
      this.#signal,
      () => this.#runBounded(work)
    )
      .finally(() => {
        this.#pending.delete(task);
      });
    this.#pending.add(task);
  }
}

export const ingestionRetiredCleanupQueue = new IngestionRetiredCleanupQueue({
  lossy: true
});
