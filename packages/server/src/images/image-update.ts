import type {
  ImageUpdateItemResultDto,
  ImageUpdateResponseDto
} from "@imageshow/shared/browser";
import { withAdvisoryLocks } from "../core/database-advisory-locks.ts";
import type { ImageUpdateItemInput } from "../core/validation.ts";
import { updateImageTags } from "../tags/mutations.ts";
import { createEntityCountCacheInvalidationBatch } from "../vocab/vocab-cache.ts";
import { executeImageUpdateItems } from "./image-update-execution.ts";
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

function countRequestedImages(items: ImageUpdateItemInput[]) {
  return new Set(items.map((item) => item.id.toLowerCase())).size;
}

export async function updateImages(
  items: ImageUpdateItemInput[],
  options: ImageUpdateOptions = {},
): Promise<ImageUpdateResponseDto> {
  const entityCountInvalidationBatch = createEntityCountCacheInvalidationBatch();
  let results: ImageUpdateItemResultDto[] = [];
  let updated = 0;
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
          const execution = await executeImageUpdateItems(items, {
            updateMetadata: (id, metadata) => updateImageMetadata(
              id,
              metadata,
              { entityCountInvalidationBatch }
            ),
            updateTags: (id, tags) => updateImageTags(
              id,
              tags,
              { entityCountInvalidationBatch }
            )
          });
          results = execution.results;
          updated = execution.updated;
          maxItemDurationMs = execution.maxItemDurationMs;
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

        return {
          updated,
          failed: items.length - updated,
          results,
        };
      };

      // The HTTP schema caps one request at 200 items, but this service also
      // protects larger internal callers. Use every explicit image ID as a
      // conservative upper bound because status can change after a PostgreSQL
      // COUNT unless every ready/deleted writer shares the same ownership.
      const affectedCount = countRequestedImages(items);
      return withPlannedImageMutation(affectedCount, execute);
    }
  );
}
