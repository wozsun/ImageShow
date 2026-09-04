import { appConfig } from "@imageshow/shared";
import { errorMessage } from "../../../core/api-error.ts";
import { DynamicConcurrencyLimiter } from "../../../core/concurrency.ts";
import { logger } from "../../../core/logger.ts";
import {
  STORAGE_OBJECT_REMOVAL_CONCURRENCY
} from "../../../storage/objects/removal-admission.ts";

type CleanupWork = () => Promise<void>;

type IngestionCleanupRetryQueueOptions = Readonly<{
  capacity?: () => number;
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
 * Bounds disposable Ingestion cleanup retries across requests. The default
 * class contract keeps
 * exact work through admission backpressure and retries. The production
 * disposable instance opts into finite best-effort mode only after formal
 * full/thumb candidates have acquired a persistent move.cleanup guard.
 */
class IngestionCleanupRetryQueue {
  readonly #signal = new AbortController().signal;
  readonly #capacity: () => number;
  readonly #lossy: boolean;
  readonly #maxAttempts: () => number;
  readonly #retryDelayMs: () => number;
  readonly #limiter: DynamicConcurrencyLimiter;
  readonly #pending = new Set<Promise<void>>();

  constructor(options: IngestionCleanupRetryQueueOptions = {}) {
    this.#capacity = options.capacity
      ?? (() => appConfig.ingestionRuntime.cleanupRetryQueueCapacity);
    this.#lossy = options.lossy ?? false;
    this.#maxAttempts = options.maxAttempts
      ?? (() => appConfig.ingestionRuntime.cleanupRetryMaxAttempts);
    this.#retryDelayMs = options.retryDelayMs ?? (() => 1_000);
    this.#limiter = new DynamicConcurrencyLimiter(
      () => STORAGE_OBJECT_REMOVAL_CONCURRENCY,
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
        await this.#limiter.run(this.#signal, work);
        if (attempt > 1) {
          logger.warn("ingestion_cleanup_retry_backlog_recovered", {
            attempts: attempt
          });
        }
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          logger.warn("ingestion_cleanup_retry_exhausted", {
            attempts: attempt,
            error: errorMessage(error)
          });
          return;
        }
        if (attempt === 1 || (attempt & (attempt - 1)) === 0) {
          logger.warn("ingestion_cleanup_retry_deferred", {
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
        logger.warn("ingestion_cleanup_retry_capacity_exhausted", {
          capacity,
          pending: this.#pending.size
        });
        return;
      }
      await Promise.race(this.#pending);
    }
    let task!: Promise<void>;
    task = this.#runBounded(work)
      .finally(() => {
        this.#pending.delete(task);
      });
    this.#pending.add(task);
  }
}

export const ingestionCleanupRetryQueue = new IngestionCleanupRetryQueue({
  lossy: true
});
