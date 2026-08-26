import { errorMessage } from "../../core/api-error.ts";
import { raceWithAbortSignal } from "../../core/abort.ts";
import { logger } from "../../core/logger.ts";
import {
  getRedisConnectionState,
  isRedisRequiredCommandsError,
  type RedisConnectionState
} from "../../core/redis/client.ts";
import {
  getRedisOperationalState,
  isRedisUnavailableError,
  probeRedisOperationalState,
  type RedisOperationalState
} from "../../core/runtime-availability.ts";
import { enqueueRerunnableJob } from "../../jobs/repository.ts";
import { clearReadyImageDisposableCaches } from "./derived/lifecycle.ts";
import {
  readyImageCacheWriteFenceIsClosed,
  tryWithReadyImageCacheReadFence,
  withReadyImageCacheReadFence,
  withReadyImageCacheWriteFence,
  type ReadyImageCacheReadLease
} from "./sync/fence.ts";
import { validateReadyImageCacheAtStartup } from "./integrity/check.ts";
import { readReadyImageCacheMeta } from "./meta.ts";
import type { ReadyImageCacheMeta } from "./model.ts";
import { rebuildReadyImageCache } from "./rebuild.ts";
import { getReadyImageRevision } from "./revision.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";

const CACHE_REBUILD_JOB_KEY = "ready-image-cache-rebuild";

type ReadyImageCachePhase =
  | "unavailable"
  | "rebuilding"
  | "ready"
  | "stopped";

type ReadyImageCacheRefreshRequest = "none" | "validate" | "rebuild";

type ReadyImageCacheRefreshResult = {
  meta: ReadyImageCacheMeta;
  rebuilt: boolean;
};

type ReadyImageCacheRefreshTask = {
  promise: Promise<ReadyImageCacheRefreshResult>;
  progress: { fulfillsRebuildRequest: boolean };
};

type ReadyImageCacheCoordinatorStatus = {
  initialized: boolean;
  readable: boolean;
  rebuilding: boolean;
  reason: string;
  meta: ReadyImageCacheMeta | null;
};

type ReadyImageCacheCoordinatorDependencies = {
  getRedisConnectionState: typeof getRedisConnectionState;
  getRedisOperationalState: typeof getRedisOperationalState;
  probeRedisOperationalState: typeof probeRedisOperationalState;
  clearDisposableCaches: typeof clearReadyImageDisposableCaches;
  withWriteFence: typeof withReadyImageCacheWriteFence;
  getRevision: typeof getReadyImageRevision;
  validateCache: typeof validateReadyImageCacheAtStartup;
  rebuildCache: typeof rebuildReadyImageCache;
  readMeta: typeof readReadyImageCacheMeta;
  handleValidationFailure(error: unknown, event: string): Promise<void>;
};

class ReadyImageCacheRefreshDeferredError extends Error {
  constructor() {
    super("Ready-image cache rebuild deferred until mutation completes");
    this.name = "ReadyImageCacheRefreshDeferredError";
  }
}

function redisConnectionIsUsable(
  connection: RedisConnectionState,
  operational: RedisOperationalState
) {
  return connection.ready
    && operational.available
    && operational.connectionEpoch === connection.epoch;
}

