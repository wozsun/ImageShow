import { errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import {
  getRedisConnectionState,
  isRedisRequiredCommandsError,
  type RedisRequiredCommandCapabilities
} from "../../core/redis-client.ts";
import {
  getRedisOperationalState,
  onRedisOperationalStateChange,
  probeRedisOperationalState
} from "../../core/runtime-availability.ts";
import { enqueueRerunnableJob } from "../../jobs/repository.ts";
import {
  readyImageCacheWriteFenceIsClosed,
  tryWithReadyImageCacheReadFence,
  withReadyImageCacheReadFence,
  withReadyImageCacheWriteFence,
  type ReadyImageCacheReadLease
} from "./fence.ts";
import type { ReadyImageCacheMeta } from "./model.ts";
import {
  clearReadyImageDisposableCaches
} from "./derived-cache-lifecycle.ts";
import {
  invalidateReadyImageDerivedOccupancyMirror
} from "./derived-cache-occupancy.ts";
import { validateReadyImageCacheAtStartup } from "./integrity.ts";
import { readReadyImageCacheMeta } from "./meta.ts";
import { rebuildReadyImageCache } from "./rebuild.ts";
import { getReadyImageRevision } from "./revision.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";

const CACHE_REBUILD_JOB_KEY = "ready-image-cache-rebuild";

export type ReadyImageCacheCoordinatorStatus = {
  initialized: boolean;
  readable: boolean;
  rebuilding: boolean;
  rebuildStartedAt: string | null;
  reason: string;
  meta: ReadyImageCacheMeta | null;
  requiredCommands: RedisRequiredCommandCapabilities | null;
};

let initialized = false;
let readable = false;
let stopped = false;
let reason = "not_initialized";
let currentMeta: ReadyImageCacheMeta | null = null;
let requiredCommandCapabilities: RedisRequiredCommandCapabilities | null = null;
let rebuildPromise: Promise<ReadyImageCacheMeta> | null = null;
let activeRebuildStartedAt: string | null = null;
let rebuildAbortController: AbortController | null = null;
let validatedRedisConnectionEpoch = 0;
let redisRevalidationPromise: Promise<void> | null = null;
let pendingRedisRevalidationEpoch = 0;
let clearDisposableCachesOnNextReady = true;
let plannedMutationRebuildHolds = 0;
let plannedMutationRebuildRequired = false;
let plannedMutationAffectedCount = 0;
let plannedMutationReleasePromise: Promise<void> | null = null;
let resolvePlannedMutationRelease: (() => void) | null = null;

function redisConnectionIsValidated() {
  const connection = getRedisConnectionState();
  const operational = getRedisOperationalState();
  return connection.ready
    && operational.available
    && operational.connectionEpoch === connection.epoch
    && connection.epoch === validatedRedisConnectionEpoch;
}

function coordinatorIsReadable() {
  return readable
    && !stopped
    && plannedMutationRebuildHolds === 0
    && redisConnectionIsValidated();
}

function coordinatorStatus(): ReadyImageCacheCoordinatorStatus {
  return {
    initialized,
    readable: coordinatorIsReadable(),
    rebuilding: rebuildPromise !== null,
    rebuildStartedAt: activeRebuildStartedAt,
    reason: plannedMutationRebuildHolds > 0 ? "mutation_in_progress" : reason,
    meta: currentMeta,
    requiredCommands: requiredCommandCapabilities
  };
}

async function scheduleRebuild() {
  await enqueueRerunnableJob(
    "cache.rebuild",
    "ready-images",
    {},
    CACHE_REBUILD_JOB_KEY
  ).catch((error) => {
    logger.warn("ready_image_cache_rebuild_schedule_failed", error);
  });
}

async function handleRedisValidationFailure(
  error: unknown,
  failureEvent: string
) {
  if (isRedisRequiredCommandsError(error)) {
    logger.warn("ready_image_cache_required_redis_commands_missing", {
      missing: error.capabilities.missing
    });
    return error.capabilities;
  }
  logger.warn(failureEvent, error);
  await scheduleRebuild();
  return null;
}

async function runRebuild() {
  activeRebuildStartedAt = new Date().toISOString();
  readable = false;
  validatedRedisConnectionEpoch = 0;
  reason = "rebuilding";
  rebuildAbortController = new AbortController();
  const signal = rebuildAbortController.signal;
  try {
    requiredCommandCapabilities = await probeRedisOperationalState();
    const connection = getRedisConnectionState();
    if (!connection.ready) {
      throw new Error("Redis connection is unavailable before cache rebuild");
    }
    const meta = await rebuildReadyImageCache({ signal });
    const publishedConnection = getRedisConnectionState();
    if (
      !publishedConnection.ready
      || publishedConnection.epoch !== connection.epoch
    ) {
      throw new Error("Redis connection changed while cache was rebuilding");
    }
    currentMeta = meta;
    validatedRedisConnectionEpoch = connection.epoch;
    readable = true;
    reason = "ready";
    logger.info("ready_image_cache_rebuild_completed", {
      revision: meta.appliedRevision,
      item_count: meta.itemCount
    });
    return meta;
  } catch (error) {
    if (!signal.aborted) {
      recordReadyImageCacheError("core", "core_rebuild_failed", error);
    }
    readable = false;
    validatedRedisConnectionEpoch = 0;
    // A failed fixed-namespace rebuild publishes a degraded meta after
    // discarding partial data. Keep every diagnostic consumer aligned with
    // that persisted state instead of retaining the previous ready snapshot.
    currentMeta = await readReadyImageCacheMeta().catch(() => currentMeta);
    reason = signal.aborted ? "stopped" : `degraded:${errorMessage(error)}`;
    if (!signal.aborted) {
      const capabilities = await handleRedisValidationFailure(
        error,
        "ready_image_cache_rebuild_failed"
      );
      if (capabilities) requiredCommandCapabilities = capabilities;
    }
    throw error;
  } finally {
    rebuildAbortController = null;
  }
}

async function revalidateRedisConnection(epoch: number) {
  if (!initialized || stopped) return;
  const existingRebuild = rebuildPromise;
  if (existingRebuild) {
    await existingRebuild.catch(() => undefined);
    if (stopped || redisConnectionIsValidated()) return;
  }

  const validation = await withReadyImageCacheWriteFence(async () => {
    const before = getRedisConnectionState();
    if (!before.ready || before.epoch !== epoch) return null;
    requiredCommandCapabilities = await probeRedisOperationalState();
    if (clearDisposableCachesOnNextReady) {
      await clearReadyImageDisposableCaches();
      const afterCleanup = getRedisConnectionState();
      if (!afterCleanup.ready || afterCleanup.epoch !== epoch) return null;
      clearDisposableCachesOnNextReady = false;
    }
    const postgresRevision = (await getReadyImageRevision()).revision;
    const result = await validateReadyImageCacheAtStartup(postgresRevision);
    const after = getRedisConnectionState();
    return after.ready && after.epoch === epoch ? result : null;
  });
  if (!validation || stopped) return;

  // A forced rebuild can start after the initial overlap check while this
  // validation is waiting for the write fence. Never let an older validation
  // result reopen reads over the fixed namespace while that rebuild clears and
  // repopulates it.
  const overlappingRebuild = rebuildPromise;
  if (overlappingRebuild) {
    await overlappingRebuild.catch(() => undefined);
    return;
  }

  currentMeta = validation.meta;
  if (validation.valid) {
    validatedRedisConnectionEpoch = epoch;
    readable = true;
    reason = "ready";
    return;
  }

  readable = false;
  validatedRedisConnectionEpoch = 0;
  reason = validation.reason;
  void requestReadyImageCacheRebuild().catch(() => undefined);
}

async function drainRedisRevalidations() {
  while (pendingRedisRevalidationEpoch && !stopped) {
    const epoch = pendingRedisRevalidationEpoch;
    pendingRedisRevalidationEpoch = 0;
    try {
      await revalidateRedisConnection(epoch);
    } catch (error) {
      if (getRedisConnectionState().epoch === epoch) {
        recordReadyImageCacheError(
          "core",
          "core_validation_failed",
          error
        );
        readable = false;
        validatedRedisConnectionEpoch = 0;
        reason = `degraded:${errorMessage(error)}`;
        const capabilities = await handleRedisValidationFailure(
          error,
          "ready_image_cache_redis_revalidation_failed"
        );
        if (capabilities) {
          requiredCommandCapabilities = capabilities;
        }
      }
    }
  }
}

function requestRedisConnectionRevalidation(epoch: number) {
  pendingRedisRevalidationEpoch = Math.max(
    pendingRedisRevalidationEpoch,
    epoch
  );
  redisRevalidationPromise ??= drainRedisRevalidations().finally(() => {
    redisRevalidationPromise = null;
    if (pendingRedisRevalidationEpoch && !stopped) {
      observeRedisConnectionRevalidation(pendingRedisRevalidationEpoch);
    }
  });
  return redisRevalidationPromise;
}

function observeRedisConnectionRevalidation(epoch: number) {
  void requestRedisConnectionRevalidation(epoch).catch((error) => {
    logger.warn("ready_image_cache_redis_revalidation_task_failed", error);
  });
}

onRedisOperationalStateChange((operational) => {
  if (!initialized || stopped) return;
  readable = false;
  validatedRedisConnectionEpoch = 0;
  requiredCommandCapabilities = operational.capabilities;
  if (!operational.available) {
    invalidateReadyImageDerivedOccupancyMirror();
    clearDisposableCachesOnNextReady = true;
    reason = operational.reason;
    return;
  }
  reason = "redis_revalidating";
  observeRedisConnectionRevalidation(operational.connectionEpoch);
});

function waitForTask<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener("abort", aborted);
      reject(signal.reason ?? new Error("Cache coordination wait aborted"));
    };
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", aborted);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", aborted);
        reject(error);
      }
    );
  });
}

