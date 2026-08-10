import { getRedisConnectionState } from "../../core/redis-client.ts";
import { requestReadyImageCacheRebuildForState } from "./coordinator-rebuild.ts";
import { redisConnectionIsValidated } from "./coordinator-read-admission.ts";
import type { ReadyImageCacheCoordinatorState } from "./coordinator-state.ts";
import type { ReadyImageCacheMeta } from "./model.ts";

export type ReadyImageCacheMutationDependencies = {
  requestRebuild: (
    state: ReadyImageCacheCoordinatorState
  ) => Promise<ReadyImageCacheMeta>;
  redisConnectionIsValidated: typeof redisConnectionIsValidated;
  getRedisConnectionState: typeof getRedisConnectionState;
};

const defaultReadyImageCacheMutationDependencies:
  ReadyImageCacheMutationDependencies = {
    requestRebuild: requestReadyImageCacheRebuildForState,
    redisConnectionIsValidated,
    getRedisConnectionState
  };

export function requestReadyImageCacheRebuildAfterMutationForState(
  state: ReadyImageCacheCoordinatorState,
  affectedCount: number,
  dependencies: ReadyImageCacheMutationDependencies =
    defaultReadyImageCacheMutationDependencies
) {
  if (!Number.isSafeInteger(affectedCount) || affectedCount <= 0) {
    throw new Error("Mutation rebuild count must be a positive integer");
  }
  if (state.lifecycle.stopped) return false;
  state.publication.readable = false;
  state.lifecycle.reason = `mutation_rebuild_required:${affectedCount}`;
  if (!state.lifecycle.initialized) return false;
  if (state.mutation.holds > 0) {
    state.mutation.rebuildRequired = true;
    state.mutation.affectedCount = Math.max(
      state.mutation.affectedCount,
      affectedCount
    );
    return true;
  }
  state.redis.validatedConnectionEpoch = 0;
  void dependencies.requestRebuild(state).catch(() => undefined);
  return true;
}

export function beginReadyImageCachePlannedMutationForState(
  state: ReadyImageCacheCoordinatorState,
  affectedCount: number,
  dependencies: ReadyImageCacheMutationDependencies =
    defaultReadyImageCacheMutationDependencies
) {
  if (!Number.isSafeInteger(affectedCount) || affectedCount <= 0) {
    throw new Error("Planned mutation count must be a positive integer");
  }
  if (state.lifecycle.stopped) {
    return (_rebuildRequired: boolean) => false;
  }
  if (state.mutation.holds === 0) {
    state.mutation.releaseTask = new Promise<void>((resolve) => {
      state.mutation.release = resolve;
    });
  }
  state.mutation.holds += 1;
  state.mutation.affectedCount = Math.max(
    state.mutation.affectedCount,
    affectedCount
  );
  state.publication.readable = false;
  state.lifecycle.reason = `mutation_in_progress:${affectedCount}`;
  let released = false;
  return (rebuildRequired: boolean) => {
    if (released) return false;
    released = true;
    state.mutation.rebuildRequired ||= rebuildRequired;
    state.mutation.holds -= 1;
    if (state.mutation.holds > 0) return false;
    const shouldRebuild = state.mutation.rebuildRequired;
    const rebuildAffectedCount = state.mutation.affectedCount;
    const releaseWaiters = state.mutation.release;
    state.mutation.rebuildRequired = false;
    state.mutation.affectedCount = 0;
    state.mutation.releaseTask = null;
    state.mutation.release = null;
    if (shouldRebuild) {
      requestReadyImageCacheRebuildAfterMutationForState(
        state,
        rebuildAffectedCount,
        dependencies
      );
      releaseWaiters?.();
      return true;
    }
    if (
      state.publication.meta?.state === "ready"
      && dependencies.redisConnectionIsValidated(state)
      && !state.lifecycle.stopped
    ) {
      state.publication.readable = true;
      state.lifecycle.reason = "ready";
    }
    releaseWaiters?.();
    return false;
  };
}

export function completeReadyImageCacheMutationForState(
  state: ReadyImageCacheCoordinatorState,
  meta: ReadyImageCacheMeta,
  dependencies: ReadyImageCacheMutationDependencies =
    defaultReadyImageCacheMutationDependencies
) {
  if (state.lifecycle.stopped || meta.state !== "ready") return;
  const connection = dependencies.getRedisConnectionState();
  if (
    !connection.ready
    || connection.epoch !== state.redis.validatedConnectionEpoch
  ) {
    state.publication.readable = false;
    state.lifecycle.reason = "redis_connection_changed_during_mutation";
    return;
  }
  state.publication.meta = meta;
  state.publication.readable = true;
  state.lifecycle.reason = "ready";
}
