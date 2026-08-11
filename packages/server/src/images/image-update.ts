import type {
  ImageUpdateItemResultDto,
  ImageUpdateResponseDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import { withAdvisoryLocks } from "../core/database-advisory-locks.ts";
import type { ImageUpdateItemInput } from "../core/validation.ts";
import { updateImageTags } from "../tags/mutations.ts";
import { createEntityCountCacheInvalidationBatch } from "../vocab/vocab-cache.ts";
import { updateImageMetadata } from "./metadata-mutations.ts";
import { imageUpdateLockRequests } from "./image-update-lock.ts";
import { withPlannedImageMutation } from "./mutation-sync.ts";

type ImageUpdateExecutionMetrics = {
  maxItemDurationMs: number;
  entityCountInvalidationTriggered: boolean;
};

type ImageUpdateOptions = {
  onMetrics?: (metrics: ImageUpdateExecutionMetrics) => void;
};

const imageUpdateConcurrency = 2;

function publicItemError(error: unknown): Pick<
  Extract<ImageUpdateItemResultDto, { status: "failed" }>,
  "code" | "message"
> {
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return { code: error.code, message: error.message };
  }
  return {
    code: "image_update_failed",
    message: "Image update failed"
  };
}

export async function updateImages(
  items: ImageUpdateItemInput[],
  options: ImageUpdateOptions = {}
): Promise<ImageUpdateResponseDto> {
  const entityCountInvalidationBatch = createEntityCountCacheInvalidationBatch();
  let maxItemDurationMs = 0;
  let entityCountInvalidationTriggered = false;

  return withAdvisoryLocks(
    imageUpdateLockRequests(items.map((item) => item.id)),
    async () => {
      const execute = async () => {
        try {
          // Different IDs may run at low concurrency. The request owns every
          // selected image until all PostgreSQL and derived-cache work settles,
          // allowing a recovery snapshot to wait for one authoritative boundary.
          const results = await mapWithWorkerPool(
            items,
            imageUpdateConcurrency,
            async (item): Promise<ImageUpdateItemResultDto> => {
              const itemStartedAt = performance.now();
              const { id, tags, ...metadata } = item;
              try {
                if (Object.keys(metadata).length) {
                  await updateImageMetadata(id, metadata, {
                    entityCountInvalidationBatch
                  });
                }
                if (tags !== undefined) {
                  await updateImageTags(id, tags, {
                    entityCountInvalidationBatch
                  });
                }
                return { id, status: "updated" };
              } catch (error) {
                return { id, status: "failed", ...publicItemError(error) };
              } finally {
                maxItemDurationMs = Math.max(
                  maxItemDurationMs,
                  performance.now() - itemStartedAt
                );
              }
            }
          );
          const updated = results.filter(
            (result) => result.status === "updated"
          ).length;
          return {
            updated,
            failed: results.length - updated,
            results
          };
        } finally {
          entityCountInvalidationTriggered = entityCountInvalidationBatch.hasWork();
          try {
            await entityCountInvalidationBatch.flush();
          } finally {
            options.onMetrics?.({
              maxItemDurationMs,
              entityCountInvalidationTriggered
            });
          }
        }
      };

      return withPlannedImageMutation(items.length, execute);
    }
  );
}