export async function initializeReadyImageCacheCoordinator() {
  stopped = false;
  // Ignore the initial ioredis `ready` event and run one explicit capability
  // validation. Later reconnect epochs are handled by the listener.
  initialized = false;
  readable = false;
  validatedRedisConnectionEpoch = 0;
  requiredCommandCapabilities = null;
  clearDisposableCachesOnNextReady = true;
  reason = "validating";
  try {
    requiredCommandCapabilities = await probeRedisOperationalState();
    initialized = true;
    const connection = getRedisConnectionState();
    if (!connection.ready) throw new Error("Redis connection is unavailable");
    await requestRedisConnectionRevalidation(connection.epoch);
  } catch (error) {
    initialized = true;
    reason = `degraded:${errorMessage(error)}`;
    const capabilities = await handleRedisValidationFailure(
      error,
      "ready_image_cache_initialization_failed"
    );
    if (capabilities) requiredCommandCapabilities = capabilities;
  }
  return coordinatorStatus();
}

export function requestReadyImageCacheRebuild(
  options: { signal?: AbortSignal } = {}
): Promise<ReadyImageCacheMeta> {
  if (stopped) {
    return Promise.reject(new Error("Ready-image cache coordinator is stopped"));
  }
  const plannedRelease = plannedMutationReleasePromise;
  if (plannedMutationRebuildHolds > 0 && plannedRelease) {
    plannedMutationRebuildRequired = true;
    const deferred = plannedRelease.then(() => (
      requestReadyImageCacheRebuild()
    ));
    return waitForTask(deferred, options.signal);
  }
  rebuildPromise ??= runRebuild().finally(() => {
    rebuildPromise = null;
    activeRebuildStartedAt = null;
  });
  return waitForTask(rebuildPromise, options.signal);
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
    if (stopped) {
      throw new Error("Ready-image cache coordinator is stopped");
    }

    const activeRevalidation = redisRevalidationPromise;
    if (activeRevalidation) {
      await waitForTask(activeRevalidation, signal);
      continue;
    }

    const activeRebuild = rebuildPromise;
    if (activeRebuild) return waitForTask(activeRebuild, signal);

    const lease = await withReadyImageCacheRead(async () => {
      signal?.throwIfAborted();
      const postgresRevision = (await getReadyImageRevision()).revision;
      signal?.throwIfAborted();
      return currentMeta?.state === "ready"
        && currentMeta.appliedRevision === postgresRevision
        ? currentMeta
        : null;
    }, { waitForFence: true, signal });
    signal?.throwIfAborted();
    if (lease.acquired && lease.value) return lease.value;

    // A reconnect validation or rebuild may have started while the blocking
    // read lease was waiting. Join it before deciding that a rebuild is needed.
    if (redisRevalidationPromise || rebuildPromise) continue;

    return requestReadyImageCacheRebuild(options);
  }
}

