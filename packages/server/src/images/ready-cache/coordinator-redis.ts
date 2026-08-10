import { errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import { getRedisConnectionState } from "../../core/redis-client.ts";
import {
  probeRedisOperationalState,
  type RedisOperationalState
} from "../../core/runtime-availability.ts";
import { clearReadyImageDisposableCaches } from "./derived-cache-lifecycle.ts";
import { invalidateReadyImageDerivedOccupancyMirror } from "./derived-cache-occupancy.ts";
import { withReadyImageCacheWriteFence } from "./fence.ts";
import { validateReadyImageCacheAtStartup } from "./integrity.ts";
import { getReadyImageRevision } from "./revision.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";
import {
  handleRedisValidationFailure,
  requestReadyImageCacheRebuildForState
} from "./coordinator-rebuild.ts";
import {
  coordinatorStatus,
  redisConnectionIsValidated
} from "./coordinator-read-admission.ts";
import type { ReadyImageCacheCoordinatorState } from "./coordinator-state.ts";

export type ReadyImageCacheRedisDependencies = {
  getRedisConnectionState: typeof getRedisConnectionState;
  probeRedisOperationalState: typeof probeRedisOperationalState;
  clearDisposableCaches: typeof clearReadyImageDisposableCaches;
  invalidateDerivedOccupancy: typeof invalidateReadyImageDerivedOccupancyMirror;
  withWriteFence: typeof withReadyImageCacheWriteFence;
  getReadyImageRevision: typeof getReadyImageRevision;
  validateReadyImageCacheAtStartup: typeof validateReadyImageCacheAtStartup;
  redisConnectionIsValidated: typeof redisConnectionIsValidated;
  handleValidationFailure: typeof handleRedisValidationFailure;
  requestRebuild: typeof requestReadyImageCacheRebuildForState;
};

const defaultReadyImageCacheRedisDependencies:
  ReadyImageCacheRedisDependencies = {
    getRedisConnectionState,
    probeRedisOperationalState,
    clearDisposableCaches: clearReadyImageDisposableCaches,
    invalidateDerivedOccupancy: invalidateReadyImageDerivedOccupancyMirror,
    withWriteFence: withReadyImageCacheWriteFence,
    getReadyImageRevision,
    validateReadyImageCacheAtStartup,
    redisConnectionIsValidated,
    handleValidationFailure: handleRedisValidationFailure,
    requestRebuild: requestReadyImageCacheRebuildForState
  };

async function revalidateRedisConnection(
  state: ReadyImageCacheCoordinatorState,
  epoch: number,
  dependencies: ReadyImageCacheRedisDependencies
) {
  if (!state.lifecycle.initialized || state.lifecycle.stopped) return;
  const existingRebuild = state.rebuild.task;
  if (existingRebuild) {
    await existingRebuild.catch(() => undefined);
    if (
      state.lifecycle.stopped
      || dependencies.redisConnectionIsValidated(state)
    ) return;
  }

  const validation = await dependencies.withWriteFence(async () => {
    const before = dependencies.getRedisConnectionState();
    if (!before.ready || before.epoch !== epoch) return null;
    state.publication.requiredCommands =
      await dependencies.probeRedisOperationalState();
    if (state.redis.clearDisposableCachesOnNextReady) {
      await dependencies.clearDisposableCaches();
      const afterCleanup = dependencies.getRedisConnectionState();
      if (!afterCleanup.ready || afterCleanup.epoch !== epoch) return null;
      state.redis.clearDisposableCachesOnNextReady = false;
    }
    const postgresRevision = (await dependencies.getReadyImageRevision()).revision;
    const result = await dependencies.validateReadyImageCacheAtStartup(
      postgresRevision
    );
    const after = dependencies.getRedisConnectionState();
    return after.ready && after.epoch === epoch ? result : null;
  });
  if (!validation || state.lifecycle.stopped) return;

  const overlappingRebuild = state.rebuild.task;
  if (overlappingRebuild) {
    await overlappingRebuild.catch(() => undefined);
    return;
  }

  state.publication.meta = validation.meta;
  if (validation.valid) {
    state.redis.validatedConnectionEpoch = epoch;
    state.publication.readable = true;
    state.lifecycle.reason = "ready";
    return;
  }

  state.publication.readable = false;
  state.redis.validatedConnectionEpoch = 0;
  state.lifecycle.reason = validation.reason;
  void dependencies.requestRebuild(state).catch(() => undefined);
}

async function drainRedisRevalidations(
  state: ReadyImageCacheCoordinatorState,
  dependencies: ReadyImageCacheRedisDependencies
) {
  while (
    state.redis.pendingRevalidationEpoch
    && !state.lifecycle.stopped
  ) {
    const epoch = state.redis.pendingRevalidationEpoch;
    state.redis.pendingRevalidationEpoch = 0;
    try {
      await revalidateRedisConnection(state, epoch, dependencies);
    } catch (error) {
      if (state.lifecycle.stopped) return;
      if (dependencies.getRedisConnectionState().epoch === epoch) {
        recordReadyImageCacheError(
          "core",
          "core_validation_failed",
          error
        );
        state.publication.readable = false;
        state.redis.validatedConnectionEpoch = 0;
        state.lifecycle.reason = `degraded:${errorMessage(error)}`;
        const capabilities = await dependencies.handleValidationFailure(
          error,
          "ready_image_cache_redis_revalidation_failed"
        );
        if (capabilities) {
          state.publication.requiredCommands = capabilities;
        }
      }
    }
  }
}

function requestRedisConnectionRevalidation(
  state: ReadyImageCacheCoordinatorState,
  epoch: number,
  dependencies: ReadyImageCacheRedisDependencies
) {
  state.redis.pendingRevalidationEpoch = Math.max(
    state.redis.pendingRevalidationEpoch,
    epoch
  );
  state.redis.revalidationTask ??= drainRedisRevalidations(
    state,
    dependencies
  ).finally(() => {
    state.redis.revalidationTask = null;
    if (
      state.redis.pendingRevalidationEpoch
      && !state.lifecycle.stopped
    ) {
      observeRedisConnectionRevalidation(
        state,
        state.redis.pendingRevalidationEpoch,
        dependencies
      );
    }
  });
  return state.redis.revalidationTask;
}

function observeRedisConnectionRevalidation(
  state: ReadyImageCacheCoordinatorState,
  epoch: number,
  dependencies: ReadyImageCacheRedisDependencies
) {
  void requestRedisConnectionRevalidation(
    state,
    epoch,
    dependencies
  ).catch((error) => {
    logger.warn("ready_image_cache_redis_revalidation_task_failed", error);
  });
}

export function handleRedisOperationalStateChange(
  state: ReadyImageCacheCoordinatorState,
  operational: RedisOperationalState,
  dependencies: ReadyImageCacheRedisDependencies =
    defaultReadyImageCacheRedisDependencies
) {
  if (!state.lifecycle.initialized || state.lifecycle.stopped) return;
  state.publication.readable = false;
  state.redis.validatedConnectionEpoch = 0;
  state.publication.requiredCommands = operational.capabilities;
  if (!operational.available) {
    dependencies.invalidateDerivedOccupancy();
    state.redis.clearDisposableCachesOnNextReady = true;
    state.lifecycle.reason = operational.reason;
    return;
  }
  state.lifecycle.reason = "redis_revalidating";
  observeRedisConnectionRevalidation(
    state,
    operational.connectionEpoch,
    dependencies
  );
}

export async function initializeReadyImageCacheCoordinatorState(
  state: ReadyImageCacheCoordinatorState,
  dependencies: ReadyImageCacheRedisDependencies =
    defaultReadyImageCacheRedisDependencies
) {
  state.lifecycle.stopped = false;
  state.lifecycle.initialized = false;
  state.publication.readable = false;
  state.redis.validatedConnectionEpoch = 0;
  state.publication.requiredCommands = null;
  state.redis.clearDisposableCachesOnNextReady = true;
  state.lifecycle.reason = "validating";
  try {
    state.publication.requiredCommands =
      await dependencies.probeRedisOperationalState();
    state.lifecycle.initialized = true;
    const connection = dependencies.getRedisConnectionState();
    if (!connection.ready) throw new Error("Redis connection is unavailable");
    await requestRedisConnectionRevalidation(
      state,
      connection.epoch,
      dependencies
    );
  } catch (error) {
    state.lifecycle.initialized = true;
    state.lifecycle.reason = `degraded:${errorMessage(error)}`;
    const capabilities = await dependencies.handleValidationFailure(
      error,
      "ready_image_cache_initialization_failed"
    );
    if (capabilities) {
      state.publication.requiredCommands = capabilities;
    }
  }
  return coordinatorStatus(state);
}
