import { errorMessage } from "../../core/api-error.ts";
import { raceWithAbortSignal } from "../../core/abort.ts";
import { logger } from "../../core/logger.ts";
import {
  getRedisConnectionState,
  isRedisRequiredCommandsError,
  type RedisRequiredCommandCapabilities
} from "../../core/redis-client.ts";
import { probeRedisOperationalState } from "../../core/runtime-availability.ts";
import { enqueueRerunnableJob } from "../../jobs/repository.ts";
import { readReadyImageCacheMeta } from "./meta.ts";
import { rebuildReadyImageCache } from "./rebuild.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";
import type { ReadyImageCacheCoordinatorState } from "./coordinator-state.ts";
import type { ReadyImageCacheMeta } from "./model.ts";

const CACHE_REBUILD_JOB_KEY = "ready-image-cache-rebuild";

export type ReadyImageCacheRebuildDependencies = {
  getRedisConnectionState: typeof getRedisConnectionState;
  probeRedisOperationalState: typeof probeRedisOperationalState;
  rebuildReadyImageCache: typeof rebuildReadyImageCache;
  readReadyImageCacheMeta: typeof readReadyImageCacheMeta;
  handleValidationFailure: (
    error: unknown,
    failureEvent: string
  ) => Promise<RedisRequiredCommandCapabilities | null>;
};

function waitForCoordinatorTask<T>(
  task: Promise<T>,
  signal?: AbortSignal
) {
  return signal
    ? raceWithAbortSignal(signal, task, "Cache coordination wait aborted")
    : task;
}

async function scheduleRebuildJob() {
  await enqueueRerunnableJob(
    "cache.rebuild",
    "ready-images",
    {},
    CACHE_REBUILD_JOB_KEY
  ).catch((error) => {
    logger.warn("ready_image_cache_rebuild_schedule_failed", error);
  });
}

export async function handleRedisValidationFailure(
  error: unknown,
  failureEvent: string
): Promise<RedisRequiredCommandCapabilities | null> {
  if (isRedisRequiredCommandsError(error)) {
    logger.warn("ready_image_cache_required_redis_commands_missing", {
      missing: error.capabilities.missing
    });
    return error.capabilities;
  }
  logger.warn(failureEvent, error);
  await scheduleRebuildJob();
  return null;
}

const defaultReadyImageCacheRebuildDependencies:
  ReadyImageCacheRebuildDependencies = {
    getRedisConnectionState,
    probeRedisOperationalState,
    rebuildReadyImageCache,
    readReadyImageCacheMeta,
    handleValidationFailure: handleRedisValidationFailure
  };

async function runRebuild(
  state: ReadyImageCacheCoordinatorState,
  dependencies: ReadyImageCacheRebuildDependencies
) {
  state.rebuild.startedAt = new Date().toISOString();
  state.publication.readable = false;
  state.redis.validatedConnectionEpoch = 0;
  state.lifecycle.reason = "rebuilding";
  state.rebuild.abortController = new AbortController();
  const signal = state.rebuild.abortController.signal;
  try {
    state.publication.requiredCommands =
      await dependencies.probeRedisOperationalState();
    signal.throwIfAborted();
    const connection = dependencies.getRedisConnectionState();
    if (!connection.ready) {
      throw new Error("Redis connection is unavailable before cache rebuild");
    }
    const meta = await dependencies.rebuildReadyImageCache({ signal });
    signal.throwIfAborted();
    const publishedConnection = dependencies.getRedisConnectionState();
    if (
      !publishedConnection.ready
      || publishedConnection.epoch !== connection.epoch
    ) {
      throw new Error("Redis connection changed while cache was rebuilding");
    }
    state.publication.meta = meta;
    state.redis.validatedConnectionEpoch = connection.epoch;
    state.publication.readable = true;
    state.lifecycle.reason = "ready";
    logger.info("ready_image_cache_rebuild_completed", {
      revision: meta.appliedRevision,
      item_count: meta.itemCount
    });
    return meta;
  } catch (error) {
    if (!signal.aborted) {
      recordReadyImageCacheError("core", "core_rebuild_failed", error);
    }
    state.publication.readable = false;
    state.redis.validatedConnectionEpoch = 0;
    state.publication.meta = await dependencies.readReadyImageCacheMeta()
      .catch(() => state.publication.meta);
    state.lifecycle.reason = signal.aborted
      ? "stopped"
      : `degraded:${errorMessage(error)}`;
    if (!signal.aborted) {
      const capabilities = await dependencies.handleValidationFailure(
        error,
        "ready_image_cache_rebuild_failed"
      );
      if (capabilities) {
        state.publication.requiredCommands = capabilities;
      }
    }
    throw error;
  } finally {
    state.rebuild.abortController = null;
  }
}

export function requestReadyImageCacheRebuildForState(
  state: ReadyImageCacheCoordinatorState,
  options: {
    signal?: AbortSignal;
    dependencies?: ReadyImageCacheRebuildDependencies;
  } = {}
): Promise<ReadyImageCacheMeta> {
  if (state.lifecycle.stopped) {
    return Promise.reject(
      new Error("Ready-image cache coordinator is stopped")
    );
  }
  const plannedRelease = state.mutation.releaseTask;
  if (state.mutation.holds > 0 && plannedRelease) {
    state.mutation.rebuildRequired = true;
    const deferred = plannedRelease.then(() => (
      requestReadyImageCacheRebuildForState(state, {
        dependencies: options.dependencies
      })
    ));
    return waitForCoordinatorTask(deferred, options.signal);
  }
  state.rebuild.task ??= runRebuild(
    state,
    options.dependencies ?? defaultReadyImageCacheRebuildDependencies
  ).finally(() => {
    state.rebuild.task = null;
    state.rebuild.startedAt = null;
  });
  return waitForCoordinatorTask(state.rebuild.task, options.signal);
}

export function waitForActiveCoordinatorTask<T>(
  task: Promise<T>,
  signal?: AbortSignal
) {
  return waitForCoordinatorTask(task, signal);
}