export function readyImageCacheIsReadable() {
  return coordinatorIsReadable() && !readyImageCacheWriteFenceIsClosed();
}

export function withReadyImageCacheRead<T>(
  work: () => Promise<T>,
  options: { waitForFence?: boolean; signal?: AbortSignal } = {}
): Promise<ReadyImageCacheReadLease<T>> {
  if (!options.waitForFence && !coordinatorIsReadable()) {
    return Promise.resolve({ acquired: false });
  }

  const guardedWork = async () => {
    const initialConnection = getRedisConnectionState();
    if (!coordinatorIsReadable() || !initialConnection.ready) {
      return { valid: false } as const;
    }
    const epoch = initialConnection.epoch;
    const connectionStillMatches = () => {
      const current = getRedisConnectionState();
      return current.ready
        && current.epoch === epoch
        && coordinatorIsReadable();
    };
    if (!connectionStillMatches()) return { valid: false } as const;
    try {
      const value = await work();
      return connectionStillMatches()
        ? { valid: true, value } as const
        : { valid: false } as const;
    } catch (error) {
      if (!connectionStillMatches()) return { valid: false } as const;
      throw error;
    }
  };
  const lease = options.waitForFence
    ? withReadyImageCacheReadFence(guardedWork, options.signal).then(
      (value) => ({ acquired: true, value }) as const
    )
    : tryWithReadyImageCacheReadFence(guardedWork);
  return lease.then((result): ReadyImageCacheReadLease<T> => (
    result.acquired && result.value.valid
      ? { acquired: true, value: result.value.value }
      : { acquired: false }
  ));
}

