import "../support/server-environment.ts";
import assert from "node:assert/strict";
import {
  setTimeout as delay
} from "node:timers/promises";
import test from "node:test";
import {
  appConfig
} from "../../../packages/shared/src/app-config.ts";
import {
  readRequiredRedisCommandCapabilities
} from "../../../packages/server/src/core/redis/client.ts";
import {
  deleteRedisStringIfEqual,
  deleteRedisStringsIfEqual,
  parseRedisDeleteIfEqualReply,
  parseRedisSetIfEqualReply,
  refreshRedisStringTtlIfEqual,
  replaceRedisStringIfEqualKeepingTtl
} from "../../../packages/server/src/core/redis/conditional-string.ts";
import {
  redisWindowScripts,
  registerRedisWindowCommand,
  reserveRedisWindowsCommand,
  type RedisWindowCommandClient
} from "../../../packages/server/src/core/redis/window-limit.ts";
import {
  readyImageRedisScripts,
  registerReadyImageRedisCommands
} from "../../../packages/server/src/images/ready-cache/redis/client.ts";
import {
  publishReadyImageAttributeIndexCommand,
  sampleReadyImageCoreIndexCommand,
  sampleReadyImageDerivedIndexCommand,
  storeReadyImageFilterSetCommand,
  touchReadyImageIndexedResultCommand,
  touchReadyImageStatsResultCommand,
  type RedisAttributePublishCommandClient,
  type RedisDerivedRegistryCommandConfig,
  type RedisFilterSetCommandClient,
  type RedisIndexedTouchCommandClient,
  type RedisReadyImageCoreSampleCommandClient,
  type RedisReadyImageDerivedSampleCommandClient,
  type RedisStatsTouchCommandClient
} from "../../../packages/server/src/images/ready-cache/redis/commands.ts";
import {
  createPublicDatabaseAdmission
} from "../../../packages/server/src/core/database/public-admission.ts";
import {
  createPublicDatabaseReadScope
} from "../../../packages/server/src/core/database/public-fallback.ts";
import {
  readImageServingRecordById,
  readImageServingRecordByObjectKey,
  readImageServingRecordByThumbKey
} from "../../../packages/server/src/images/image-serving-record.ts";
import {
  readyImageMember,
  serializeReadyImageCacheItem
} from "../../../packages/server/src/images/ready-cache/model.ts";
import {
  ReadyImageCacheCoordinator
} from "../../../packages/server/src/images/ready-cache/coordinator-machine.ts";
import {
  readReadyImageCacheMeta,
  rebuildingReadyImageCacheMeta
} from "../../../packages/server/src/images/ready-cache/meta.ts";
import {
  getReadyImageCacheOverviewStatus,
  readReadyImageCacheAdminStatus
} from "../../../packages/server/src/images/ready-cache/admin-status.ts";
import {
  measureReadyImageCoreMemory
} from "../../../packages/server/src/images/ready-cache/sync/redis-writer.ts";
import {
  READY_IMAGE_CORE_KEYS
} from "../../../packages/server/src/images/ready-cache/keys.ts";
import {
  sampleResolvedReadyImageIndex
} from "../../../packages/server/src/images/ready-cache/random-sampler.ts";
import {
  inspectRedisKeyspaceDeep
} from "../../../packages/server/src/checks/redis-deep-inspection.ts";
import {
  inspectRedisState
} from "../../../packages/server/src/checks/redis-inspect.ts";
import type {
  RedisOperationalState
} from "../../../packages/server/src/core/runtime-availability.ts";
import {
  storageObjectKey
} from "../../../packages/server/src/storage/objects/image-paths.ts";
import {
  imageId,
  servingReadyCacheItem,
  readyCacheMeta,
  deferredPromise,
  type ReadyImageSampleDependencies
} from "../support/server-test-context.ts";

