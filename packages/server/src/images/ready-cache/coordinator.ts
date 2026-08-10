import { errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import { onRedisOperationalStateChange } from "../../core/runtime-availability.ts";
import {
  beginReadyImageCachePlannedMutationForState,
  completeReadyImageCacheMutationForState,
  requestReadyImageCacheRebuildAfterMutationForState
} from "./coordinator-mutation.ts";
import {
  coordinatorStatus,
  readyImageCacheIsReadableForState,
  withReadyImageCacheReadForState,
  type ReadyImageCacheCoordinatorStatus
} from "./coordinator-read-admission.ts";
import {
  requestReadyImageCacheRebuildForState,
  waitForActiveCoordinatorTask
} from "./coordinator-rebuild.ts";
import {
  handleRedisOperationalStateChange,
  initializeReadyImageCacheCoordinatorState
} from "./coordinator-redis.ts";
import { stopReadyImageCacheCoordinatorState } from "./coordinator-shutdown.ts";
import { createReadyImageCacheCoordinatorState } from "./coordinator-state.ts";
import type { ReadyImageCacheReadLease } from "./fence.ts";
import type { ReadyImageCacheMeta } from "./model.ts";
import { getReadyImageRevision } from "./revision.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";

export type { ReadyImageCacheCoordinatorStatus };

const coordinatorState = createReadyImageCacheCoordinatorState();

onRedisOperationalStateChange((operational) => {
  handleRedisOperationalStateChange(coordinatorState, operational);
});

export function initializeReadyImageCacheCoordinator() {
  return initializeReadyImageCacheCoordinatorState(coordinatorState);
}

export function requestReadyImageCacheRebuild(
  options: { signal?: AbortSignal } = {}
) {
  return requestReadyImageCacheRebuildForState(coordinatorState, options);
}

/**
 * Completes a repair job without rebuilding when a detached rebuild already
 * published the current PostgreSQL revision. The read lease makes the
 * revision comparison atomic with respect to image mutations and cache
 * publication; an active rebuild is joined instead of replaced.
 */
export async function ensureReadyImageCacheCurrent(
  options: { signal?: AbortSignal } = {}
) {
  const { signal } = options;
  for (;;) {
    signal?.throwIfAborted();
    if (coordinatorState.lifecycle.stopped) {
      throw new Error("Ready-image cache coordinator is stopped");
    }

    const activeRevalidation = coordinatorState.redis.revalidationTask;
    if (activeRevalidation) {
      await waitForActiveCoordinatorTask(activeRevalidation, signal);
      continue;
    }

    const activeRebuild = coordinatorState.rebuild.task;
    if (activeRebuild) {
      return waitForActiveCoordinatorTask(activeRebuild, signal);
    }

    const lease = await withReadyImageCacheReadForState(
      coordinatorState,
      async () => {
        signal?.throwIfAborted();
        const postgresRevision = (await getReadyImageRevision()).revision;
        signal?.throwIfAborted();
        const meta = coordinatorState.publication.meta;
        return meta?.state === "ready"
          && meta.appliedRevision === postgresRevision
          ? meta
          : null;
      },
      { waitForFence: true, signal }
    );
    signal?.throwIfAborted();
    if (lease.acquired && lease.value) return lease.value;

    if (
      coordinatorState.redis.revalidationTask
      || coordinatorState.rebuild.task
    ) {
      continue;
    }
    return requestReadyImageCacheRebuild(options);
  }
}

export function readyImageCacheIsReadable() {
  return readyImageCacheIsReadableForState(coordinatorState);
}

export function withReadyImageCacheRead<T>(
  work: () => Promise<T>,
  options: { waitForFence?: boolean; signal?: AbortSignal } = {}
): Promise<ReadyImageCacheReadLease<T>> {
  return withReadyImageCacheReadForState(coordinatorState, work, options);
}

export function getReadyImageCacheCoordinatorStatus(): ReadyImageCacheCoordinatorStatus {
  return coordinatorStatus(coordinatorState);
}

export function reportReadyImageCacheFailure(error: unknown) {
  if (coordinatorState.lifecycle.stopped) return;
  recordReadyImageCacheError("core", "core_read_failed", error);
  coordinatorState.publication.readable = false;
  coordinatorState.redis.validatedConnectionEpoch = 0;
  coordinatorState.lifecycle.reason = `degraded:${errorMessage(error)}`;
  logger.warn("ready_image_cache_read_failed", error);
  if (!coordinatorState.lifecycle.initialized) return;
  if (coordinatorState.mutation.holds > 0) {
    coordinatorState.mutation.rebuildRequired = true;
    return;
  }
  void requestReadyImageCacheRebuild().catch(() => undefined);
}

export function beginReadyImageCachePlannedMutation(
  affectedCount: number
) {
  return beginReadyImageCachePlannedMutationForState(
    coordinatorState,
    affectedCount
  );
}

export function readyImageCachePlannedMutationIsActive() {
  return coordinatorState.mutation.holds > 0;
}

export function requestReadyImageCacheRebuildAfterMutation(
  affectedCount: number
) {
  return requestReadyImageCacheRebuildAfterMutationForState(
    coordinatorState,
    affectedCount
  );
}

export function completeReadyImageCacheMutation(meta: ReadyImageCacheMeta) {
  completeReadyImageCacheMutationForState(coordinatorState, meta);
}

export function stopReadyImageCacheCoordinator() {
  return stopReadyImageCacheCoordinatorState(coordinatorState);
}