export function getReadyImageCacheCoordinatorStatus() {
  return coordinatorStatus();
}

export function reportReadyImageCacheFailure(error: unknown) {
  if (stopped) return;
  recordReadyImageCacheError("core", "core_read_failed", error);
  readable = false;
  validatedRedisConnectionEpoch = 0;
  reason = `degraded:${errorMessage(error)}`;
  logger.warn("ready_image_cache_read_failed", error);
  if (!initialized) return;
  if (plannedMutationRebuildHolds > 0) {
    plannedMutationRebuildRequired = true;
    return;
  }
  void requestReadyImageCacheRebuild().catch(() => undefined);
}

export function beginReadyImageCachePlannedMutation(
  affectedCount: number
) {
  if (!Number.isSafeInteger(affectedCount) || affectedCount <= 0) {
    throw new Error("Planned mutation count must be a positive integer");
  }
  if (stopped) {
    return (_rebuildRequired: boolean) => false;
  }
  if (plannedMutationRebuildHolds === 0) {
    plannedMutationReleasePromise = new Promise<void>((resolve) => {
      resolvePlannedMutationRelease = resolve;
    });
  }
  plannedMutationRebuildHolds += 1;
  plannedMutationAffectedCount = Math.max(
    plannedMutationAffectedCount,
    affectedCount
  );
  readable = false;
  reason = `mutation_in_progress:${affectedCount}`;
  let released = false;
  return (rebuildRequired: boolean) => {
    if (released) return false;
    released = true;
    plannedMutationRebuildRequired ||= rebuildRequired;
    plannedMutationRebuildHolds -= 1;
    if (plannedMutationRebuildHolds > 0) return false;
    const shouldRebuild = plannedMutationRebuildRequired;
    const rebuildAffectedCount = plannedMutationAffectedCount;
    const releaseWaiters = resolvePlannedMutationRelease;
    plannedMutationRebuildRequired = false;
    plannedMutationAffectedCount = 0;
    plannedMutationReleasePromise = null;
    resolvePlannedMutationRelease = null;
    if (shouldRebuild) {
      requestReadyImageCacheRebuildAfterMutation(rebuildAffectedCount);
      releaseWaiters?.();
      return true;
    }
    if (
      currentMeta?.state === "ready"
      && redisConnectionIsValidated()
      && !stopped
    ) {
      readable = true;
      reason = "ready";
    }
    releaseWaiters?.();
    return false;
  };
}

export function readyImageCachePlannedMutationIsActive() {
  return plannedMutationRebuildHolds > 0;
}

export function requestReadyImageCacheRebuildAfterMutation(
  affectedCount: number
) {
  if (!Number.isSafeInteger(affectedCount) || affectedCount <= 0) {
    throw new Error("Mutation rebuild count must be a positive integer");
  }
  if (stopped) return false;
  readable = false;
  reason = `mutation_rebuild_required:${affectedCount}`;
  if (!initialized) return false;
  if (plannedMutationRebuildHolds > 0) {
    plannedMutationRebuildRequired = true;
    plannedMutationAffectedCount = Math.max(
      plannedMutationAffectedCount,
      affectedCount
    );
    return true;
  }
  validatedRedisConnectionEpoch = 0;
  void requestReadyImageCacheRebuild().catch(() => undefined);
  return true;
}

export function completeReadyImageCacheMutation(meta: ReadyImageCacheMeta) {
  if (stopped || meta.state !== "ready") return;
  const connection = getRedisConnectionState();
  if (!connection.ready || connection.epoch !== validatedRedisConnectionEpoch) {
    readable = false;
    reason = "redis_connection_changed_during_mutation";
    return;
  }
  currentMeta = meta;
  readable = true;
  reason = "ready";
}

export async function stopReadyImageCacheCoordinator() {
  stopped = true;
  readable = false;
  validatedRedisConnectionEpoch = 0;
  reason = "stopped";
  rebuildAbortController?.abort(new Error("Ready-image cache coordinator stopped"));
  await Promise.all([
    rebuildPromise?.catch(() => undefined),
    redisRevalidationPromise?.catch(() => undefined)
  ]);
}
