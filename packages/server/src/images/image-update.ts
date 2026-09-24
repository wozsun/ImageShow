import type {
  ImageUpdateItemResultDto,
  ImageUpdateResponseDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { withAdvisoryLocks } from "../core/database/advisory-locks.ts";
import { logger } from "../core/logger.ts";
import type { ImageUpdateItemInputDto } from "@imageshow/shared/browser";
import { createEntityCountCacheInvalidationBatch } from "../vocab/vocab-cache.ts";
import {
  prepareImageUpdateItem,
  updateImageItem,
  withImageUpdateItemLocks,
  type PreparedImageUpdateItem
} from "./image-update-item.ts";
import { imageUpdateLockRequests } from "./image-update-lock.ts";
import { withPlannedImageMutation } from "./mutation-sync.ts";

type ImageUpdateExecutionMetrics = {
  maxGroupDurationMs: number;
  entityCountInvalidationTriggered: boolean;
};

type ImageUpdateOptions = {
  onMetrics?: (metrics: ImageUpdateExecutionMetrics) => void;
};

const imageUpdateConcurrency = 2;

function publicItemError(
  error: unknown
): Pick<Extract<ImageUpdateItemResultDto, { status: "failed" }>, "code" | "message"> {
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
  let maxGroupDurationMs = 0;
  let entityCountInvalidationTriggered = false;

  return withAdvisoryLocks(
    imageUpdateLockRequests(items.map((item) => item.id)),
    async (requestSignal, lockClient) => {
      const execute = async () => {
        try {
          // One session owns the whole request. Acquire and release auxiliary
          // locks per bounded group before running siblings: concurrent lock
          // scopes on one session could block each other's release queries.
          const results: ImageUpdateItemResultDto[] = [];
          for (let offset = 0; offset < items.length; offset += imageUpdateConcurrency) {
            const group = items.slice(offset, offset + imageUpdateConcurrency);
            const startedAt = performance.now();
            const prepared = await Promise.all(
              group.map(
                async (
                  item
                ): Promise<
                  | { prepared: PreparedImageUpdateItem; failed?: never }
                  | { prepared?: never; failed: ImageUpdateItemResultDto }
                > => {
                  try {
                    requestSignal.throwIfAborted();
                    return { prepared: await prepareImageUpdateItem(item) };
                  } catch (error) {
                    return {
                      failed: {
                        id: item.id,
                        status: "failed",
                        ...publicItemError(error)
                      }
                    };
                  }
                }
              )
            );
            try {
              const groupResults = await withImageUpdateItemLocks(
                prepared.flatMap((entry) => (entry.prepared ? [entry.prepared] : [])),
                lockClient,
                requestSignal,
                (signal) =>
                  Promise.all(
                    prepared.map(async (entry): Promise<ImageUpdateItemResultDto> => {
                      if (entry.failed) return entry.failed;
                      const { item } = entry.prepared;
                      try {
                        await updateImageItem(
                          entry.prepared,
                          { entityCountInvalidationBatch },
                          signal
                        );
                        return { id: item.id, status: "updated" };
                      } catch (error) {
                        return { id: item.id, status: "failed", ...publicItemError(error) };
                      }
                    })
                  )
              );
              results.push(...groupResults);
            } catch (error) {
              results.push(
                ...prepared.map(
                  (entry): ImageUpdateItemResultDto =>
                    entry.failed ?? {
                      id: entry.prepared.item.id,
                      status: "failed",
                      ...publicItemError(error)
                    }
                )
              );
            } finally {
              maxGroupDurationMs = Math.max(maxGroupDurationMs, performance.now() - startedAt);
            }
          }
          const updated = results.filter((result) => result.status === "updated").length;
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
              error: error
            });
          } finally {
            options.onMetrics?.({
              maxGroupDurationMs,
              entityCountInvalidationTriggered
            });
          }
        }
      };

      return withPlannedImageMutation(items.length, execute);
    }
  );
}