function waitForTask<T>(task: Promise<T>, signal?: AbortSignal) {
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

async function handleRedisValidationFailure(
  error: unknown,
  event: string
) {
  if (isRedisRequiredCommandsError(error)) {
    logger.warn("ready_image_cache_required_redis_commands_missing", {
      missing: error.capabilities.missing
    });
    return;
  }
  logger.warn(event, error);
  await scheduleRebuildJob();
}

const defaultDependencies: ReadyImageCacheCoordinatorDependencies = {
  getRedisConnectionState,
  getRedisOperationalState,
  probeRedisOperationalState,
  clearDisposableCaches: clearReadyImageDisposableCaches,
  withWriteFence: withReadyImageCacheWriteFence,
  getRevision: getReadyImageRevision,
  validateCache: validateReadyImageCacheAtStartup,
  rebuildCache: rebuildReadyImageCache,
  readMeta: readReadyImageCacheMeta,
  handleValidationFailure: handleRedisValidationFailure
};

export class ReadyImageCacheCoordinator {
  private readonly dependencies: ReadyImageCacheCoordinatorDependencies;
  private initialized = false;
  private phase: ReadyImageCachePhase = "unavailable";
  private reason = "not_initialized";
  private meta: ReadyImageCacheMeta | null = null;
  private activeTask: ReadyImageCacheRefreshTask | null = null;
  private activeAbort: AbortController | null = null;
  private pendingRefresh: ReadyImageCacheRefreshRequest = "none";
  private mutationHolds = 0;
  private mutationRebuildRequired = false;
  private mutationAffectedCount = 0;

  constructor(
    dependencies: ReadyImageCacheCoordinatorDependencies = defaultDependencies
  ) {
    this.dependencies = dependencies;
  }

  private connectionIsUsable() {
    return redisConnectionIsUsable(
      this.dependencies.getRedisConnectionState(),
      this.dependencies.getRedisOperationalState()
    );
  }

  private isReadable() {
    return this.initialized
      && this.phase === "ready"
      && this.pendingRefresh === "none"
      && this.mutationHolds === 0
      && this.connectionIsUsable();
  }

  getStatus(): ReadyImageCacheCoordinatorStatus {
    const rebuildRequested = this.pendingRefresh === "rebuild";
    const rebuildActive = Boolean(
      this.activeTask?.progress.fulfillsRebuildRequest
      && this.phase !== "ready"
    );
    return {
      initialized: this.initialized,
      readable: this.isReadable(),
      rebuilding: this.phase === "rebuilding"
        || rebuildRequested
        || rebuildActive,
      reason: this.phase === "stopped"
        ? "stopped"
        : this.mutationHolds > 0
          ? "mutation_in_progress"
          : rebuildRequested || rebuildActive ? "rebuilding" : this.reason,
      meta: this.meta
    };
  }

  readyImageCacheIsReadable() {
    return this.isReadable() && !readyImageCacheWriteFenceIsClosed();
  }

  withRead<T>(
    work: () => Promise<T>,
    options: { waitForFence?: boolean; signal?: AbortSignal } = {}
  ): Promise<ReadyImageCacheReadLease<T>> {
    if (!options.waitForFence && !this.isReadable()) {
      return Promise.resolve({ acquired: false });
    }
    const guardedWork = async () => {
      const initial = this.dependencies.getRedisConnectionState();
      if (!initial.ready || !this.isReadable()) return { valid: false } as const;
      const stillCurrent = () => {
        const current = this.dependencies.getRedisConnectionState();
        return current.ready
          && current.epoch === initial.epoch
          && this.isReadable();
      };
      try {
        const value = await work();
        return stillCurrent()
          ? { valid: true, value } as const
          : { valid: false } as const;
      } catch (error) {
        // A required request-path Redis command deliberately marks the
        // operational state unavailable before throwing. Do not turn that
        // explicit 503 signal into an ordinary stale-lease cache miss.
        if (isRedisUnavailableError(error)) throw error;
        if (!stillCurrent()) return { valid: false } as const;
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

  async initialize() {
    this.initialized = true;
    this.phase = "unavailable";
    this.reason = "validating";
    this.meta = null;
    this.pendingRefresh = "none";
    try {
      await this.startRefresh(false);
    } catch {
      // The coordinator remains initialized and unavailable. Redis recovery or
      // the durable cache.rebuild job will retry through the same state machine.
    }
    return this.getStatus();
  }

  private connectionChangedSince(epoch: number) {
    const connection = this.dependencies.getRedisConnectionState();
    const operational = this.dependencies.getRedisOperationalState();
    return redisConnectionIsUsable(connection, operational)
      && connection.epoch !== epoch;
  }

  private async validateCurrentConnection(
    epoch: number,
    signal: AbortSignal
  ) {
    let validMeta: ReadyImageCacheMeta | null = null;
    let rebuildRequired = false;
    await this.dependencies.withWriteFence(async () => {
      signal.throwIfAborted();
      const before = this.dependencies.getRedisConnectionState();
      if (!before.ready || before.epoch !== epoch) {
        throw new Error("Redis connection changed before cache validation");
      }
      await this.dependencies.clearDisposableCaches();
      signal.throwIfAborted();
      const afterCleanup = this.dependencies.getRedisConnectionState();
      if (!afterCleanup.ready || afterCleanup.epoch !== epoch) {
        throw new Error("Redis connection changed during cache cleanup");
      }
      const revision = (await this.dependencies.getRevision()).revision;
      const validation = await this.dependencies.validateCache(revision);
      signal.throwIfAborted();
      const afterValidation = this.dependencies.getRedisConnectionState();
      if (!afterValidation.ready || afterValidation.epoch !== epoch) {
        throw new Error("Redis connection changed during cache validation");
      }
      this.meta = validation.meta;
      if (!validation.valid) {
        this.phase = "unavailable";
        this.reason = validation.reason;
        rebuildRequired = true;
        return;
      }
      validMeta = validation.meta;
      if (
        this.mutationHolds === 0
        && this.phase !== "stopped"
        && this.pendingRefresh === "none"
      ) {
        this.phase = "ready";
        this.reason = "ready";
      }
    });
    return { meta: validMeta, rebuildRequired };
  }

  private async runRefresh(
    forceRebuild: boolean,
    signal: AbortSignal,
    progress: ReadyImageCacheRefreshTask["progress"]
  ) {
    for (;;) {
      signal.throwIfAborted();
      let epoch = 0;
      try {
        await this.dependencies.probeRedisOperationalState();
        signal.throwIfAborted();
        const connection = this.dependencies.getRedisConnectionState();
        const operational = this.dependencies.getRedisOperationalState();
        if (!redisConnectionIsUsable(connection, operational)) {
          throw new Error("Redis connection is unavailable");
        }
        epoch = connection.epoch;
        if (!forceRebuild) {
          this.phase = "unavailable";
          this.reason = "validating";
          const validation = await this.validateCurrentConnection(epoch, signal);
          if (validation.meta && !validation.rebuildRequired) {
            return { meta: validation.meta, rebuilt: false };
          }
        }
        if (this.mutationHolds > 0) {
          this.mutationRebuildRequired = true;
          throw new ReadyImageCacheRefreshDeferredError();
        }
        progress.fulfillsRebuildRequest = true;
        if (this.pendingRefresh === "rebuild") {
          this.pendingRefresh = "none";
        }
        this.phase = "rebuilding";
        this.reason = "rebuilding";
        const meta = await this.dependencies.rebuildCache({ signal });
        signal.throwIfAborted();
        const published = this.dependencies.getRedisConnectionState();
        const operationalAfter = this.dependencies.getRedisOperationalState();
        if (
          !redisConnectionIsUsable(published, operationalAfter)
          || published.epoch !== epoch
        ) {
          throw new Error("Redis connection changed while cache was rebuilding");
        }
        this.meta = meta;
        if (
          this.mutationHolds === 0
          && this.pendingRefresh === "none"
        ) {
          this.phase = "ready";
          this.reason = "ready";
        }
        logger.info("ready_image_cache_rebuild_completed", {
          revision: meta.appliedRevision,
          item_count: meta.itemCount
        });
        return { meta, rebuilt: true };
      } catch (error) {
        if (signal.aborted || this.phase === "stopped") {
          throw signal.reason ?? error;
        }
        if (this.connectionChangedSince(epoch)) {
          this.phase = "unavailable";
          this.reason = "redis_revalidating";
          continue;
        }
        throw error;
      }
    }
  }

  private async recordRefreshFailure(error: unknown) {
    if (this.getStatus().reason === "stopped") return;
    if (error instanceof ReadyImageCacheRefreshDeferredError) {
      this.phase = "unavailable";
      this.reason = "mutation_rebuild_required";
      return;
    }
    recordReadyImageCacheError("core", "core_rebuild_failed", error);
    this.phase = "unavailable";
    const operational = this.dependencies.getRedisOperationalState();
    this.reason = operational.available
      ? `degraded:${errorMessage(error)}`
      : operational.reason;
    this.meta = await this.dependencies.readMeta().catch(() => this.meta);
    if (this.getStatus().reason === "stopped") return;
    await this.dependencies.handleValidationFailure(
      error,
      "ready_image_cache_refresh_failed"
    ).catch((handlingError) => {
      logger.warn("ready_image_cache_failure_handling_failed", handlingError);
    });
  }

  private startPendingRefresh() {
    if (
      this.pendingRefresh === "none"
      || !this.initialized
      || this.phase === "stopped"
      || this.activeTask
      || this.mutationHolds > 0
      || !this.connectionIsUsable()
    ) {
      return;
    }
    const forceRebuild = this.pendingRefresh === "rebuild";
    this.pendingRefresh = "none";
    void this.startRefresh(forceRebuild).catch(() => undefined);
  }

  private queueRefresh(forceRebuild: boolean) {
    if (forceRebuild || this.pendingRefresh === "none") {
      this.pendingRefresh = forceRebuild ? "rebuild" : "validate";
    }
    if (forceRebuild && this.phase !== "stopped") {
      this.phase = "rebuilding";
      this.reason = "rebuilding";
    }
    this.startPendingRefresh();
  }

  private startRefresh(forceRebuild: boolean) {
    if (this.phase === "stopped") {
      return Promise.reject(new Error("Ready-image cache coordinator is stopped"));
    }
    const active = this.activeTask;
    if (active) return active.promise;
    if (forceRebuild) {
      this.phase = "rebuilding";
      this.reason = "rebuilding";
    }
    if (forceRebuild || this.pendingRefresh === "validate") {
      this.pendingRefresh = "none";
    }
    const controller = new AbortController();
    const progress = { fulfillsRebuildRequest: forceRebuild };
    let activeTask!: ReadyImageCacheRefreshTask;
    const task = this.runRefresh(forceRebuild, controller.signal, progress)
      .catch(async (error) => {
        await this.recordRefreshFailure(error);
        throw error;
      })
      .finally(() => {
        if (this.activeTask === activeTask) {
          this.activeTask = null;
          this.activeAbort = null;
          this.startPendingRefresh();
        }
      });
    activeTask = { promise: task, progress };
    this.activeAbort = controller;
    this.activeTask = activeTask;
    return task;
  }

  async requestRebuild(
    options: { signal?: AbortSignal } = {}
  ): Promise<ReadyImageCacheMeta> {
    for (;;) {
      options.signal?.throwIfAborted();
      if (this.phase === "stopped") {
        throw new Error("Ready-image cache coordinator is stopped");
      }
      if (this.mutationHolds > 0) {
        this.mutationRebuildRequired = true;
        this.queueRefresh(true);
        throw new ReadyImageCacheRefreshDeferredError();
      }
      const active = this.activeTask;
      if (!active) {
        return (await waitForTask(
          this.startRefresh(true),
          options.signal
        )).meta;
      }
      if (!active.progress.fulfillsRebuildRequest) {
        this.queueRefresh(true);
      }
      try {
        const result = await waitForTask(active.promise, options.signal);
        if (result.rebuilt) return result.meta;
      } catch (error) {
        options.signal?.throwIfAborted();
        if (this.reason === "stopped") throw error;
        if (active.progress.fulfillsRebuildRequest) throw error;
      }
    }
  }

  async ensureCurrent(options: { signal?: AbortSignal } = {}) {
    const { signal } = options;
    for (;;) {
      signal?.throwIfAborted();
      if (this.phase === "stopped") {
        throw new Error("Ready-image cache coordinator is stopped");
      }
      const active = this.activeTask;
      if (active) {
        await waitForTask(active.promise, signal);
        continue;
      }
      const lease = await this.withRead(async () => {
        signal?.throwIfAborted();
        const revision = (await this.dependencies.getRevision()).revision;
        signal?.throwIfAborted();
        return this.meta?.state === "ready"
          && this.meta.appliedRevision === revision
          ? this.meta
          : null;
      }, { waitForFence: true, signal });
      signal?.throwIfAborted();
      if (lease.acquired && lease.value) return lease.value;
      return this.requestRebuild(options);
    }
  }

  handleRedisOperationalStateChange(operational: RedisOperationalState) {
    if (!this.initialized || this.phase === "stopped") return;
    this.phase = "unavailable";
    this.reason = operational.reason;
    if (!operational.available) {
      return;
    }
    this.reason = "redis_revalidating";
    if (this.mutationHolds > 0) {
      this.mutationRebuildRequired = true;
      return;
    }
    this.queueRefresh(false);
  }

  reportFailure(error: unknown) {
    if (this.phase === "stopped") return;
    recordReadyImageCacheError("core", "core_read_failed", error);
    this.phase = "unavailable";
    this.reason = `degraded:${errorMessage(error)}`;
    logger.warn("ready_image_cache_read_failed", error);
    if (!this.initialized) return;
    if (this.mutationHolds > 0) {
      this.mutationRebuildRequired = true;
      return;
    }
    this.queueRefresh(true);
  }

  beginPlannedMutation(affectedCount: number) {
    if (!Number.isSafeInteger(affectedCount) || affectedCount <= 0) {
      throw new Error("Planned mutation count must be a positive integer");
    }
    if (this.phase === "stopped") {
      return (_rebuildRequired: boolean) => false;
    }
    this.mutationHolds += 1;
    this.mutationAffectedCount = Math.max(
      this.mutationAffectedCount,
      affectedCount
    );
    this.phase = "unavailable";
    this.reason = `mutation_in_progress:${affectedCount}`;
    let released = false;
    return (rebuildRequired: boolean) => {
      if (released) return false;
      released = true;
      this.mutationRebuildRequired ||= rebuildRequired;
      this.mutationHolds -= 1;
      if (this.mutationHolds > 0) return false;
      const shouldRebuild = this.mutationRebuildRequired;
      const rebuildAffectedCount = this.mutationAffectedCount;
      this.mutationRebuildRequired = false;
      this.mutationAffectedCount = 0;
      if (this.phase === "stopped") return false;
      if (shouldRebuild) {
        this.requestRebuildAfterMutation(rebuildAffectedCount);
        return true;
      }
      this.queueRefresh(false);
      return false;
    };
  }

  plannedMutationIsActive() {
    return this.mutationHolds > 0;
  }

  requestRebuildAfterMutation(affectedCount: number) {
    if (!Number.isSafeInteger(affectedCount) || affectedCount <= 0) {
      throw new Error("Mutation rebuild count must be a positive integer");
    }
    if (this.phase === "stopped") return false;
    this.phase = "unavailable";
    this.reason = `mutation_rebuild_required:${affectedCount}`;
    if (!this.initialized) return false;
    if (this.mutationHolds > 0) {
      this.mutationRebuildRequired = true;
      this.mutationAffectedCount = Math.max(
        this.mutationAffectedCount,
        affectedCount
      );
      return true;
    }
    this.queueRefresh(true);
    return true;
  }

  completeMutation(meta: ReadyImageCacheMeta) {
    if (this.phase === "stopped" || meta.state !== "ready") return;
    this.meta = meta;
    if (
      this.mutationHolds === 0
      && this.activeTask === null
      && this.pendingRefresh === "none"
      && this.connectionIsUsable()
    ) {
      this.phase = "ready";
      this.reason = "ready";
      return;
    }
    this.phase = "unavailable";
    this.reason = "redis_connection_changed_during_mutation";
    if (this.initialized) this.queueRefresh(false);
  }

  async stop() {
    if (this.phase === "stopped") {
      await this.activeTask?.promise.catch(() => undefined);
      return;
    }
    const stopped = new Error("Ready-image cache coordinator stopped");
    this.phase = "stopped";
    this.reason = "stopped";
    this.pendingRefresh = "none";
    this.activeAbort?.abort(stopped);
    await this.activeTask?.promise.catch(() => undefined);
    this.phase = "stopped";
    this.reason = "stopped";
  }
}
