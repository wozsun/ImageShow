import type {
  ImageUpdateItemResultDto,
  ImageUpdateResponseDto
} from "@imageshow/shared/browser";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import { withAdvisoryLocks } from "../core/database/advisory-locks.ts";
import { logger } from "../core/logger.ts";
import type { ImageUpdateItemInputDto } from "@imageshow/shared/browser";
import { createEntityCountCacheInvalidationBatch } from "../vocab/vocab-cache.ts";
import { updateImageItem } from "./image-update-item.ts";
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
  items: ImageUpdateItemInputDto[],
  options: ImageUpdateOptions = {}
): Promise<ImageUpdateResponseDto> {
  const entityCountInvalidationBatch = createEntityCountCacheInvalidationBatch();
  let maxItemDurationMs = 0;
  let entityCountInvalidationTriggered = false;

  return withAdvisoryLocks(
    imageUpdateLockRequests(items.map((item) => item.id)),
    async (requestSignal) => {
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
              try {
                await updateImageItem(
                  item,
                  { entityCountInvalidationBatch },
                  requestSignal
                );
                return { id: item.id, status: "updated" };
              } catch (error) {
                return {
                  id: item.id,
                  status: "failed",
                  ...publicItemError(error)
                };
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
          } catch (error) {
            logger.warn("image_update_entity_count_invalidation_failed", {
              error: errorMessage(error)
            });
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
