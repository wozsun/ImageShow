import { ApiError } from "../core/api-error.ts";
import { mapWithConcurrency } from "../core/concurrency.ts";
import type { BatchImageUpdateItemInput } from "../core/validation.ts";
import { setImageTags } from "../tags/service.ts";
import { createEntityCountCacheInvalidationBatch } from "../vocab/vocab-cache.ts";
import { createImageMutationSyncBatch } from "./mutation-sync.ts";
import { updateImageMetadata } from "./service.ts";
import type { BatchImageUpdateItemResult } from "@imageshow/shared/browser";

type BatchUpdateExecutionMetrics = {
  maxItemDurationMs: number;
  entityCountInvalidationTriggered: boolean;
  randomPoolFullRebuildTriggered: boolean;
};

type BatchUpdateOptions = {
  onMetrics?: (metrics: BatchUpdateExecutionMetrics) => void;
};

const batchUpdateConcurrency = 2;

function publicItemError(error: unknown): Pick<Extract<BatchImageUpdateItemResult, { status: "failed" }>, "code" | "message"> {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "batch_update_failed",
    message: "Image update failed",
  };
}

export async function updateImagesBatch(
  items: BatchImageUpdateItemInput[],
  options: BatchUpdateOptions = {},
) {
  const entityCountInvalidationBatch = createEntityCountCacheInvalidationBatch();
  const mutationSyncBatch = createImageMutationSyncBatch();
  let results: BatchImageUpdateItemResult[] = [];
  let maxItemDurationMs = 0;
  let entityCountInvalidationTriggered = false;
  let randomPoolFullRebuildTriggered = false;

  try {
    // Different IDs may run at low concurrency. Metadata and tags for one ID
    // remain ordered, while classification/object moves still serialize on the
    // existing storage mutation lock. Redis repair is flushed once below, so
    // concurrent items never contend for the random-pool incremental lock.
    results = await mapWithConcurrency(items, batchUpdateConcurrency, async (item) => {
      const itemStartedAt = performance.now();
      const { id, tags, ...metadata } = item;
      let itemError: unknown;
      try {
        if (Object.keys(metadata).length) {
          await updateImageMetadata(id, metadata, {
            entityCountInvalidationBatch,
            mutationSyncBatch,
          });
        }
        if (tags !== undefined) {
          await setImageTags(id, tags, {
            entityCountInvalidationBatch,
            mutationSyncBatch,
          });
        }
      } catch (error) {
        itemError = error;
      }
      const result: BatchImageUpdateItemResult = itemError
        ? { id, status: "failed", ...publicItemError(itemError) }
        : { id, status: "updated" };
      maxItemDurationMs = Math.max(maxItemDurationMs, performance.now() - itemStartedAt);
      return result;
    });

    // This also repairs committed metadata when a later tag mutation failed.
    const syncSummary = await mutationSyncBatch.flush();
    randomPoolFullRebuildTriggered = syncSummary.randomPoolFullRebuildTriggered;
  } finally {
    entityCountInvalidationTriggered = entityCountInvalidationBatch.hasWork();
    try {
      await entityCountInvalidationBatch.flush();
    } finally {
      options.onMetrics?.({
        maxItemDurationMs,
        entityCountInvalidationTriggered,
        randomPoolFullRebuildTriggered,
      });
    }
  }

  const updated = results.filter((result) => result.status === "updated").length;
  return {
    requested: items.length,
    updated,
    failed: items.length - updated,
    results,
  };
}