test("[Server/缓存与 Redis] ready cache 拒绝完整重建时间逆序的持久 meta", async () => {
  await assert.rejects(
    readReadyImageCacheMeta({
      hgetall: async () => ({
        state: "ready",
        applied_revision: "8",
        item_count: "1",
        last_updated_at: "2026-08-10T03:00:00.000Z",
        full_rebuild_started_at: "2026-08-10T03:00:00.000Z",
        full_rebuild_completed_at: "2026-08-10T02:00:00.000Z",
        processed: "0",
        total: "0",
        last_full_rebuild_core_memory_bytes: "1024",
        last_full_rebuild_measured_at: "2026-08-10T01:59:59.000Z",
        last_error: ""
      })
    } as never),
    /full rebuild timestamps are out of order/
  );
});
test("[Server/缓存与 Redis] 公开 PostgreSQL 回源在缓存命中时零准入且多查询复用一个 client", async () => {
  class FakePublicClient {
    readonly releases: boolean[] = [];
    readonly queries: string[] = [];
    active = 0;
    maximumActive = 0;
    readonly execute: (text: string) => Promise<unknown>;

    constructor(execute: (text: string) => Promise<unknown> = async () => ({
      rows: []
    })) {
      this.execute = execute;
    }

    async query(text: string) {
      this.queries.push(text);
      this.active += 1;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      try {
        return await this.execute(text);
      } finally {
        this.active -= 1;
      }
    }

    release(destroy = false) {
      this.releases.push(destroy);
    }
  }

  const client = new FakePublicClient();
  let admissionAcquires = 0;
  let admissionReleases = 0;
  let connects = 0;
  const scope = createPublicDatabaseReadScope({
    pool: {
      connect: async () => {
        connects += 1;
        return client;
      }
    } as never,
    admission: {
      acquire: async (_signal: AbortSignal) => {
        admissionAcquires += 1;
        return {
          release: () => {
            admissionReleases += 1;
          }
        };
      },
      snapshot: () => ({}) as never
    },
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  } as never);

  assert.equal(
    await scope(
      new AbortController().signal,
      async () => "redis cache hit"
    ),
    "redis cache hit"
  );
  assert.equal(admissionAcquires, 0);
  assert.equal(connects, 0);
  assert.deepEqual(client.releases, []);
  const workError = new Error("storage failed before PostgreSQL fallback");
  await assert.rejects(
    scope(new AbortController().signal, async () => {
      throw workError;
    }),
    (error) => error === workError
  );
  assert.equal(admissionAcquires, 0);
  assert.equal(connects, 0);

  assert.equal(await scope(
    new AbortController().signal,
    async ({ reader }) => {
      await Promise.all([
        reader.query("theme vocabulary"),
        reader.query("tag vocabulary"),
        reader.query("author vocabulary")
      ]);
      await reader.query("public response body");
      return "PostgreSQL fallback";
    }
  ), "PostgreSQL fallback");
  assert.equal(admissionAcquires, 1);
  assert.equal(connects, 1);
  assert.deepEqual(client.queries, [
    "theme vocabulary",
    "tag vocabulary",
    "author vocabulary",
    "public response body"
  ]);
  assert.deepEqual(client.releases, [false]);
  assert.equal(admissionReleases, 1);
  assert.equal(client.maximumActive, 1, "公开 reader 必须逐条执行单连接 SQL");

  const blockedAdmission = createPublicDatabaseAdmission({
    ...appConfig.publicPgFallback,
    totalConcurrency: 1
  });
  const blockedHolder = await blockedAdmission.acquire(
    new AbortController().signal
  );
  let blockedConnects = 0;
  const blockedScope = createPublicDatabaseReadScope({
    pool: {
      connect: async () => {
        blockedConnects += 1;
        return new FakePublicClient();
      }
    } as never,
    admission: blockedAdmission,
    executionTimeoutMs: 1_000,
    retryAfterSeconds: 1
  });
  const detachedErrors: unknown[] = [];
  assert.equal(await blockedScope(
    new AbortController().signal,
    async ({ reader }) => {
      void reader.query("detached").catch((error) => {
        detachedErrors.push(error);
      });
      return "returned early";
    }
  ), "returned early");
  assert.deepEqual(blockedAdmission.snapshot(), { active: 1, queued: 0 });
  assert.equal(blockedConnects, 0);
  blockedHolder.release();
  await delay(0);
  assert.equal(detachedErrors.length, 1);
});
test("[Server/缓存与 Redis] serving record 统一 Redis 命中、空命中与 PostgreSQL fallback", async () => {
  const item = servingReadyCacheItem();
  const readyRow = {
    id: item.id,
    object_key: item.object_key,
    original: item.original,
    ext: item.ext,
    storage_slug: item.storage_slug,
    device: item.device,
    brightness: item.brightness,
    theme: item.theme,
    status: "ready" as const,
    description: item.description,
    source: item.source,
    updated_at: item.updated_at
  };
  const deletedRow = { ...readyRow, status: "deleted" as const };
  let idCache: unknown = { cached: true, value: item };
  let objectCache: unknown = { cached: true, value: item };
  let thumbCache: unknown = { cached: true, value: item };
  let queryRows: unknown[] = [];
  const queryParameters: unknown[][] = [];
  const reader = {
    query: async (_sql: string, parameters: unknown[]) => {
      queryParameters.push(parameters);
      return { rows: queryRows };
    }
  } as never;
  const dependencies = {
    readReadyImageById: async () => idCache,
    readReadyImageByObjectKey: async () => objectCache,
    readReadyImageByThumbKey: async () => thumbCache
  } as never;

  const cached = await readImageServingRecordById(
    item.id,
    {},
    dependencies
  );
  assert.equal(cached?.object_key, item.object_key);
  assert.equal(cached?.status, "ready");
  assert.equal(queryParameters.length, 0);

  idCache = { cached: true, value: null };
  assert.equal(
    await readImageServingRecordById(item.id, {}, dependencies),
    null
  );
  assert.equal(queryParameters.length, 0);

  queryRows = [deletedRow];
  const deleted = await readImageServingRecordById(
    item.id,
    { includeDeleted: true, database: { reader } },
    dependencies
  );
  assert.equal(deleted?.status, "deleted");
  assert.deepEqual(queryParameters.at(-1), [item.id, true]);

  idCache = { cached: false };
  queryRows = [readyRow];
  assert.equal(
    (await readImageServingRecordById(
      item.id,
      { database: { reader } },
      dependencies
    ))?.status,
    "ready"
  );
  assert.deepEqual(queryParameters.at(-1), [item.id, false]);

  assert.equal(
    (await readImageServingRecordByObjectKey(
      item.object_key,
      { reader },
      dependencies
    ))?.id,
    item.id
  );
  objectCache = { cached: true, value: null };
  queryRows = [deletedRow];
  assert.equal(
    (await readImageServingRecordByObjectKey(
      item.object_key,
      { reader },
      dependencies
    ))?.status,
    "deleted"
  );

  thumbCache = { cached: true, value: null };
  queryRows = [deletedRow];
  assert.equal(
    (await readImageServingRecordByThumbKey(
      item.object_key.replace(/\.[^.]+$/, ".webp"),
      { reader },
      dependencies
    ))?.status,
    "deleted"
  );
});
test("[Server/缓存与 Redis] ready cache coordinator 收口重连、revision、mutation 与 shutdown 行为", async () => {
  type CoordinatorDependencies = NonNullable<
    ConstructorParameters<typeof ReadyImageCacheCoordinator>[0]
  >;
  const capabilities = {
    available: true,
    commands: {},
    missing: []
  } as never;
  let connection = { ready: true, epoch: 1 };
  let operational: RedisOperationalState = {
    available: true,
    connectionEpoch: 1,
    reason: "ready",
    capabilities
  };
  let revision = "1";
  let persistedMeta = readyCacheMeta(revision);
  let cleanupCalls = 0;
  let rebuildCalls = 0;
  let validationCalls = 0;
  let validationFailureCalls = 0;
  let afterWriteFence = async () => undefined;
  let probe = async () => {
    if (!operational.available) throw new Error("Redis unavailable");
    return capabilities;
  };
  let handleValidationFailure = async () => {
    validationFailureCalls += 1;
  };
  let validate: CoordinatorDependencies["validateCache"] = async () => ({
    valid: true as const,
    meta: persistedMeta
  });
  let rebuild: CoordinatorDependencies["rebuildCache"] = async () => {
    rebuildCalls += 1;
    return readyCacheMeta(revision);
  };
  const dependencies = {
    getRedisConnectionState: () => connection,
    getRedisOperationalState: () => operational,
    probeRedisOperationalState: () => probe(),
    clearDisposableCaches: async () => {
      cleanupCalls += 1;
      return true;
    },
    withWriteFence: async (work) => {
      const value = await work();
      await afterWriteFence();
      return value;
    },
    getRevision: async () => ({
      revision,
      updatedAt: "2026-08-11T00:00:00.000Z"
    }),
    validateCache: async (postgresRevision) => {
      validationCalls += 1;
      return validate(postgresRevision);
    },
    rebuildCache: (options) => rebuild(options),
    readMeta: async () => persistedMeta,
    handleValidationFailure: () => handleValidationFailure()
  } satisfies CoordinatorDependencies;
  const coordinator = new ReadyImageCacheCoordinator(dependencies);

  let status = await coordinator.initialize();
  assert.equal(status.initialized, true);
  assert.equal(status.readable, true);
  assert.equal(status.rebuilding, false);
  assert.equal(status.meta?.appliedRevision, "1");
  assert.equal(cleanupCalls, 1);
  assert.equal(rebuildCalls, 0);
  assert.deepEqual(
    await coordinator.withRead(async () => "redis"),
    { acquired: true, value: "redis" }
  );

  const manualProbeEntered = deferredPromise<void>();
  const finishManualProbe = deferredPromise<void>();
  const manualRebuildEntered = deferredPromise<void>();
  const finishManualRebuild = deferredPromise<void>();
  probe = async () => {
    manualProbeEntered.resolve();
    await finishManualProbe.promise;
    return capabilities;
  };
  rebuild = async ({ signal } = {}) => {
    rebuildCalls += 1;
    manualRebuildEntered.resolve();
    await finishManualRebuild.promise;
    signal?.throwIfAborted();
    return persistedMeta;
  };
  const slowProbeRebuild = coordinator.requestRebuild();
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  assert.equal(coordinator.getStatus().reason, "rebuilding");
  await manualProbeEntered.promise;
  finishManualProbe.resolve();
  await manualRebuildEntered.promise;
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  finishManualRebuild.resolve();
  assert.equal((await slowProbeRebuild).appliedRevision, "1");
  probe = async () => {
    if (!operational.available) throw new Error("Redis unavailable");
    return capabilities;
  };
  rebuild = async () => {
    rebuildCalls += 1;
    return persistedMeta;
  };

  const currentValidationEntered = deferredPromise<void>();
  const finishCurrentValidation = deferredPromise<void>();
  const currentValidationHeldAtFence = deferredPromise<void>();
  const finishCurrentValidationFence = deferredPromise<void>();
  const pendingRebuildEntered = deferredPromise<void>();
  const finishPendingRebuild = deferredPromise<void>();
  validate = async () => {
    currentValidationEntered.resolve();
    await finishCurrentValidation.promise;
    return { valid: true as const, meta: persistedMeta };
  };
  afterWriteFence = async () => {
    currentValidationHeldAtFence.resolve();
    await finishCurrentValidationFence.promise;
  };
  rebuild = async ({ signal } = {}) => {
    rebuildCalls += 1;
    pendingRebuildEntered.resolve();
    await finishPendingRebuild.promise;
    signal?.throwIfAborted();
    return persistedMeta;
  };
  coordinator.handleRedisOperationalStateChange(operational);
  await currentValidationEntered.promise;
  const rebuildAfterCurrentValidation = coordinator.requestRebuild();
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  finishCurrentValidation.resolve();
  await currentValidationHeldAtFence.promise;
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  finishCurrentValidationFence.resolve();
  await pendingRebuildEntered.promise;
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  finishPendingRebuild.resolve();
  assert.equal((await rebuildAfterCurrentValidation).appliedRevision, "1");
  assert.equal(coordinator.getStatus().readable, true);
  assert.equal(coordinator.getStatus().rebuilding, false);
  afterWriteFence = async () => undefined;

  connection = { ready: false, epoch: 1 };
  operational = {
    available: false,
    connectionEpoch: 1,
    reason: "connection_unavailable",
    capabilities: null
  };
  coordinator.handleRedisOperationalStateChange(operational);
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().reason, "connection_unavailable");
  assert.deepEqual(
    await coordinator.withRead(async () => "unused"),
    { acquired: false }
  );

  connection = { ready: true, epoch: 2 };
  operational = {
    available: true,
    connectionEpoch: 2,
    reason: "ready",
    capabilities
  };
  revision = "2";
  const reconnectRebuild = deferredPromise<ReturnType<typeof readyCacheMeta>>();
  const reconnectValidationEntered = deferredPromise<void>();
  const finishReconnectValidation = deferredPromise<void>();
  validate = async () => {
    reconnectValidationEntered.resolve();
    await finishReconnectValidation.promise;
    return {
      valid: false as const,
      reason: "revision_mismatch",
      meta: persistedMeta
    };
  };
  rebuild = async ({ signal } = {}) => {
    rebuildCalls += 1;
    const meta = await reconnectRebuild.promise;
    signal?.throwIfAborted();
    return meta;
  };
  const rebuildCallsBeforeReconnect = rebuildCalls;
  const cleanupCallsBeforeReconnect = cleanupCalls;
  coordinator.handleRedisOperationalStateChange(operational);
  await reconnectValidationEntered.promise;
  const joinedRebuild = coordinator.requestRebuild();
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().rebuilding, true);
  assert.equal(coordinator.getStatus().reason, "rebuilding");
  finishReconnectValidation.resolve();
  await delay(0);
  assert.equal(coordinator.getStatus().rebuilding, true);
  const timeoutSignal = AbortSignal.timeout(5);
  await assert.rejects(
    coordinator.requestRebuild({ signal: timeoutSignal }),
    (error: Error) => error === timeoutSignal.reason
  );
  persistedMeta = readyCacheMeta("2");
  reconnectRebuild.resolve(persistedMeta);
  assert.equal((await joinedRebuild).appliedRevision, "2");
  assert.equal(rebuildCalls - rebuildCallsBeforeReconnect, 1);
  status = coordinator.getStatus();
  assert.equal(status.readable, true);
  assert.equal(status.meta?.appliedRevision, "2");
  assert.equal(cleanupCalls - cleanupCallsBeforeReconnect, 1);

  connection = { ready: true, epoch: 3 };
  operational = {
    available: true,
    connectionEpoch: 3,
    reason: "ready",
    capabilities
  };
  let drifted = false;
  validate = async () => {
    if (!drifted) {
      drifted = true;
      connection = { ready: true, epoch: 4 };
      operational = { ...operational, connectionEpoch: 4 };
    }
    return { valid: true as const, meta: persistedMeta };
  };
  const validationCallsBeforeDrift = validationCalls;
  coordinator.handleRedisOperationalStateChange({
    ...operational,
    connectionEpoch: 3
  });
  assert.equal((await coordinator.ensureCurrent()).appliedRevision, "2");
  assert.equal(validationCalls - validationCallsBeforeDrift, 2);
  assert.equal(coordinator.getStatus().readable, true);

  const failedValidation = new Error("controlled validation failure");
  const failedValidationEntered = deferredPromise<void>();
  const finishFailedValidation = deferredPromise<void>();
  validate = async () => {
    failedValidationEntered.resolve();
    await finishFailedValidation.promise;
    throw failedValidation;
  };
  rebuild = async () => {
    rebuildCalls += 1;
    return persistedMeta;
  };
  const rebuildCallsBeforeFailedValidation = rebuildCalls;
  coordinator.handleRedisOperationalStateChange(operational);
  await failedValidationEntered.promise;
  const rebuildAfterFailedValidation = coordinator.requestRebuild();
  finishFailedValidation.resolve();
  assert.equal(
    (await rebuildAfterFailedValidation).appliedRevision,
    persistedMeta.appliedRevision
  );
  assert.equal(rebuildCalls - rebuildCallsBeforeFailedValidation, 1);
  assert.equal(coordinator.getStatus().readable, true);

  revision = "3";
  const mutationRebuild = deferredPromise<ReturnType<typeof readyCacheMeta>>();
  rebuild = async ({ signal } = {}) => {
    rebuildCalls += 1;
    const meta = await mutationRebuild.promise;
    signal?.throwIfAborted();
    return meta;
  };
  const releaseFirst = coordinator.beginPlannedMutation(5);
  const releaseSecond = coordinator.beginPlannedMutation(9);
  assert.equal(coordinator.plannedMutationIsActive(), true);
  assert.equal(coordinator.getStatus().readable, false);
  await assert.rejects(
    coordinator.requestRebuild(),
    /rebuild deferred until mutation completes/
  );
  assert.equal(coordinator.getStatus().rebuilding, true);
  const rebuildCallsBeforeMutation = rebuildCalls;
  assert.equal(releaseFirst(false), false);
  assert.equal(releaseSecond(false), true);
  assert.equal(coordinator.plannedMutationIsActive(), false);
  await delay(0);
  const mutationJoin = coordinator.requestRebuild();
  persistedMeta = readyCacheMeta("3");
  mutationRebuild.resolve(persistedMeta);
  assert.equal((await mutationJoin).appliedRevision, "3");
  assert.equal(rebuildCalls - rebuildCallsBeforeMutation, 1);
  assert.equal(coordinator.getStatus().readable, true);

  connection = { ready: true, epoch: 5 };
  operational = {
    available: true,
    connectionEpoch: 5,
    reason: "ready",
    capabilities
  };
  const validationEntered = deferredPromise<void>();
  const finishValidation = deferredPromise<void>();
  const validationFinishedInsideFence = deferredPromise<void>();
  const finishFence = deferredPromise<void>();
  let pauseFenceOnce = true;
  validate = async () => {
    validationEntered.resolve();
    await finishValidation.promise;
    return { valid: true as const, meta: persistedMeta };
  };
  afterWriteFence = async () => {
    if (!pauseFenceOnce) return;
    pauseFenceOnce = false;
    validationFinishedInsideFence.resolve();
    await finishFence.promise;
  };
  const validationCallsBeforeMutationOverlap = validationCalls;
  coordinator.handleRedisOperationalStateChange(operational);
  await validationEntered.promise;
  const releaseUnchangedMutation = coordinator.beginPlannedMutation(1);
  finishValidation.resolve();
  await validationFinishedInsideFence.promise;
  assert.equal(releaseUnchangedMutation(false), false);
  finishFence.resolve();
  assert.equal((await coordinator.ensureCurrent()).appliedRevision, "3");
  assert.equal(validationCalls - validationCallsBeforeMutationOverlap, 2);
  assert.equal(coordinator.getStatus().readable, true);
  afterWriteFence = async () => undefined;

  const staleRefreshFailure = new Error("stale connection refresh failure");
  const failureHandlingEntered = deferredPromise<void>();
  const finishFailureHandling = deferredPromise<void>();
  handleValidationFailure = async () => {
    validationFailureCalls += 1;
    failureHandlingEntered.resolve();
    await finishFailureHandling.promise;
  };
  rebuild = async () => {
    rebuildCalls += 1;
    throw staleRefreshFailure;
  };
  const staleRefresh = coordinator.requestRebuild();
  const staleRefreshRejected = assert.rejects(
    staleRefresh,
    (error: Error) => error === staleRefreshFailure
  );
  await failureHandlingEntered.promise;
  connection = { ready: true, epoch: 6 };
  operational = {
    available: true,
    connectionEpoch: 6,
    reason: "ready",
    capabilities
  };
  const validationCallsBeforeFailureOverlap = validationCalls;
  coordinator.handleRedisOperationalStateChange(operational);
  finishFailureHandling.resolve();
  await staleRefreshRejected;
  assert.equal((await coordinator.ensureCurrent()).appliedRevision, "3");
  assert.equal(validationCalls - validationCallsBeforeFailureOverlap, 1);
  assert.equal(coordinator.getStatus().readable, true);
  handleValidationFailure = async () => {
    validationFailureCalls += 1;
  };

  const rebuildFailure = new Error("controlled rebuild failure");
  const validationFailureCallsBeforeRebuild = validationFailureCalls;
  const rebuildFailureStarted = deferredPromise<void>();
  const finishRebuildFailure = deferredPromise<void>();
  const rebuildCallsBeforeSharedFailure = rebuildCalls;
  rebuild = async () => {
    rebuildCalls += 1;
    rebuildFailureStarted.resolve();
    await finishRebuildFailure.promise;
    throw rebuildFailure;
  };
  const firstFailedRebuild = coordinator.requestRebuild();
  await rebuildFailureStarted.promise;
  const joinedFailedRebuild = coordinator.requestRebuild();
  finishRebuildFailure.resolve();
  await Promise.all([
    assert.rejects(
      firstFailedRebuild,
      (error: Error) => error === rebuildFailure
    ),
    assert.rejects(
      joinedFailedRebuild,
      (error: Error) => error === rebuildFailure
    )
  ]);
  assert.equal(rebuildCalls - rebuildCallsBeforeSharedFailure, 1);
  assert.equal(coordinator.getStatus().readable, false);
  assert.match(coordinator.getStatus().reason, /^degraded:/);
  assert.equal(
    validationFailureCalls - validationFailureCallsBeforeRebuild,
    1
  );

  const degradedValidationEntered = deferredPromise<void>();
  const finishDegradedValidation = deferredPromise<void>();
  validate = async () => {
    degradedValidationEntered.resolve();
    await finishDegradedValidation.promise;
    return { valid: true as const, meta: persistedMeta };
  };
  const releaseDegradedMutation = coordinator.beginPlannedMutation(2);
  assert.equal(releaseDegradedMutation(false), false);
  await degradedValidationEntered.promise;
  assert.equal(coordinator.getStatus().readable, false);
  finishDegradedValidation.resolve();
  assert.equal((await coordinator.ensureCurrent()).appliedRevision, "3");
  assert.equal(coordinator.getStatus().readable, true);

  revision = "4";
  persistedMeta = readyCacheMeta("4");
  const finalRebuildEntered = deferredPromise<void>();
  const finishFinalRebuild = deferredPromise<ReturnType<typeof readyCacheMeta>>();
  rebuild = async () => {
    rebuildCalls += 1;
    finalRebuildEntered.resolve();
    return finishFinalRebuild.promise;
  };
  const finalRebuild = coordinator.requestRebuild();
  await finalRebuildEntered.promise;
  const lateJoinStarted = deferredPromise<
    ReturnType<typeof coordinator.requestRebuild>
  >();
  finishFinalRebuild.resolve(persistedMeta);
  queueMicrotask(() => queueMicrotask(() => {
    lateJoinStarted.resolve(coordinator.requestRebuild());
  }));
  const lateJoin = await lateJoinStarted.promise;
  assert.equal(coordinator.getStatus().readable, true);
  assert.equal(coordinator.getStatus().rebuilding, false);
  const [finalMeta, lateMeta] = await Promise.all([finalRebuild, lateJoin]);
  assert.equal(finalMeta.appliedRevision, "4");
  assert.equal(lateMeta.appliedRevision, "4");
  assert.equal(coordinator.getStatus().readable, true);
  assert.equal(coordinator.getStatus().rebuilding, false);
  coordinator.completeMutation(readyCacheMeta("5"));
  assert.equal(coordinator.getStatus().meta?.appliedRevision, "5");
  assert.equal(coordinator.getStatus().readable, true);

  const shutdownRebuild = deferredPromise<ReturnType<typeof readyCacheMeta>>();
  rebuild = async ({ signal } = {}) => {
    rebuildCalls += 1;
    const meta = await shutdownRebuild.promise;
    signal?.throwIfAborted();
    return meta;
  };
  const activeRebuild = coordinator.requestRebuild();
  const activeRebuildRejected = assert.rejects(
    activeRebuild,
    /Ready-image cache coordinator stopped/
  );
  await delay(0);
  const releaseAfterStop = coordinator.beginPlannedMutation(1);
  const stopping = coordinator.stop();
  shutdownRebuild.resolve(readyCacheMeta("5"));
  await activeRebuildRejected;
  await stopping;
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().reason, "stopped");
  assert.equal(releaseAfterStop(false), false);
  assert.equal(coordinator.getStatus().readable, false);
  assert.equal(coordinator.getStatus().reason, "stopped");
  await assert.rejects(
    coordinator.requestRebuild(),
    /Ready-image cache coordinator is stopped/
  );
});
test("[Server/缓存与 Redis] ready cache 管理状态以固定读取恢复数量、进度与完整重建时间", async () => {
  const meta = readyCacheMeta("8");
  const preservedRebuildSnapshot = rebuildingReadyImageCacheMeta(
    "8",
    "2026-08-11T00:00:01.000Z",
    meta
  );
  assert.equal(
    preservedRebuildSnapshot.lastFullRebuildCoreMemoryBytes,
    meta.lastFullRebuildCoreMemoryBytes
  );
  assert.equal(
    preservedRebuildSnapshot.lastFullRebuildMeasuredAt,
    meta.lastFullRebuildMeasuredAt
  );
  assert.equal(preservedRebuildSnapshot.fullRebuildCompletedAt, "");
  const recentCoreError = {
    category: "core" as const,
    code: "controlled_error",
    message: "controlled cache error",
    occurred_at: "2026-08-11T00:00:03.000Z"
  };
  const status = await readReadyImageCacheAdminStatus("8", {
    getCoordinatorStatus: () => ({
      initialized: true,
      readable: true,
      rebuilding: false,
      reason: "ready",
      meta
    }),
    getRevision: async () => ({
      revision: "8",
      updatedAt: "2026-08-11T00:00:00.000Z"
    }),
    readMeta: async () => meta,
    recentErrors: () => ({ core: recentCoreError, derived: null })
  });

  assert.deepEqual(Object.keys(status).sort(), [
    "applied_revision",
    "authoritative_revision",
    "full_rebuild_completed_at",
    "full_rebuild_duration_ms",
    "full_rebuild_started_at",
    "item_count",
    "last_full_rebuild_core_memory_bytes",
    "last_full_rebuild_measured_at",
    "last_updated_at",
    "processed",
    "readable",
    "reason",
    "rebuilding",
    "recent_errors",
    "state",
    "synchronized",
    "total"
  ]);
  assert.equal(status.synchronized, true);
  assert.equal(status.applied_revision, "8");
  assert.equal(status.item_count, 1);
  assert.equal(status.processed, null);
  assert.equal(status.total, null);
  assert.equal(status.last_updated_at, meta.lastUpdatedAt);
  assert.equal(status.full_rebuild_started_at, meta.fullRebuildStartedAt);
  assert.equal(status.full_rebuild_completed_at, meta.fullRebuildCompletedAt);
  assert.equal(status.full_rebuild_duration_ms, 1_000);
  assert.equal(
    status.last_full_rebuild_core_memory_bytes,
    meta.lastFullRebuildCoreMemoryBytes
  );
  assert.equal(
    status.last_full_rebuild_measured_at,
    meta.lastFullRebuildMeasuredAt
  );
  assert.deepEqual(status.recent_errors, {
    core: recentCoreError,
    derived: null
  });

  const rebuildingMeta = {
    ...meta,
    state: "rebuilding" as const,
    itemCount: 7,
    lastUpdatedAt: "2026-08-11T00:00:04.000Z",
    fullRebuildStartedAt: "2026-08-11T00:00:01.000Z",
    fullRebuildCompletedAt: "",
    processed: 7,
    total: 12
  };
  let persistedReads = 0;
  const rebuilding = await readReadyImageCacheAdminStatus("9", {
    getCoordinatorStatus: () => ({
      initialized: true,
      readable: false,
      rebuilding: true,
      reason: "rebuilding",
      meta
    }),
    getRevision: async () => ({
      revision: "9",
      updatedAt: "2026-08-11T00:00:00.000Z"
    }),
    readMeta: async () => {
      persistedReads += 1;
      return rebuildingMeta;
    },
    recentErrors: () => ({ core: null, derived: null })
  });
  assert.equal(persistedReads, 1);
  assert.equal(rebuilding.item_count, 7);
  assert.equal(rebuilding.processed, 7);
  assert.equal(rebuilding.total, 12);
  assert.equal(rebuilding.full_rebuild_completed_at, null);
  assert.equal(rebuilding.full_rebuild_duration_ms, null);

  const healthyWithCorruptPersisted = await readReadyImageCacheAdminStatus(
    "8",
    {
      getCoordinatorStatus: () => ({
        initialized: true,
        readable: true,
        rebuilding: false,
        reason: "ready",
        meta
      }),
      getRevision: async () => ({
        revision: "8",
        updatedAt: "2026-08-11T00:00:00.000Z"
      }),
      readMeta: async () => {
        throw new Error("controlled corrupt persisted meta");
      },
      recentErrors: () => ({ core: null, derived: null })
    }
  );
  assert.equal(healthyWithCorruptPersisted.synchronized, false);
  assert.equal(healthyWithCorruptPersisted.state, "unavailable");
  assert.equal(healthyWithCorruptPersisted.item_count, null);

  const missingPersisted = await readReadyImageCacheAdminStatus("9", {
    getCoordinatorStatus: () => ({
      initialized: true,
      readable: false,
      rebuilding: true,
      reason: "rebuilding",
      meta
    }),
    getRevision: async () => ({
      revision: "9",
      updatedAt: "2026-08-11T00:00:00.000Z"
    }),
    readMeta: async () => {
      throw new Error("controlled corrupt persisted meta");
    },
    recentErrors: () => ({ core: null, derived: null })
  });
  assert.equal(missingPersisted.item_count, null);
  assert.equal(missingPersisted.last_updated_at, null);
  assert.equal(missingPersisted.full_rebuild_started_at, null);
  assert.equal(missingPersisted.last_full_rebuild_core_memory_bytes, null);
  assert.equal(missingPersisted.last_full_rebuild_measured_at, null);
});
test("[Server/缓存与 Redis] 概览以固定核心键准确测量当前 Redis 占用并在并发与失败时收敛", async () => {
  const commands: unknown[][] = [];
  let scanCalls = 0;
  const redisClient = {
    scan: async () => {
      scanCalls += 1;
      return ["0", []];
    },
    pipeline: () => {
      const pipelineCommands: unknown[][] = [];
      return {
        call: (...command: unknown[]) => {
          pipelineCommands.push(command);
        },
        exec: async () => {
          commands.push(...pipelineCommands);
          return pipelineCommands.map((_, index) => [null, index + 1]);
        }
      };
    }
  };
  assert.equal(
    await measureReadyImageCoreMemory(redisClient as never),
    READY_IMAGE_CORE_KEYS.length * (READY_IMAGE_CORE_KEYS.length + 1) / 2
  );
  assert.equal(scanCalls, 0);
  assert.deepEqual(commands, READY_IMAGE_CORE_KEYS.map((key) => [
    "MEMORY",
    "USAGE",
    key,
    "SAMPLES",
    "0"
  ]));

  const meta = readyCacheMeta("18");
  const statusDependencies = {
    getCoordinatorStatus: () => ({
      initialized: true,
      readable: true,
      rebuilding: false,
      reason: "ready" as const,
      meta
    }),
    getRevision: async () => ({
      revision: "18",
      updatedAt: "2026-08-15T03:00:00.000Z"
    }),
    readMeta: async () => meta,
    recentErrors: () => ({ core: null, derived: null })
  };
  let releaseMeasurement!: () => void;
  const measurementGate = new Promise<void>((resolve) => {
    releaseMeasurement = resolve;
  });
  let measurementCalls = 0;
  const measurementDependencies = {
    measureCoreMemory: async () => {
      measurementCalls += 1;
      await measurementGate;
      return 12_345;
    },
    now: () => new Date("2026-08-15T03:00:00.000Z")
  };
  const first = getReadyImageCacheOverviewStatus(
    statusDependencies,
    measurementDependencies
  );
  const second = getReadyImageCacheOverviewStatus(
    statusDependencies,
    measurementDependencies
  );
  releaseMeasurement();
  const concurrentOverviews = await Promise.all([first, second]);
  assert.equal(measurementCalls, 1, "并发概览必须共用同一准确测量 Promise");
  assert.deepEqual(concurrentOverviews.map((item) => ({
    current_core_memory_bytes: item.current_core_memory_bytes,
    current_core_measured_at: item.current_core_measured_at
  })), [
    {
      current_core_memory_bytes: 12_345,
      current_core_measured_at: "2026-08-15T03:00:00.000Z"
    },
    {
      current_core_memory_bytes: 12_345,
      current_core_measured_at: "2026-08-15T03:00:00.000Z"
    }
  ]);
  const overview = await getReadyImageCacheOverviewStatus(
    statusDependencies,
    {
      measureCoreMemory: async () => 54_321,
      now: () => new Date("2026-08-15T03:01:00.000Z")
    }
  );
  assert.deepEqual(overview, {
    state: "ready",
    synchronized: true,
    rebuilding: false,
    item_count: meta.itemCount,
    current_core_memory_bytes: 54_321,
    current_core_measured_at: "2026-08-15T03:01:00.000Z",
    last_full_rebuild_core_memory_bytes:
      meta.lastFullRebuildCoreMemoryBytes,
    last_full_rebuild_measured_at: meta.lastFullRebuildMeasuredAt
  });

  const failedMeasurement = await getReadyImageCacheOverviewStatus(
    statusDependencies,
    {
      measureCoreMemory: async () => {
        throw new Error("controlled MEMORY USAGE failure");
      },
      now: () => new Date("2026-08-15T03:02:00.000Z")
    }
  );
  assert.equal(failedMeasurement.state, "ready");
  assert.equal(failedMeasurement.item_count, meta.itemCount);
  assert.equal(failedMeasurement.current_core_memory_bytes, null);
  assert.equal(failedMeasurement.current_core_measured_at, null);
  assert.equal(
    failedMeasurement.last_full_rebuild_core_memory_bytes,
    meta.lastFullRebuildCoreMemoryBytes,
    "当前测量失败不得抹掉明确标注的历史完整重建快照"
  );
});
test("[Server/缓存与 Redis] Redis 手动深检保持截止时间、键上限、批次和取消边界", async () => {
  type MeasuredKey = readonly [string, number, number];
  const measurements = new Map<string, MeasuredKey>([
    ["imageshow:cache:images:meta", ["hash", 10, 12]],
    ["imageshow:cache:images:items", ["hash", 20, 3]],
    ["imageshow:cache:images:derived:filter:a", ["zset", 30, 2]]
  ]);
  const pipelineSizes: number[] = [];
  const scanPages = new Map<string, [string, string[]]>([
    ["0", ["1", [
      "imageshow:cache:images:meta",
      "imageshow:cache:images:items",
      "imageshow:cache:images:meta"
    ]]],
    ["1", ["0", [
      "imageshow:cache:images:derived:filter:a",
      "imageshow:other"
    ]]]
  ]);
  const client = {
    scan: async (cursor: string) => scanPages.get(cursor) ?? ["0", []],
    pipeline: () => {
      const keys: string[] = [];
      return {
        eval: (_script: string, _keyCount: number, key: string) => {
          keys.push(key);
        },
        exec: async () => {
          pipelineSizes.push(keys.length);
          return keys.map((key) => [
            null,
            measurements.get(key) ?? ["none", 0, 0]
          ]);
        }
      };
    }
  };
  const complete = await inspectRedisKeyspaceDeep({
    client: client as never,
    deadlineMs: 1_000,
    maxKeys: 10,
    pipelineMaxCommands: 2,
    now: () => new Date("2026-08-11T00:00:05.000Z")
  });
  assert.deepEqual(complete, {
    source: "deep",
    measured_at: "2026-08-11T00:00:05.000Z",
    complete: true,
    scanned_keys: 4,
    prefix_counts: {
      imageshow_total: 4,
      ready_image_cache: 3,
      ready_image_indexes: 0,
      ready_image_index_meta: 0,
      ready_image_filters: 1,
      ready_image_filter_meta: 0,
      ready_image_stats_results: 0,
      original_direct_cache: 0,
      sessions: 0,
      login_failures: 0,
      temporary: 0,
      other: 1
    },
    image_projection_usage: {
      core: { key_count: 2, member_count: 15, memory_bytes: 30 },
      derived: { key_count: 1, member_count: 2, memory_bytes: 30 }
    }
  });
  assert.ok(pipelineSizes.every((size) => size <= 2));

  const limited = await inspectRedisKeyspaceDeep({
    client: {
      ...client,
      scan: async () => ["0", [
        "imageshow:cache:images:meta",
        "imageshow:cache:images:items",
        "imageshow:cache:images:derived:filter:a"
      ]]
    } as never,
    deadlineMs: 1_000,
    maxKeys: 2,
    pipelineMaxCommands: 2
  });
  assert.equal(limited.complete, false);
  if (limited.complete) assert.fail("key-limited inspection must be partial");
  assert.equal(limited.reason, "max_keys");
  assert.equal(limited.scanned_keys, 2);
  assert.equal(limited.image_projection_usage.derived.key_count, 0);

  const pendingScan = deferredPromise<[string, string[]]>();
  let pendingScanCalls = 0;
  let pendingPipelineCalls = 0;
  const slowClient = {
    scan: async () => {
      pendingScanCalls += 1;
      return pendingScan.promise;
    },
    pipeline: () => {
      pendingPipelineCalls += 1;
      return { eval: () => undefined, exec: async () => [] };
    }
  };
  const timedOut = await inspectRedisKeyspaceDeep({
    client: slowClient as never,
    deadlineMs: 5,
    maxKeys: 10,
    pipelineMaxCommands: 2
  });
  assert.equal(timedOut.complete, false);
  if (timedOut.complete) assert.fail("deadline inspection must be partial");
  assert.equal(timedOut.reason, "deadline");
  assert.equal(timedOut.scanned_keys, 0);
  assert.equal(pendingScanCalls, 1);
  assert.equal(pendingPipelineCalls, 0);

  const abortScan = deferredPromise<[string, string[]]>();
  const abortController = new AbortController();
  const aborted = inspectRedisKeyspaceDeep({
    client: {
      scan: async () => abortScan.promise,
      pipeline: () => ({ eval: () => undefined, exec: async () => [] })
    } as never,
    signal: abortController.signal,
    deadlineMs: 1_000,
    maxKeys: 10,
    pipelineMaxCommands: 2
  });
  const abortReason = new Error("controlled request abort");
  abortController.abort(abortReason);
  await assert.rejects(aborted, (error: Error) => error === abortReason);

  await assert.rejects(
    inspectRedisKeyspaceDeep({
      client: client as never,
      deadlineMs: 0
    }),
    /deadlineMs must be an integer/
  );
  await assert.rejects(
    inspectRedisKeyspaceDeep({
      client: client as never,
      maxKeys: 1_000_001
    }),
    /maxKeys must be an integer/
  );
  await assert.rejects(
    inspectRedisKeyspaceDeep({
      client: client as never,
      pipelineMaxCommands: 1_001
    }),
    /pipelineMaxCommands must be an integer/
  );
});
test("[Server/缓存与 Redis] Redis 窗口与 ready-image 脚本各归所属边界并严格解析返回值", async () => {
  const redisScripts = {
    ...redisWindowScripts,
    ...readyImageRedisScripts
  };
  const registrationOrder: string[] = [];
  const registrar = {
    options: {
      scripts: {
        retainedTestCommand: {
          lua: "return 1",
          readOnly: true
        }
      }
    },
    defineCommand(name: string) {
      registrationOrder.push(`define:${name}`);
      Object.assign(registrar, {
        [name]: async () => {
          registrationOrder.push(`call:${name}`);
          return name === "imageshowReserveWindows"
            ? [1, 1, 1, 30]
            : name === "imageshowSampleReadyImageCoreIndex"
              ? [2, 0]
              : 1;
        }
      });
    }
  };
  assert.deepEqual(await reserveRedisWindowsCommand(registrar as never, [
    { key: "registration:window", capacity: 1, windowSeconds: 30 }
  ]), [{
    attempted: true,
    allowed: true,
    value: 1,
    retryAfterSeconds: 30
  }]);
  assert.deepEqual(await sampleReadyImageCoreIndexCommand(
    registrar as never,
    {
      keys: ["meta", "integrity", "index", "items"],
      revision: "1",
      count: 0,
      bounds: {
        limit: 1,
        recentSize: 0,
        historySize: 30,
        maximumLimit: 200
      }
    }
  ), { status: "empty", pairs: [] });
  registerRedisWindowCommand(registrar as never);
  registerRedisWindowCommand(registrar as never);
  registerReadyImageRedisCommands(registrar as never);
  registerReadyImageRedisCommands(registrar as never);
  assert.deepEqual(
    registrationOrder.filter((entry) => entry.startsWith("define:")).sort(),
    Object.keys(redisScripts).map((name) => `define:${name}`).sort()
  );
  assert.ok(
    registrationOrder.indexOf("define:imageshowReserveWindows")
      < registrationOrder.indexOf("call:imageshowReserveWindows")
  );
  assert.ok(
    registrationOrder.indexOf("define:imageshowSampleReadyImageCoreIndex")
      < registrationOrder.indexOf("call:imageshowSampleReadyImageCoreIndex")
  );
  assert.deepEqual(
    new Set(Object.keys(registrar.options.scripts)),
    new Set(["retainedTestCommand", ...Object.keys(redisScripts)])
  );

  const windowCalls: unknown[][] = [];
  const windowClient = {
    async imageshowReserveWindows(...arguments_: unknown[]) {
      windowCalls.push(arguments_);
      return [1, 1, 1, 30, 0, 5, 0, 12];
    }
  } satisfies RedisWindowCommandClient;
  assert.deepEqual(await reserveRedisWindowsCommand(windowClient, [
    { key: "login:user", capacity: 3, windowSeconds: 30 },
    { key: "login:global", capacity: 5, windowSeconds: 60 }
  ]), [
    {
      attempted: true,
      allowed: true,
      value: 1,
      retryAfterSeconds: 30
    },
    {
      attempted: true,
      allowed: false,
      value: 5,
      retryAfterSeconds: 12
    }
  ]);
  assert.deepEqual(windowCalls, [[
    "2",
    "login:user",
    "login:global",
    "3",
    "30",
    "5",
    "60"
  ]]);
  await assert.rejects(
    reserveRedisWindowsCommand({
      async imageshowReserveWindows() { return [1, 1, 0, 30]; }
    }, [{ key: "broken", capacity: 1, windowSeconds: 30 }]),
    /inconsistent state/
  );
  await assert.rejects(
    reserveRedisWindowsCommand({
      async imageshowReserveWindows() { return []; }
    }, [{ key: "broken", capacity: 1, windowSeconds: 30 }]),
    /invalid result count/
  );

  const registry = {
    keys: ["registry:lru", "registry:counts", "registry:kinds", "registry:signatures"],
    ttlSeconds: 300,
    maxResults: 50,
    attributeIndexPrefix: "derived:index:",
    attributeAxisSuffixes: ["axis:pc:dark", "axis:mb:light"],
    namedAttributeKinds: ["theme", "tag", "author"],
    attributeSlugMaxLength: 63,
    filterKeyPrefix: "derived:filter:",
    statsResultKeyPrefix: "derived:stats:",
    maxResultMembers: 1_000,
    minimumTotalMembers: 500,
    totalMemberMultiplier: 4,
    maxActiveSignatures: 20,
    maxStatsResultBytes: 16_384
  } as const satisfies RedisDerivedRegistryCommandConfig;
  const indexedCalls: unknown[][] = [];
  const indexedReplies = [1, -1, "unexpected"];
  const indexedClient = {
    async imageshowTouchReadyImageIndexedResult(...arguments_: unknown[]) {
      indexedCalls.push(arguments_);
      return indexedReplies.shift();
    }
  } satisfies RedisIndexedTouchCommandClient;
  const indexedInput = {
    descriptor: {
      key: "derived:index:theme:night",
      kind: "attribute" as const,
      metaKey: "derived:index-meta:theme:night",
      signature: null
    },
    registry,
    revision: "42",
    count: 2,
    itemCount: 10,
    instanceToken: "a".repeat(32),
    accessedAt: "2026-08-21T00:00:00.000Z",
    accessScore: 123
  };
  assert.equal(
    await touchReadyImageIndexedResultCommand(indexedClient, indexedInput),
    1
  );
  assert.equal(
    await touchReadyImageIndexedResultCommand(indexedClient, indexedInput),
    -1
  );
  assert.equal(
    await touchReadyImageIndexedResultCommand(indexedClient, indexedInput),
    0
  );
  assert.deepEqual(indexedCalls[0], [
    "derived:index:theme:night",
    "derived:index-meta:theme:night",
    ...registry.keys,
    "derived:index:theme:night",
    "2",
    "42",
    "2026-08-21T00:00:00.000Z",
    "300",
    "a".repeat(32),
    "5",
    "attribute",
    "",
    "123",
    "50",
    "10",
    "derived:index:",
    "axis:pc:dark,axis:mb:light",
    "theme,tag,author",
    "63",
    "derived:filter:",
    "derived:stats:",
    "1000",
    "500",
    "4",
    "20",
    "16384"
  ]);

  const statsCalls: unknown[][] = [];
  const statsClient = {
    async imageshowTouchReadyImageStatsResult(...arguments_: unknown[]) {
      statsCalls.push(arguments_);
      return 1;
    }
  } satisfies RedisStatsTouchCommandClient;
  assert.equal(await touchReadyImageStatsResultCommand(statsClient, {
    descriptor: {
      key: "derived:stats:" + "b".repeat(64),
      kind: "stats-result",
      metaKey: null,
      signature: "b".repeat(64)
    },
    registry,
    serialized: "{\"count\":2}",
    itemCount: 10,
    accessScore: 124
  }), 1);
  assert.deepEqual(statsCalls[0], [
    "derived:stats:" + "b".repeat(64),
    "derived:stats:" + "b".repeat(64),
    ...registry.keys,
    "derived:stats:" + "b".repeat(64),
    "{\"count\":2}",
    "300",
    "b".repeat(64),
    "124",
    "50",
    "10",
    "derived:index:",
    "axis:pc:dark,axis:mb:light",
    "theme,tag,author",
    "63",
    "derived:filter:",
    "derived:stats:",
    "1000",
    "500",
    "4",
    "20",
    "16384"
  ]);

  const filterCalls: unknown[][] = [];
  const removedDestinations: string[] = [];
  const filterReplies: unknown[] = [
    [1, 3, 1, 3],
    "invalid",
    [0, 1, 7]
  ];
  const filterClient = {
    async imageshowStoreReadyImageFilterSet(...arguments_: unknown[]) {
      filterCalls.push(arguments_);
      return filterReplies.shift();
    },
    async unlink(...keys: string[]) {
      removedDestinations.push(...keys);
      return keys.length;
    }
  } satisfies RedisFilterSetCommandClient;
  const filterInput = {
    command: "zunionstore" as const,
    destination: "derived:temporary",
    sources: [
      { key: "source:first", count: 2 },
      { key: "source:second", count: 2 }
    ],
    expectedMembers: 3,
    temporaryTtlSeconds: 60
  };
  assert.equal(
    await storeReadyImageFilterSetCommand(filterClient, filterInput),
    3
  );
  assert.deepEqual(filterCalls[0], [
    "3",
    "source:first",
    "source:second",
    "derived:temporary",
    "2",
    "2",
    "ZUNIONSTORE",
    "3",
    "60"
  ]);
  await assert.rejects(
    storeReadyImageFilterSetCommand(filterClient, filterInput),
    /returned invalid data/
  );
  assert.deepEqual(removedDestinations, ["derived:temporary"]);
  await assert.rejects(
    storeReadyImageFilterSetCommand(filterClient, filterInput),
    /source changed during build/
  );
  assert.deepEqual(removedDestinations, ["derived:temporary"]);

  const attributeCalls: unknown[][] = [];
  const attributeClient = {
    async imageshowPublishReadyImageAttributeIndex(...arguments_: unknown[]) {
      attributeCalls.push(arguments_);
      return attributeCalls.length === 1 ? 1 : 0;
    }
  } satisfies RedisAttributePublishCommandClient;
  const attributeInput = {
    key: "derived:index:theme:night",
    metaKey: "derived:index-meta:theme:night",
    temporaryKey: "derived:temp:index",
    count: 2,
    revision: "42",
    now: "2026-08-21T00:00:00.000Z",
    instanceToken: "c".repeat(32),
    ttlSeconds: 300
  };
  assert.equal(
    await publishReadyImageAttributeIndexCommand(
      attributeClient,
      attributeInput
    ),
    true
  );
  assert.equal(
    await publishReadyImageAttributeIndexCommand(
      attributeClient,
      attributeInput
    ),
    false
  );
  assert.deepEqual(attributeCalls[0], [
    "derived:index:theme:night",
    "derived:index-meta:theme:night",
    "derived:temp:index",
    "2",
    "42",
    "2026-08-21T00:00:00.000Z",
    "2026-08-21T00:00:00.000Z",
    "c".repeat(32),
    "300"
  ]);

  const coreSampleCalls: unknown[][] = [];
  const coreSampleClient = {
    async imageshowSampleReadyImageCoreIndex(...arguments_: unknown[]) {
      coreSampleCalls.push(arguments_);
      return [
        1,
        2,
        "image:first",
        "{\"id\":\"first\"}",
        "image:second",
        "{\"id\":\"second\"}"
      ];
    }
  } satisfies RedisReadyImageCoreSampleCommandClient;
  assert.deepEqual(await sampleReadyImageCoreIndexCommand(coreSampleClient, {
    keys: ["core:meta", "core:integrity", "core:index", "core:items"],
    revision: "42",
    count: 2,
    bounds: { limit: 2, recentSize: 0, historySize: 30, maximumLimit: 200 }
  }), {
    status: "ok",
    pairs: [
      { member: "image:first", value: "{\"id\":\"first\"}" },
      { member: "image:second", value: "{\"id\":\"second\"}" }
    ]
  });
  assert.deepEqual(coreSampleCalls, [[
    "core:meta",
    "core:integrity",
    "core:index",
    "core:items",
    "42",
    "2",
    "2",
    "0",
    "30",
    "200"
  ]]);

  const derivedSampleCalls: unknown[][] = [];
  const derivedSampleClient = {
    async imageshowSampleReadyImageDerivedIndex(...arguments_: unknown[]) {
      derivedSampleCalls.push(arguments_);
      return [
        -7,
        2,
        "image:missing",
        null,
        "image:retained",
        "{\"id\":\"retained\"}"
      ];
    }
  } satisfies RedisReadyImageDerivedSampleCommandClient;
  assert.deepEqual(await sampleReadyImageDerivedIndexCommand(
    derivedSampleClient,
    {
      keys: [
        "core:meta",
        "core:integrity",
        "core:index",
        "core:items",
        "derived:index",
        "derived:meta"
      ],
      kind: "filter",
      revision: "42",
      coreCount: 10,
      indexCount: 2,
      instanceToken: "d".repeat(32),
      maximumIndexMembers: 1_000,
      bounds: { limit: 2, recentSize: 0, historySize: 30, maximumLimit: 200 }
    }
  ), {
    status: "derived_missing_item",
    pairs: [
      { member: "image:missing", value: null },
      { member: "image:retained", value: "{\"id\":\"retained\"}" }
    ]
  });
  assert.deepEqual(derivedSampleCalls, [[
    "core:meta",
    "core:integrity",
    "core:index",
    "core:items",
    "derived:index",
    "derived:meta",
    "42",
    "10",
    "2",
    "d".repeat(32),
    "filter",
    "2",
    "0",
    "30",
    "200",
    "1000"
  ]]);
  await assert.rejects(
    sampleReadyImageCoreIndexCommand({
      async imageshowSampleReadyImageCoreIndex() {
        return [1, 1, "image:missing", null];
      }
    }, {
      keys: ["core:meta", "core:integrity", "core:index", "core:items"],
      revision: "42",
      count: 1,
      bounds: { limit: 1, recentSize: 0, historySize: 0, maximumLimit: 200 }
    }),
    /inconsistent items/
  );
});
test("[Server/缓存与 Redis] ready 随机抽样边界只调用一次 Redis 并保留近期排序", async () => {
  const samplingIds = [
    imageId,
    "019f8457-063a-7002-a580-7a432dc7fd8e",
    "019f8457-063a-7002-a580-7a432dc7fd8f",
    "019f8457-063a-7002-a580-7a432dc7fd90"
  ];
  const samplingItems = samplingIds.map((id, position) => (
    servingReadyCacheItem({
      id,
      object_key: storageObjectKey(id, "jpg"),
      sort_score: String(position + 1)
    })
  ));
  const coreCalls: unknown[] = [];
  let derivedCalls = 0;
  let revisionReads = 0;
  const coreDependencies = {
    currentRevision: () => {
      revisionReads += 1;
      return "42";
    },
    coreCount: () => {
      throw new Error("Core sampling must not request a derived count");
    },
    sampleCore: async (input) => {
      coreCalls.push(input);
      return {
        status: "ok" as const,
        pairs: samplingItems.map((item) => ({
          member: readyImageMember(item.id),
          value: serializeReadyImageCacheItem(item)
        }))
      };
    },
    sampleDerived: async () => {
      derivedCalls += 1;
      throw new Error("Core sampling must not call the derived command");
    }
  } satisfies ReadyImageSampleDependencies;
  const sampled = await sampleResolvedReadyImageIndex(
    {
      kind: "core",
      key: "core:index",
      revision: "42",
      count: samplingItems.length,
      metaKey: null,
      instanceToken: null
    },
    3,
    new Set([samplingIds[0]!, samplingIds[2]!]),
    coreDependencies
  );
  assert.deepEqual(sampled, [
    samplingItems[1],
    samplingItems[3],
    samplingItems[0]
  ]);
  assert.equal(coreCalls.length, 1);
  assert.equal(derivedCalls, 0);
  assert.equal(revisionReads, 2);

  let tokenReplacementCalls = 0;
  const tokenReplacementDependencies = {
    currentRevision: () => "42",
    coreCount: () => samplingItems.length,
    sampleCore: async () => {
      throw new Error("Derived sampling must not call the core command");
    },
    sampleDerived: async () => {
      tokenReplacementCalls += 1;
      return { status: "token_changed" as const, pairs: [] };
    }
  } satisfies ReadyImageSampleDependencies;
  assert.equal(await sampleResolvedReadyImageIndex(
    {
      kind: "filter",
      key: "derived:index",
      revision: "42",
      count: 2,
      metaKey: "derived:meta",
      instanceToken: "d".repeat(32)
    },
    1,
    new Set(),
    tokenReplacementDependencies
  ), null);
  assert.equal(tokenReplacementCalls, 1);
});
test("[Server/缓存与 Redis] Redis 原生条件字符串命令严格解析替换、续期与部分批次结果", async () => {
  const commandCalls: string[][] = [];
  const replies: unknown[] = ["OK", null, "OK", null, 1, 0];
  const commandClient = {
    async call(command: string, ...arguments_: string[]) {
      commandCalls.push([command, ...arguments_]);
      return replies.shift();
    }
  };
  assert.equal(await replaceRedisStringIfEqualKeepingTtl(
    commandClient,
    "session",
    "before",
    "after"
  ), true);
  assert.equal(await replaceRedisStringIfEqualKeepingTtl(
    commandClient,
    "session",
    "stale",
    "unexpected"
  ), false);
  assert.equal(await refreshRedisStringTtlIfEqual(
    commandClient,
    "session",
    "after",
    300
  ), true);
  assert.equal(await refreshRedisStringTtlIfEqual(
    commandClient,
    "missing",
    "after",
    480
  ), false);
  assert.equal(await deleteRedisStringIfEqual(
    commandClient,
    "session",
    "after"
  ), true);
  assert.equal(await deleteRedisStringIfEqual(
    commandClient,
    "missing",
    "after"
  ), false);
  assert.deepEqual(commandCalls, [
    ["SET", "session", "after", "IFEQ", "before", "KEEPTTL"],
    ["SET", "session", "unexpected", "IFEQ", "stale", "KEEPTTL"],
    ["SET", "session", "after", "IFEQ", "after", "EX", "300"],
    ["SET", "missing", "after", "IFEQ", "after", "EX", "480"],
    ["DELEX", "session", "IFEQ", "after"],
    ["DELEX", "missing", "IFEQ", "after"]
  ]);
  assert.equal(parseRedisSetIfEqualReply("OK"), true);
  assert.equal(parseRedisSetIfEqualReply(null), false);
  assert.equal(parseRedisDeleteIfEqualReply(1), true);
  assert.equal(parseRedisDeleteIfEqualReply(0), false);
  assert.throws(() => parseRedisSetIfEqualReply(1), /invalid result/);
  assert.throws(() => parseRedisDeleteIfEqualReply("1"), /invalid result/);

  const pipelineCalls: string[][] = [];
  const snapshots = [
    { key: "first", value: "one" },
    { key: "raced", value: "old" },
    { key: "third", value: "three" }
  ];
  const partialClient = {
    pipeline: () => ({
      call(command: string, ...arguments_: string[]) {
        pipelineCalls.push([command, ...arguments_]);
      },
      async exec(): Promise<Array<[Error | null, unknown]>> {
        return [[null, 1], [null, 0], [null, 1]];
      }
    })
  };
  assert.deepEqual(
    await deleteRedisStringsIfEqual(partialClient, snapshots),
    [snapshots[0], snapshots[2]]
  );
  assert.deepEqual(pipelineCalls, [
    ["DELEX", "first", "IFEQ", "one"],
    ["DELEX", "raced", "IFEQ", "old"],
    ["DELEX", "third", "IFEQ", "three"]
  ]);

  const pipelineFailure = new Error("controlled DELEX failure");
  await assert.rejects(
    deleteRedisStringsIfEqual({
      pipeline: () => ({
        call() {},
        async exec(): Promise<Array<[Error | null, unknown]>> {
          return [[pipelineFailure, null]];
        }
      })
    }, [{ key: "first", value: "one" }]),
    (error: Error) => error === pipelineFailure
  );
  await assert.rejects(
    deleteRedisStringsIfEqual({
      pipeline: () => ({
        call() {},
        async exec(): Promise<Array<[Error | null, unknown]>> {
          return [[null, 2]];
        }
      })
    }, [{ key: "first", value: "one" }]),
    /invalid result/
  );
  await assert.rejects(
    deleteRedisStringsIfEqual({
      pipeline: () => ({
        call() {},
        async exec(): Promise<Array<[Error | null, unknown]>> {
          return [];
        }
      })
    }, [{ key: "first", value: "one" }]),
    /invalid result count/
  );
});
test("[Server/缓存与 Redis] Redis 必需能力探针验证条件成功、失败、缺失与 TTL 保留", async () => {
  const successfulResults = (): Array<[Error | null, unknown]> => [
    [null, 1],
    [null, 1],
    [null, ["imageshow-required-command-probe"]],
    [null, "OK"],
    [null, 5_000],
    [null, "OK"],
    [null, 4_999],
    [null, null],
    [null, "after"],
    [null, null],
    [null, 0],
    [null, "OK"],
    [null, 0],
    [null, "owned"],
    [null, 1],
    [null, 0],
    [null, 0],
    [null, 4]
  ];
  const probeClient = (results: Array<[Error | null, unknown]>) => {
    const commands: string[][] = [];
    return {
      commands,
      client: {
        async call(command: string, ...arguments_: string[]) {
          commands.push([command, ...arguments_]);
          return [0, 1];
        },
        pipeline: () => ({
          call(command: string, ...arguments_: string[]) {
            commands.push([command, ...arguments_]);
          },
          async exec() {
            return results;
          }
        })
      }
    };
  };

  const successful = probeClient(successfulResults());
  assert.deepEqual(
    await readRequiredRedisCommandCapabilities(successful.client as never),
    {
      available: true,
      commands: {
        INCREX: true,
        ARRING: true,
        ARLASTITEMS: true,
        SET_IFEQ_KEEPTTL: true,
        DELEX_IFEQ: true
      },
      missing: []
    }
  );
  assert.deepEqual(successful.commands.map(([command]) => command), [
    "INCREX",
    "ARRING",
    "EXPIRE",
    "ARLASTITEMS",
    "SET",
    "PTTL",
    "SET",
    "PTTL",
    "SET",
    "GET",
    "SET",
    "EXISTS",
    "SET",
    "DELEX",
    "GET",
    "DELEX",
    "EXISTS",
    "DELEX",
    "UNLINK"
  ]);
  assert.deepEqual(successful.commands[6]?.slice(-3), [
    "IFEQ",
    "before",
    "KEEPTTL"
  ]);

  const invalidResults = successfulResults();
  invalidResults[6] = [null, -1];
  invalidResults[12] = [null, "0"];
  const invalid = probeClient(invalidResults);
  assert.deepEqual(
    await readRequiredRedisCommandCapabilities(invalid.client as never),
    {
      available: false,
      commands: {
        INCREX: true,
        ARRING: true,
        ARLASTITEMS: true,
        SET_IFEQ_KEEPTTL: false,
        DELEX_IFEQ: false
      },
      missing: ["SET_IFEQ_KEEPTTL", "DELEX_IFEQ"]
    }
  );
});
test("[Server/缓存与 Redis] Redis 命令能力探针取消后不再调度阶段且原子收口探针键", async () => {
  const pendingIncrex = deferredPromise<unknown>();
  let pipelineCreations = 0;
  const increxCommands: string[] = [];
  const increxController = new AbortController();
  const increxProbe = readRequiredRedisCommandCapabilities({
    call: async (command: string) => {
      increxCommands.push(command);
      return pendingIncrex.promise;
    },
    pipeline: () => {
      pipelineCreations += 1;
      return { call: () => undefined, exec: async () => [] };
    }
  } as never, increxController.signal);
  await delay(0);
  assert.deepEqual(increxCommands, ["INCREX"]);
  const increxAbortReason = new Error("controlled INCREX probe abort");
  increxController.abort(increxAbortReason);
  await assert.rejects(
    increxProbe,
    (error: Error) => error === increxAbortReason
  );
  pendingIncrex.resolve([0, 1]);
  await delay(10);
  assert.equal(pipelineCreations, 0);

  const pendingArrayPipeline = deferredPromise<
    Array<[Error | null, unknown]>
  >();
  const pipelineStarted = deferredPromise<void>();
  const arrayCommands: string[] = [];
  const arrayController = new AbortController();
  const arrayProbe = readRequiredRedisCommandCapabilities({
    call: async () => [0, 1],
    pipeline: () => ({
      call: (command: string) => {
        arrayCommands.push(command);
      },
      exec: async () => {
        pipelineStarted.resolve();
        return pendingArrayPipeline.promise;
      }
    })
  } as never, arrayController.signal);
  await pipelineStarted.promise;
  assert.deepEqual(arrayCommands, [
    "ARRING",
    "EXPIRE",
    "ARLASTITEMS",
    "SET",
    "PTTL",
    "SET",
    "PTTL",
    "SET",
    "GET",
    "SET",
    "EXISTS",
    "SET",
    "DELEX",
    "GET",
    "DELEX",
    "EXISTS",
    "DELEX",
    "UNLINK"
  ]);
  const arrayAbortReason = new Error("controlled array probe abort");
  arrayController.abort(arrayAbortReason);
  await assert.rejects(
    arrayProbe,
    (error: Error) => error === arrayAbortReason
  );
  const scheduledAtReturn = [...arrayCommands];
  pendingArrayPipeline.resolve([
    [null, 1],
    [null, 1],
    [null, ["imageshow-required-command-probe"]],
    [null, 2]
  ]);
  await delay(10);
  assert.deepEqual(arrayCommands, scheduledAtReturn);
});
test("[Server/缓存与 Redis] Redis 手动检查总期限覆盖连接与固定命令且保留请求取消原因", async () => {
  const pendingPing = deferredPromise<void>();
  let fixedCommandCalls = 0;
  const unusedClient = {
    status: "ready",
    info: async () => {
      fixedCommandCalls += 1;
      return "";
    },
    dbsize: async () => {
      fixedCommandCalls += 1;
      return 0;
    },
    scan: async () => ["0", []],
    pipeline: () => ({ eval: () => undefined, exec: async () => [] })
  };
  const dependencyBase = {
    client: unusedClient,
    ping: async () => pendingPing.promise,
    readMeta: async () => null,
    readRequiredCommands: async () => ({ commands: {}, missing: [] }),
    readProjection: async () => null,
    coordinatorStatus: () => ({ readable: true, reason: "ready" })
  };
  const pingDeadline = await inspectRedisState(undefined, {
    deadlineMs: 20,
    dependencies: dependencyBase as never
  });
  assert.equal(pingDeadline.deep_inspection.complete, false);
  if (pingDeadline.deep_inspection.complete) {
    assert.fail("total-deadline inspection must be partial");
  }
  assert.equal(pingDeadline.deep_inspection.reason, "deadline");
  assert.equal(fixedCommandCalls, 0);

  const pendingInfo = deferredPromise<string>();
  const fixedDeadline = await inspectRedisState(undefined, {
    deadlineMs: 20,
    dependencies: {
      ...dependencyBase,
      ping: async () => undefined,
      client: {
        ...unusedClient,
        info: async () => {
          fixedCommandCalls += 1;
          return pendingInfo.promise;
        }
      }
    } as never
  });
  assert.equal(fixedDeadline.deep_inspection.complete, false);
  if (fixedDeadline.deep_inspection.complete) {
    assert.fail("fixed-command deadline inspection must be partial");
  }
  assert.equal(fixedDeadline.deep_inspection.reason, "deadline");
  assert.equal(fixedDeadline.connection.redis_version, "unknown");
  assert.ok(fixedCommandCalls >= 3);

  let scanCallsAfterFixedFailure = 0;
  const fixedFailure = new Error("controlled Redis INFO failure");
  await assert.rejects(
    inspectRedisState(undefined, {
      deadlineMs: 1_000,
      dependencies: {
        ...dependencyBase,
        ping: async () => undefined,
        client: {
          ...unusedClient,
          info: async (section: string) => {
            if (section === "server") throw fixedFailure;
            return "";
          },
          scan: async () => {
            scanCallsAfterFixedFailure += 1;
            await delay(5);
            return ["1", []];
          }
        }
      } as never
    }),
    (error: Error) => error === fixedFailure
  );
  const settledScanCalls = scanCallsAfterFixedFailure;
  assert.ok(settledScanCalls >= 1);
  await delay(50);
  assert.equal(scanCallsAfterFixedFailure, settledScanCalls);

  const abortController = new AbortController();
  const abortReason = new Error("controlled Redis inspection request abort");
  const aborted = inspectRedisState(abortController.signal, {
    deadlineMs: 1_000,
    dependencies: dependencyBase as never
  });
  abortController.abort(abortReason);
  await assert.rejects(aborted, (error: Error) => error === abortReason);
});
