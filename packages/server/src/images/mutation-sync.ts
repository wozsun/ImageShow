import { logger } from "../core/logger.ts";
import {
  beginReadyImageCachePlannedMutation,
  getReadyImageCacheCoordinatorStatus,
  readyImageCachePlannedMutationIsActive,
  reportReadyImageCacheFailure,
  requestReadyImageCacheRebuildAfterMutation
} from "./ready-cache/coordinator.ts";
import { clearReadyImageDisposableCaches } from "./ready-cache/derived-cache-lifecycle.ts";
import { withReadyImageCacheWriteFence } from "./ready-cache/fence.ts";
import { synchronizeReadyImageCacheMutation } from "./ready-cache/incremental.ts";
import { getReadyImageRevision } from "./ready-cache/revision.ts";
import {
  READY_IMAGE_EXACT_SYNC_MAX_ITEMS,
  decideImageMutationSync,
  type ImageMutationSyncDecision,
  type ImageMutationSyncResult
} from "./mutation-sync-policy.ts";

type ImageMutationSyncPlan = { id: string };

export type ImageMutationSyncBatch = {
  add(plan: ImageMutationSyncPlan): void;
  decide(affectedCount: number): ImageMutationSyncDecision;
};

type FlushableImageMutationSyncBatch = ImageMutationSyncBatch & {
  flush(): Promise<ImageMutationSyncResult>;
};

function createImageMutationSyncBatch(
  startingRevision: string
): FlushableImageMutationSyncBatch {
  const imageIds = new Set<string>();
  let declaredDecision: ImageMutationSyncDecision | null = null;
  let forcedRebuildCount = 0;
  let flushPromise: Promise<ImageMutationSyncResult> | null = null;
  const requireRebuild = (affectedCount: number) => {
    forcedRebuildCount = Math.max(forcedRebuildCount, affectedCount);
    imageIds.clear();
  };
  const flush = async (): Promise<ImageMutationSyncResult> => {
    const actualCount = imageIds.size;
    let decision = forcedRebuildCount
      ? { mode: "rebuild", affectedCount: forcedRebuildCount } as const
      : declaredDecision ?? decideImageMutationSync(actualCount);
    if (
      decision.mode === "exact"
      && decision.affectedCount !== actualCount
    ) {
      decision = {
        mode: "rebuild",
        affectedCount: Math.max(decision.affectedCount, actualCount)
      };
    }
    if (decision.mode === "none" && actualCount > 0) {
      decision = { mode: "rebuild", affectedCount: actualCount };
    }
    if (decision.mode === "none") {
      return { ...decision, cacheAction: "none" };
    }
    let committedRevision: string;
    try {
      committedRevision = (await getReadyImageRevision()).revision;
    } catch (error) {
      imageIds.clear();
      reportReadyImageCacheFailure(error);
      logger.warn("ready_image_cache_mutation_revision_read_failed", error);
      return { ...decision, cacheAction: "rebuild_requested" };
    }
    if (committedRevision === startingRevision) {
      imageIds.clear();
      return { ...decision, cacheAction: "not_needed" };
    }
    const coordinator = getReadyImageCacheCoordinatorStatus();
    if (!coordinator.initialized) {
      imageIds.clear();
      return { ...decision, cacheAction: "not_initialized" };
    }
    if (readyImageCachePlannedMutationIsActive()) {
      imageIds.clear();
      requestReadyImageCacheRebuildAfterMutation(decision.affectedCount);
      return { ...decision, cacheAction: "rebuild_requested" };
    }
    if (decision.mode === "rebuild") {
      try {
        await clearReadyImageDisposableCaches();
      } catch (error) {
        logger.warn("ready_image_derived_cache_cleanup_failed", error);
      }
      const requested = requestReadyImageCacheRebuildAfterMutation(
        decision.affectedCount
      );
      return {
        ...decision,
        cacheAction: requested ? "rebuild_requested" : "not_initialized"
      };
    }
    const pendingImageIds = [...imageIds];
    imageIds.clear();
    try {
      await synchronizeReadyImageCacheMutation(
        pendingImageIds,
        committedRevision
      );
      return { ...decision, cacheAction: "synchronized" };
    } catch (error) {
      reportReadyImageCacheFailure(error);
      logger.warn("ready_image_cache_mutation_sync_failed", error);
      return { ...decision, cacheAction: "rebuild_requested" };
    }
  };
  return {
    add(plan) {
      if (flushPromise) {
        throw new Error("Image mutation sync batch was already flushed");
      }
      if (forcedRebuildCount) return;
      imageIds.add(plan.id.toLowerCase());
      if (imageIds.size > READY_IMAGE_EXACT_SYNC_MAX_ITEMS) {
        requireRebuild(imageIds.size);
      }
    },
    decide(affectedCount) {
      if (flushPromise || declaredDecision) {
        throw new Error("Image mutation sync count was already decided");
      }
      if (imageIds.size) {
        throw new Error("Image mutation sync count must be decided before IDs");
      }
      declaredDecision = decideImageMutationSync(affectedCount);
      if (declaredDecision.mode === "rebuild") {
        requireRebuild(declaredDecision.affectedCount);
      }
      return declaredDecision;
    },
    flush() {
      flushPromise ??= flush();
      return flushPromise;
    }
  };
}

