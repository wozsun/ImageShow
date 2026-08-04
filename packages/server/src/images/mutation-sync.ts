import { logger } from "../core/logger.ts";
import {
  getReadyImageCacheCoordinatorStatus,
  reportReadyImageCacheFailure
} from "./ready-cache/coordinator.ts";
import { withReadyImageCacheWriteFence } from "./ready-cache/fence.ts";
import { synchronizeReadyImageCacheMutation } from "./ready-cache/incremental.ts";
import { getReadyImageRevision } from "./ready-cache/revision.ts";

type ImageMutationSyncPlan = { id: string };

export type ImageMutationSyncBatch = {
  add(plan: ImageMutationSyncPlan): void;
  flush(): Promise<void>;
};

function createImageMutationSyncBatch(): ImageMutationSyncBatch {
  const imageIds = new Set<string>();
  return {
    add(plan) {
      imageIds.add(plan.id);
    },
    async flush() {
      if (!imageIds.size) return;
      if (!getReadyImageCacheCoordinatorStatus().initialized) {
        imageIds.clear();
        return;
      }
      const pendingImageIds = [...imageIds];
      imageIds.clear();
      try {
        await synchronizeReadyImageCacheMutation(
          pendingImageIds,
          (await getReadyImageRevision()).revision
        );
      } catch (error) {
        reportReadyImageCacheFailure(error);
        logger.warn("ready_image_cache_mutation_sync_failed", error);
      }
    }
  };
}

/**
 * Closes Redis reads only around the authoritative database write and exact
 * cache publication. PostgreSQL success is never reversed by a Redis failure;
 * the cache gate is closed and its background rebuild becomes the recovery
 * path instead. Callers that also need storage, image, or vocabulary advisory
 * locks must acquire those locks first; every image mutation follows that
 * order so the process fence cannot form a lock cycle with PostgreSQL.
 */
export async function withImageMutationSync<T>(
  work: (target: ImageMutationSyncBatch) => Promise<T>
): Promise<T> {
  return withReadyImageCacheWriteFence(async () => {
    const startingRevision = (await getReadyImageRevision()).revision;
    const target = createImageMutationSyncBatch();
    let value: T | undefined;
    let workError: unknown;
    try {
      value = await work(target);
    } catch (error) {
      workError = error;
    }
    await target.flush();
    try {
      const coordinator = getReadyImageCacheCoordinatorStatus();
      if (coordinator.initialized) {
        const finalRevision = (await getReadyImageRevision()).revision;
        const appliedRevision = coordinator.meta?.appliedRevision;
        if (
          finalRevision !== startingRevision
          && finalRevision !== appliedRevision
        ) {
          reportReadyImageCacheFailure(new Error(
            "PostgreSQL image revision advanced without an exact Redis publish"
          ));
        }
      }
    } catch (error) {
      reportReadyImageCacheFailure(error);
    }
    if (workError) throw workError;
    return value as T;
  });
}
