import { ApiError } from "../core/api-error.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import { withAdvisoryLocks } from "../core/db.ts";
import type { BatchImageUpdateItemInput } from "../core/validation.ts";
import { updateImageTags } from "../tags/mutations.ts";
import { createEntityCountCacheInvalidationBatch } from "../vocab/vocab-cache.ts";
import { updateImageMetadata } from "./metadata-mutations.ts";
import { batchImageUpdateLockRequests } from "./batch-update-lock.ts";
import { withPlannedImageMutation } from "./mutation-sync.ts";
import type {
  BatchImageUpdateItemResult,
  BatchImageUpdateResponse
} from "@imageshow/shared/browser";

type BatchUpdateExecutionMetrics = {
  maxItemDurationMs: number;
  entityCountInvalidationTriggered: boolean;
};

type BatchUpdateOptions = {
  onMetrics?: (metrics: BatchUpdateExecutionMetrics) => void;
};

const batchUpdateConcurrency = 2;

function countRequestedImages(items: BatchImageUpdateItemInput[]) {
  return new Set(items.map((item) => item.id.toLowerCase())).size;
}

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
): Promise<BatchImageUpdateResponse> {
  const entityCountInvalidationBatch = createEntityCountCacheInvalidationBatch();
  let results: BatchImageUpdateItemResult[] = [];
  let maxItemDurationMs = 0;
  let entityCountInvalidationTriggered = false;

  return withAdvisoryLocks(
    batchImageUpdateLockRequests(items.map((item) => item.id)),
    async () => {
      const execute = async () => {
        try {
          // Different IDs may run at low concurrency. The request owns every
          // selected image until all PostgreSQL and derived-cache work settles,
          // allowing a recovery snapshot to wait for one authoritative boundary.
          results = await mapWithWorkerPool(items, batchUpdateConcurrency, async (item) => {
            const itemStartedAt = performance.now();
            const { id, tags, ...metadata } = item;
            let itemError: unknown;
            try {
              if (Object.keys(metadata).length) {
                await updateImageMetadata(id, metadata, {
                  entityCountInvalidationBatch,
                });
              }
              if (tags !== undefined) {
                await updateImageTags(id, tags, {
                  entityCountInvalidationBatch,
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
        } finally {
          entityCountInvalidationTriggered = entityCountInvalidationBatch.hasWork();
          try {
            await entityCountInvalidationBatch.flush();
          } finally {
            options.onMetrics?.({
              maxItemDurationMs,
              entityCountInvalidationTriggered,
            });
          }
        }

        const updated = results.filter((result) => result.status === "updated").length;
        return {
          updated,
          failed: items.length - updated,
          results,
        };
      };

      // The HTTP schema currently caps a batch at 200, but this service also
      // protects larger internal callers. Use every explicit image ID as a
      // conservative upper bound because status can change after a PostgreSQL
      // COUNT unless every ready/deleted writer shares the same ownership.
      const affectedCount = countRequestedImages(items);
      return withPlannedImageMutation(affectedCount, execute);
    }
  );
}
