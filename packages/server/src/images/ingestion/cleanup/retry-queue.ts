import { setTimeout as delay } from "node:timers/promises";
import { appConfig } from "@imageshow/shared";
import { errorMessage } from "../../../core/api-error.ts";
import { DynamicConcurrencyLimiter } from "../../../core/concurrency.ts";
import { logger } from "../../../core/logger.ts";

const signal = new AbortController().signal;
const limiter = new DynamicConcurrencyLimiter(() => 1, (aborted) => aborted.reason);
const pending = new Set<Promise<void>>();

async function retryCleanup(work: () => Promise<void>) {
  const attempts = appConfig.ingestionRuntime.cleanupRetryMaxAttempts;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await limiter.run(signal, work);
      return;
    } catch (error) {
      if (attempt === attempts) {
        logger.warn("ingestion_cleanup_retry_exhausted", {
          attempts: attempt, error: errorMessage(error)
        });
        return;
      }
      logger.warn("ingestion_cleanup_retry_deferred", {
        attempts: attempt, error: errorMessage(error)
      });
      await delay(1_000 * Math.min(32, 2 ** (attempt - 1)), undefined, { ref: false });
    }
  }
}

/** Local disposable files remain discoverable by the periodic age scan. */
export const ingestionCleanupRetryQueue = {
  async enqueue(work: () => Promise<void>) {
    const capacity = appConfig.ingestionRuntime.cleanupRetryQueueCapacity;
    if (pending.size >= capacity) {
      logger.warn("ingestion_cleanup_retry_capacity_exhausted", {
        capacity, pending: pending.size
      });
      return;
    }
    const task = retryCleanup(work).finally(() => pending.delete(task));
    pending.add(task);
  }
};