/**
 * Closes Redis reads around the authoritative database write and its cache
 * handoff. Small changes publish exactly; a pre-counted or unexpectedly large
 * change clears derived products and leaves the core gate closed while a
 * single-flight rebuild starts. PostgreSQL success is never reversed by a
 * Redis failure. Callers that also need storage, image, or vocabulary advisory
 * locks must acquire those locks first so the process fence cannot form a lock
 * cycle with PostgreSQL.
 */
async function withImageMutationSyncResult<T>(
  work: (target: ImageMutationSyncBatch) => Promise<T>
): Promise<{ value: T; sync: ImageMutationSyncResult }> {
  return withReadyImageCacheWriteFence(async () => {
    const startingRevision = (await getReadyImageRevision()).revision;
    const target = createImageMutationSyncBatch(startingRevision);
    let value: T | undefined;
    let workFailed = false;
    let workError: unknown;
    try {
      value = await work(target);
    } catch (error) {
      workFailed = true;
      workError = error;
    }
    const sync = await target.flush();
    try {
      const coordinator = getReadyImageCacheCoordinatorStatus();
      if (coordinator.initialized) {
        const finalRevision = (await getReadyImageRevision()).revision;
        const appliedRevision = coordinator.meta?.appliedRevision;
        if (
          sync.cacheAction !== "rebuild_requested"
          && finalRevision !== startingRevision
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
    if (workFailed) throw workError;
    return { value: value as T, sync };
  });
}

export async function withImageMutationSync<T>(
  work: (target: ImageMutationSyncBatch) => Promise<T>
): Promise<T> {
  return (await withImageMutationSyncResult(work)).value;
}

/**
 * Keep the core projection unreadable across a pre-counted multi-transaction
 * mutation without holding the process write fence while storage or advisory
 * locks are acquired. Nested image transactions still advance PostgreSQL
 * revision, but defer their Redis handoff to one final rebuild.
 */
export async function withPlannedImageMutationRebuild<T>(
  decision: Extract<ImageMutationSyncDecision, { mode: "rebuild" }>,
  work: () => Promise<T>
): Promise<T> {
  const startingRevision = (await getReadyImageRevision()).revision;
  let release: (rebuildRequired: boolean) => boolean = () => false;
  await withReadyImageCacheWriteFence(async () => {
    try {
      await clearReadyImageDisposableCaches();
    } catch (error) {
      logger.warn("ready_image_derived_cache_cleanup_failed", error);
    }
    release = beginReadyImageCachePlannedMutation(decision.affectedCount);
  });

  let value: T | undefined;
  let workFailed = false;
  let workError: unknown;
  try {
    value = await work();
  } catch (error) {
    workFailed = true;
    workError = error;
  }

  await withReadyImageCacheWriteFence(async () => {
    let rebuildRequired = true;
    try {
      rebuildRequired = (await getReadyImageRevision()).revision
        !== startingRevision;
    } catch (error) {
      reportReadyImageCacheFailure(error);
      logger.warn("ready_image_planned_mutation_revision_read_failed", error);
    }
    release(rebuildRequired);
  });
  if (workFailed) throw workError;
  return value as T;
}

export function withPlannedImageMutation<T>(
  affectedCount: number,
  work: () => Promise<T>
) {
  const decision = decideImageMutationSync(affectedCount);
  return decision.mode === "rebuild"
    ? withPlannedImageMutationRebuild(decision, work)
    : work();
}
