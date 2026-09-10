import type { IngestionSessionSnapshot, StoredIngestionSession, UploadIntentSnapshot } from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import type { IngestionTokenEnvelope } from "../../../../packages/server/src/images/ingestion/sessions/token-service.ts";
import { requiredValue } from "./ingestion-scenario-fixture.mts";
import { activeResult, activeSession, completedResult, discardedResult } from "./ingestion-scenario-fixture.mts";
import { repositoryWithOverrides } from "./ingestion-scenario-fixture.mts";
import assert from "node:assert/strict";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { createIngestionScenarioFixture } from "./ingestion-scenario-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";
import { interceptSqlQueries } from "./database-faults.mts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const sharedAppConfig = await import("@imageshow/shared");
const redisClient = await import("../../../../packages/server/src/core/redis/client.ts");
const runtimeAvailability = await import("../../../../packages/server/src/core/runtime-availability.ts");
const ingestionSessionRepository = await import(
  "../../../../packages/server/src/images/ingestion/repository.ts"
);
const ingestionSessionView = await import("../../../../packages/server/src/images/ingestion/queue/session-view.ts");
const ingestionSessionTransitions = await import(
  "../../../../packages/server/src/images/ingestion/sessions/transitions.ts"
);
const ingestionSessionCodec = await import("../../../../packages/server/src/images/ingestion/sessions/codec.ts");
const ingestionRawUpload = await import("../../../../packages/server/src/images/ingestion/raw/upload.ts");
const ingestionRawFiles = {
  ...await import("../../../../packages/server/src/images/ingestion/raw/paths.ts"),
  ...await import("../../../../packages/server/src/images/ingestion/raw/files.ts"),
  ...await import("../../../../packages/server/src/images/ingestion/raw/lease-registry.ts"),
  ...await import("../../../../packages/server/src/images/ingestion/raw/orphan-scanner.ts")
};
const ingestionCommitCompletion = await import(
  "../../../../packages/server/src/images/ingestion/commit/completion.ts"
);
const ingestionTokenService = await import("../../../../packages/server/src/images/ingestion/sessions/token-service.ts");
const ingestionActionScope = await import("../../../../packages/server/src/images/ingestion/queue/action-scope.ts");
const ingestionQueueSnapshot = await import("../../../../packages/server/src/images/ingestion/queue/snapshot.ts");
const ingestionSessionIdentity = await import("../../../../packages/server/src/images/ingestion/sessions/identity.ts");
const ingestionSessionProjection = await import(
  "../../../../packages/server/src/images/ingestion/sessions/projection.ts"
);
const ingestionSessionKeys = await import("../../../../packages/server/src/images/ingestion/sessions/keys.ts");
const coreUuid = await import("../../../../packages/server/src/core/uuid.ts");
const imageTime = await import("../../../../packages/server/src/images/image-time.ts");
const { ingestionRepository, productionIngestionRepository, serviceNow, displayOrderKey } = await createIngestionScenarioFixture(runtime);
  const ingestionOwner = "current-domain-" + randomUUID();
  const ingestionSessionId = ingestionSessionIdentity.createIngestionSessionId(
    ingestionOwner,
    "upload",
    "stable-idempotency-key"
  );
  const ingestionResolvedTime = imageTime.parseImageTime(
    "2026-08-23T01:02:03.456Z"
  );
  const ingestionImageId = imageTime.createImageId(ingestionResolvedTime.date, 37);
  const intentTtlMs = sharedAppConfig.appConfig.ingestionRuntime
    .uploadIntentTtlSeconds * 1000;
  const intentClaimStaleMs = sharedAppConfig.appConfig.ingestionRuntime
    .uploadClaimStaleSeconds * 1000;
  const uploadTtlMs = sharedAppConfig.appConfig.ingestionRuntime
    .uploadSessionIdleTtlSeconds * 1000;
  const ingestionMetadata = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: null,
    author: "",
    title: "current domain",
    description: "",
    source: "",
    original: "",
    tags: []
  };
  const ingestionIntent = {
    owner: ingestionOwner,
    session_id: ingestionSessionId,
    candidate_image_id: ingestionImageId,
    resolved_image_time: ingestionResolvedTime.iso,
    request_hash: "a".repeat(64),
    display_order_key: ingestionSessionIdentity.createIngestionDisplayOrderKey(
      coreUuid.randomUuidV7At(new Date(serviceNow)),
      37,
      ingestionSessionId
    ),
    batch_position: 37,
    metadata: ingestionMetadata,
    storage_slug: "local",
    expected_size: 10,
    max_long_edge: 1_000,
    created_at: 1_000,
    expires_at: 0,
    execution_token: "",
    claim_heartbeat_at: 0
  };
  const malformedIntentOwner = "current-malformed-intent-" + randomUUID();
  const malformedIntentSessionId = ingestionSessionIdentity.createIngestionSessionId(
    malformedIntentOwner,
    "upload",
    "invalid-clock"
  );
  const malformedIntentKey = ingestionSessionKeys.ingestionUploadIntentKey(
    malformedIntentOwner,
    malformedIntentSessionId
  );
  const malformedIntentBase = {
    ...ingestionIntent,
    owner: malformedIntentOwner,
    session_id: malformedIntentSessionId,
    display_order_key: displayOrderKey(
      malformedIntentSessionId,
      37,
      serviceNow
    )
  };
  await assert.rejects(ingestionRepository.createUploadIntent({
    ...malformedIntentBase,
    created_at: Number.NaN
  }));
  const malformedIntentTemplates = [
    {
      ...malformedIntentBase,
      raw_path: "forbidden/path"
    },
    {
      ...malformedIntentBase,
      metadata: { ...ingestionMetadata, raw_path: "forbidden/path" }
    },
    {
      ...malformedIntentBase,
      metadata: { ...ingestionMetadata, tags: {} }
    },
    {
      ...malformedIntentBase,
      metadata: null
    }
  ];
  for (const malformed of malformedIntentTemplates) {
    assert.throws(() => ingestionSessionCodec.parseUploadIntent(
      JSON.stringify({
        ...malformed,
        expires_at: ingestionIntent.created_at + intentTtlMs
      })
    ));
    await assert.rejects(ingestionRepository.createUploadIntent(malformed as unknown as UploadIntentSnapshot));
  }
  assert.equal(
    await redisClient.redis.type(malformedIntentKey),
    "none",
    "invalid 或开放 schema 的 intent 不得留下 Redis Hash"
  );
  assert.equal(
    (await ingestionRepository.createUploadIntent(ingestionIntent)).kind,
    "intent"
  );
  const initialIntent = await ingestionRepository.readUploadIntent(
    ingestionOwner,
    ingestionSessionId
  );
  assert.ok(initialIntent);
  assert.equal(initialIntent.expires_at, ingestionIntent.created_at + intentTtlMs);
  const liveIntentKey = ingestionSessionKeys.ingestionUploadIntentKey(
    ingestionOwner,
    ingestionSessionId
  );
  const originalIntentHash = await redisClient.redis.hgetall(liveIntentKey);
  for (const [field, value] of [
    ["unexpected", "leaks"],
    ["execution_token", coreUuid.randomUuidV7()]
  ]) {
    await redisClient.redis.hset(liveIntentKey, field, value);
    const malformedIntentHash = await redisClient.redis.hgetall(liveIntentKey);
    const operationalBeforeIntentHashFailure = {
      ...runtimeAvailability.getRedisOperationalState()
    };
    await assert.rejects(productionIngestionRepository.readUploadIntent(
      ingestionOwner,
      ingestionSessionId
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "upload_intent_state_conflict");
    await assert.rejects(productionIngestionRepository.claimUploadIntent(
      ingestionOwner,
      {
        session_id: ingestionSessionId,
        candidate_image_id: ingestionImageId,
        request_hash: ingestionIntent.request_hash
      },
      coreUuid.randomUuidV7(),
      ingestionIntent.created_at + 1
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "upload_intent_state_conflict");
    assert.deepEqual(
      await redisClient.redis.hgetall(liveIntentKey),
      malformedIntentHash,
      "intent Hash 结构或派生字段漂移必须零写入"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeIntentHashFailure,
      "intent Hash 领域损坏不得降级全局 Redis operational state"
    );
    if (Object.hasOwn(originalIntentHash, field)) {
      await redisClient.redis.hset(liveIntentKey, field, originalIntentHash[field]);
    } else {
      await redisClient.redis.hdel(liveIntentKey, field);
    }
  }
  const intentOperationalBeforeSchemaFailure = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await redisClient.redis.hset(liveIntentKey, "snapshot", JSON.stringify({
    ...initialIntent,
    raw_path: "forbidden/path"
  }));
  const openSchemaIntentState = await redisClient.redis.hgetall(liveIntentKey);
  await assert.rejects(productionIngestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    coreUuid.randomUuidV7(),
    ingestionIntent.created_at + 1
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "upload_intent_state_conflict");
  assert.deepEqual(
    await redisClient.redis.hgetall(liveIntentKey),
    openSchemaIntentState,
    "含额外字段的 intent 必须在 claim 写入前 fail closed"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    intentOperationalBeforeSchemaFailure,
    "intent 领域 schema 错误不得降级全局 Redis operational state"
  );
  await redisClient.redis.hset(
    liveIntentKey,
    "snapshot",
    JSON.stringify(initialIntent)
  );
  await redisClient.redis.hset(liveIntentKey, "snapshot", JSON.stringify({
    ...initialIntent,
    metadata: {
      ...initialIntent.metadata,
      tags: { unexpected: "value" }
    }
  }));
  const malformedTagsIntentState = await redisClient.redis.hgetall(
    liveIntentKey
  );
  await assert.rejects(ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    coreUuid.randomUuidV7(),
    ingestionIntent.created_at + 1
  ));
  assert.deepEqual(
    await redisClient.redis.hgetall(liveIntentKey),
    malformedTagsIntentState,
    "非数组 tags 的 intent 必须 fail closed 且不得被 claim 重写"
  );
  await redisClient.redis.hset(
    liveIntentKey,
    "snapshot",
    JSON.stringify(initialIntent)
  );
  const regeneratedIntentTime = imageTime.parseImageTime(
    "2026-08-23T01:02:06.456Z"
  );
  const resignedIntent = await ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    candidate_image_id: imageTime.createImageId(
      regeneratedIntentTime.date,
      41
    ),
    resolved_image_time: regeneratedIntentTime.iso,
    created_at: ingestionIntent.created_at + 10_000
  });
  assert.equal(resignedIntent.kind, "intent");
  assert.equal(resignedIntent.created, false);
  assert.equal(resignedIntent.intent.expires_at, initialIntent.expires_at);
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    initialIntent,
    "读取或重签不得延长上传意图的逻辑有效期"
  );
  await assert.rejects(ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    request_hash: "b".repeat(64),
    created_at: ingestionIntent.created_at + 20_000
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "idempotency_conflict");
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    initialIntent,
    "不同 request hash 的 intent 冲突不得改变现有 intent 或 TTL"
  );
  await assert.rejects(ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    "",
    initialIntent.created_at + 1
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_execution_fenced");
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    initialIntent,
    "空 execution token 不得 claim 或延长 intent"
  );

  const expiredIntentOwner = "current-expired-intent-" + randomUUID();
  const expiredIntentSessionId = ingestionSessionIdentity.createIngestionSessionId(
    expiredIntentOwner,
    "upload",
    "expires-at-boundary"
  );
  const expiredIntentTime = imageTime.parseImageTime(
    "2026-08-23T01:02:04.456Z"
  );
  const expiredIntentImageId = imageTime.createImageId(
    expiredIntentTime.date,
    38
  );
  const expiredIntent = {
    ...ingestionIntent,
    owner: expiredIntentOwner,
    session_id: expiredIntentSessionId,
    candidate_image_id: expiredIntentImageId,
    resolved_image_time: expiredIntentTime.iso,
    request_hash: "c".repeat(64),
    display_order_key: displayOrderKey(
      expiredIntentSessionId,
      38,
      expiredIntentTime.date.getTime()
    ),
    batch_position: 38,
    created_at: 2_000
  };
  await ingestionRepository.createUploadIntent(expiredIntent);
  await assert.rejects(ingestionRepository.claimUploadIntent(
    expiredIntentOwner,
    {
      session_id: expiredIntentSessionId,
      candidate_image_id: expiredIntentImageId,
      request_hash: expiredIntent.request_hash
    },
    coreUuid.randomUuidV7(),
    expiredIntent.created_at + intentTtlMs
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "upload_intent_expired");
  assert.equal(await ingestionRepository.readUploadIntent(
    expiredIntentOwner,
    expiredIntentSessionId
  ), null);

  const ingestionExecutionToken = coreUuid.randomUuidV7();
  const firstIntentClaimedAt = initialIntent.expires_at - 1;
  const firstClaimedIngestionIntent = await ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    firstIntentClaimedAt
  );
  assert.equal(
    firstClaimedIngestionIntent.expires_at,
    firstIntentClaimedAt + intentTtlMs
  );
  const takeoverToken = coreUuid.randomUuidV7();
  await assert.rejects(ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    takeoverToken,
    firstIntentClaimedAt + intentClaimStaleMs - 1
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "upload_in_progress");
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    firstClaimedIngestionIntent,
    "未失活 claim 的第二 token 不得改变 intent 或 TTL"
  );
  const takeoverAt = firstIntentClaimedAt + intentClaimStaleMs;
  const takenOverIntent = await ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    takeoverToken,
    takeoverAt
  );
  assert.equal(takenOverIntent.execution_token, takeoverToken);
  const stateAfterTakeover = await ingestionRepository.readUploadIntent(
    ingestionOwner,
    ingestionSessionId
  );
  await assert.rejects(ingestionRepository.heartbeatUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    takeoverAt + 1
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_execution_fenced");
  await assert.rejects(ingestionRepository.releaseUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    takeoverAt + 1
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_execution_fenced");
  assert.deepEqual(
    await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId),
    stateAfterTakeover,
    "旧 token 的 heartbeat/release 必须 fenced 且不改变 intent"
  );
  const releasedIntent = await ingestionRepository.releaseUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    takeoverToken,
    takeoverAt + 1
  );
  assert.equal(releasedIntent.execution_token, "");
  assert.equal(releasedIntent.claim_heartbeat_at, 0);
  assert.equal(releasedIntent.expires_at, takenOverIntent.expires_at);
  const intentClaimedAt = takeoverAt + 1;
  const claimedIngestionIntent = await ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    intentClaimedAt
  );
  assert.equal(claimedIngestionIntent.execution_token, ingestionExecutionToken);
  const oldIntentHeartbeat = await ingestionRepository.heartbeatUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    intentClaimedAt - 100
  );
  assert.equal(oldIntentHeartbeat.claim_heartbeat_at, intentClaimedAt);
  assert.equal(oldIntentHeartbeat.expires_at, claimedIngestionIntent.expires_at);
  const intentHeartbeatAt = intentClaimedAt + 100;
  const heartbeatedIngestionIntent = await ingestionRepository.heartbeatUploadIntent(
    ingestionOwner,
    {
      session_id: ingestionSessionId,
      candidate_image_id: ingestionImageId,
      request_hash: ingestionIntent.request_hash
    },
    ingestionExecutionToken,
    intentHeartbeatAt
  );
  assert.equal(
    heartbeatedIngestionIntent.expires_at,
    intentHeartbeatAt + intentTtlMs
  );
  assert.deepEqual(heartbeatedIngestionIntent.metadata, ingestionMetadata);
  assert.equal(
    (requiredValue(await ingestionRepository.readUploadIntent(ingestionOwner, ingestionSessionId)))
      .expires_at,
    heartbeatedIngestionIntent.expires_at
  );
  const canonicalCreatedAt = intentHeartbeatAt + 1;
  const ingestionCanonicalWithoutHash = {
    owner: ingestionOwner,
    queue: "upload" as const,
    source_type: "upload" as const,
    session_id: ingestionSessionId,
    image_id: ingestionImageId,
    image_time: claimedIngestionIntent.resolved_image_time,
    request_hash: claimedIngestionIntent.request_hash,
    metadata: ingestionMetadata,
    storage_slug: "local",
    status: "received" as const,
    phase: "received" as const,
    message: "received",
    progress: 100,
    version: 0,
    progress_seq: 0,
    last_semantic_revision: 0,
    accepted_at: 0,
    accepted_order: 0,
    execution_token: "",
    raw_generation: coreUuid.randomUuidV7(),
    raw_size: 10,
    discard_at: 0
  };
  const ingestionCanonical = {
    ...ingestionCanonicalWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      ingestionCanonicalWithoutHash
    )
  };
  const takeoverIntentSchemaVariants = [
    { ...heartbeatedIngestionIntent, raw_path: "forbidden/path" },
    {
      ...heartbeatedIngestionIntent,
      metadata: { ...heartbeatedIngestionIntent.metadata, tags: {} }
    },
    { ...heartbeatedIngestionIntent, metadata: null }
  ];
  const operationalBeforeIntentTakeoverFailures = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  for (const malformed of takeoverIntentSchemaVariants) {
    await redisClient.redis.hset(
      liveIntentKey,
      "snapshot",
      JSON.stringify(malformed)
    );
    const stateBeforeMalformedTakeover = {
      intent: await redisClient.redis.hgetall(liveIntentKey),
      canonicalType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionCanonicalKey(ingestionOwner, ingestionSessionId)
      ),
      ownerType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionOwnerQueueKey(ingestionOwner, "upload")
      ),
      metadataType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionQueueMetadataKey(ingestionOwner, "upload")
      )
    };
    await assert.rejects(productionIngestionRepository.convertUploadIntent(
      ingestionCanonical,
      ingestionExecutionToken,
      canonicalCreatedAt
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "upload_intent_state_conflict");
    assert.deepEqual({
      intent: await redisClient.redis.hgetall(liveIntentKey),
      canonicalType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionCanonicalKey(ingestionOwner, ingestionSessionId)
      ),
      ownerType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionOwnerQueueKey(ingestionOwner, "upload")
      ),
      metadataType: await redisClient.redis.type(
        ingestionSessionKeys.ingestionQueueMetadataKey(ingestionOwner, "upload")
      )
    }, stateBeforeMalformedTakeover,
    "畸形既存 intent 不得在 takeover 时被删除或创建 canonical");
  }
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeIntentTakeoverFailures,
    "intent takeover schema 错误不得降级全局 Redis operational state"
  );
  await redisClient.redis.hset(
    liveIntentKey,
    "snapshot",
    JSON.stringify(heartbeatedIngestionIntent)
  );
  let ingestionListenerCalls = 0;
  let ingestionAsyncListenerCalls = 0;
  ingestionRepository.subscribe(ingestionOwner, "upload", () => {
    ingestionListenerCalls += 1;
    throw new Error("listener failure must not reject a committed Redis write");
  });
  ingestionRepository.subscribe(ingestionOwner, "upload", async () => {
    ingestionAsyncListenerCalls += 1;
    throw new Error("async listener failure must be isolated");
  });
  const takeoverTampering = [
    { ...ingestionCanonical, image_time: regeneratedIntentTime.iso },
    {
      ...ingestionCanonical,
      metadata: { ...ingestionMetadata, title: "tampered" }
    },
    { ...ingestionCanonical, storage_slug: "tampered-storage" },
    { ...ingestionCanonical, raw_size: ingestionCanonical.raw_size + 1 },
    { ...ingestionCanonical, raw_generation: "" }
  ];
  for (const tampered of takeoverTampering) {
    await assert.rejects(ingestionRepository.convertUploadIntent(
      tampered,
      ingestionExecutionToken,
      canonicalCreatedAt
    ));
    assert.equal(ingestionListenerCalls, 0);
    assert.equal(ingestionAsyncListenerCalls, 0);
    assert.ok(await ingestionRepository.readUploadIntent(
      ingestionOwner,
      ingestionSessionId
    ));
  }
  assert.equal((await ingestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  )).items.length, 0);
  const convertedUpload = activeResult(await ingestionRepository.convertUploadIntent(
    ingestionCanonical,
    ingestionExecutionToken,
    canonicalCreatedAt
  ));
  assert.equal(convertedUpload.session.version, 1);
  assert.equal(
    convertedUpload.session.discard_at,
    canonicalCreatedAt + uploadTtlMs
  );
  assert.equal(ingestionListenerCalls, 1);
  assert.equal(ingestionAsyncListenerCalls, 1);
  const unknownRawBody = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "red" }
  }).png().toBuffer();
  const { IngestionSessionService } = await import("../../../../packages/server/src/images/ingestion/session-service.ts");
  const unknownRawCanonicals: IngestionSessionSnapshot[] = [];
  const unknownRawOwner = ingestionOwner + "-unknown-convert";
  const unknownRawRepository = repositoryWithOverrides(ingestionRepository, {
    convertUploadIntent: async (...args) => {
      const converted = activeResult(await ingestionRepository.convertUploadIntent(...args));
      unknownRawCanonicals.push(converted.session);
      throw new Error("conversion response lost");
    }
  });
  const unknownRawService = new IngestionSessionService(unknownRawRepository,
    new ingestionTokenService.IngestionTokenService({ rootKey: new Uint8Array(32).fill(37) }));
  const [unknownIntent] = await unknownRawService.createUploadIntents(unknownRawOwner, [{
    ...ingestionMetadata, idempotency_key: "unknown-convert-result", batch_key: coreUuid.randomUuidV7(),
    batch_position: 49, expected_size: unknownRawBody.length, max_long_edge: 16
  }]);
  assert.ok(unknownIntent.status === "intent");
  await assert.rejects(ingestionRawUpload.receiveUploadIntentBody(
    unknownRawService, unknownRawOwner, unknownIntent.credential,
    new Response(unknownRawBody).body, new AbortController().signal
  ), /conversion response lost/);
  const unknownRawCanonical = requiredValue(unknownRawCanonicals[0]);
  const unknownRawPair = { session_id: unknownRawCanonical.session_id, image_id: unknownRawCanonical.image_id };
  const retainedUnknownRawPath = ingestionRawFiles.ingestionRawPath(
    "upload",
    unknownRawPair,
    unknownRawCanonical.raw_generation
  );
  assert.deepEqual(
    await readFile(retainedUnknownRawPath),
    unknownRawBody,
    "convert 结果未知且 canonical 引用当前 generation 时不得删除 raw"
  );
  await rm(retainedUnknownRawPath, { force: true });
  const discardedUnknownRaw = discardedResult(await ingestionRepository.mutateSemantic(
    unknownRawCanonical, unknownRawCanonical.version,
    ingestionSessionTransitions.discardedIngestionReceipt(unknownRawCanonical, Date.now())
  ));
  await ingestionRepository.deleteSession(discardedUnknownRaw.session, discardedUnknownRaw.session.version);
  const staleIngestionImageId = imageTime.createImageId(
    imageTime.parseImageTime("2026-08-23T01:02:04.456Z").date,
    38
  );
  const mixedIncarnationReads = await productionIngestionRepository.readSessions(
    ingestionOwner,
    [
      { session_id: ingestionSessionId, image_id: staleIngestionImageId },
      { session_id: ingestionSessionId, image_id: ingestionImageId }
    ]
  );
  assert.equal(
    mixedIncarnationReads[0],
    ingestionSessionRepository.ingestionSessionIncarnationMismatch
  );
  assert.deepEqual(mixedIncarnationReads[1], convertedUpload.session);
  const mixedIncarnationStatuses = await ingestionSessionView.readIngestionStatuses(
    productionIngestionRepository,
    ingestionOwner,
    [
      { session_id: ingestionSessionId, image_id: staleIngestionImageId },
      { session_id: ingestionSessionId, image_id: ingestionImageId }
    ]
  );
  assert.equal(mixedIncarnationStatuses[0].status, "missing");
  assert.equal(mixedIncarnationStatuses[1].status, "present");
  const ingestionTestKeys = ingestionSessionKeys.ingestionSessionKeys(
    ingestionOwner,
    "upload",
    ingestionSessionId
  );
  const readIngestionBusinessState = async () => ({
    canonical: await redisClient.redis.hget(
      ingestionTestKeys.canonical,
      "snapshot"
    ),
    metadata: await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    owner: await redisClient.redis.zrange(
      ingestionTestKeys.owner,
      0,
      "-1",
      "WITHSCORES"
    ),
    display: await redisClient.redis.zrange(
      ingestionTestKeys.display,
      0,
      "-1",
      "WITHSCORES"
    )
  });
  const readActiveSchemaState = async () => ({
    ...await readIngestionBusinessState(),
    runnable: await redisClient.redis.zscore(
      ingestionTestKeys.runnable,
      ingestionTestKeys.canonical
    ),
    expires: await redisClient.redis.zscore(
      ingestionTestKeys.expires,
      ingestionTestKeys.canonical
    )
  });
  await redisClient.redis.hset(liveIntentKey, "unexpected", "stale-intent");
  const malformedIntentBesideCanonical = await redisClient.redis.hgetall(
    liveIntentKey
  );
  const reusedCanonicalBeforeMalformedIntent = await productionIngestionRepository
    .createUploadIntent({
      ...ingestionIntent,
      created_at: canonicalCreatedAt + 1
    });
  assert.equal(reusedCanonicalBeforeMalformedIntent.kind, "canonical");
  assert.equal(
    reusedCanonicalBeforeMalformedIntent.session.image_id,
    ingestionImageId
  );
  const convertedBeforeMalformedIntent = activeResult(await productionIngestionRepository
    .convertUploadIntent(
      ingestionCanonical,
      ingestionExecutionToken,
      canonicalCreatedAt + 1
    ));
  assert.equal(convertedBeforeMalformedIntent.created, false);
  assert.deepEqual(
    await redisClient.redis.hgetall(liveIntentKey),
    malformedIntentBesideCanonical,
    "已有 canonical 的幂等读取不得校验或改写残留 intent"
  );
  await redisClient.redis.del(liveIntentKey);
  const originalCanonicalHash = await redisClient.redis.hgetall(
    ingestionTestKeys.canonical
  );
  for (const [field, value] of [
    ["unexpected", "leaks"],
    ["status", "queued"]
  ]) {
    await redisClient.redis.hset(ingestionTestKeys.canonical, field, value);
    const malformedCanonicalHashState = await readActiveSchemaState();
    const operationalBeforeCanonicalHashFailure = {
      ...runtimeAvailability.getRedisOperationalState()
    };
    await assert.rejects(productionIngestionRepository.readSession(
      ingestionOwner,
      ingestionSessionId
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.readSessions(
      ingestionOwner,
      [{ session_id: ingestionSessionId, image_id: ingestionImageId }]
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.snapshot(
      ingestionOwner,
      "upload",
      0,
      10
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.discoverRunnable(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.mutateSemantic(
      convertedUpload.session,
      convertedUpload.session.version,
      {
        ...convertedUpload.session,
        message: "不得越过损坏的 canonical Hash"
      },
      canonicalCreatedAt + 1
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    assert.deepEqual(
      await readActiveSchemaState(),
      malformedCanonicalHashState,
      "canonical Hash 结构或派生字段漂移必须零写入"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeCanonicalHashFailure,
      "canonical Hash 领域损坏不得降级全局 Redis operational state"
    );
    if (Object.hasOwn(originalCanonicalHash, field)) {
      await redisClient.redis.hset(
        ingestionTestKeys.canonical,
        field,
        originalCanonicalHash[field]
      );
    } else {
      await redisClient.redis.hdel(ingestionTestKeys.canonical, field);
    }
  }
  const siblingIngestionMetadataKey = ingestionSessionKeys.ingestionQueueMetadataKey(
    ingestionOwner,
    "import"
  );
  const operationalBeforeSiblingQueueFailure = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await redisClient.redis.set(siblingIngestionMetadataKey, "wrong-type");
  assert.deepEqual(
    await productionIngestionRepository.readSession(ingestionOwner, ingestionSessionId),
    convertedUpload.session,
    "读取 upload canonical 不应校验同一 owner 的 import 队列"
  );
  assert.deepEqual(
    await productionIngestionRepository.readSessions(ingestionOwner, [{
      session_id: ingestionSessionId,
      image_id: ingestionImageId
    }]),
    [convertedUpload.session],
    "批量读取 upload canonical 不应被损坏的同级 import 队列阻断"
  );
  assert.equal(
    await redisClient.redis.get(siblingIngestionMetadataKey),
    "wrong-type"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeSiblingQueueFailure,
    "未访问队列的结构损坏不得污染 Redis 全局可用性"
  );
  await redisClient.redis.del(siblingIngestionMetadataKey);
  const malformedActiveCanonicals = [
    { ...convertedUpload.session, raw_path: "forbidden/path" },
    { ...convertedUpload.session, source_type: "url" as const },
    {
      ...convertedUpload.session,
      queue: "import" as const,
      source_type: "upload" as const,
      import_download: { url: "https://example.com/not-an-import.jpg" }
    },
    {
      ...convertedUpload.session,
      metadata: { ...convertedUpload.session.metadata, raw_path: "forbidden/path" }
    },
    {
      ...convertedUpload.session,
      metadata: { ...convertedUpload.session.metadata, tags: {} }
    },
    { ...convertedUpload.session, metadata: null },
    {
      ...convertedUpload.session,
      import_download: { url: "https://example.com/not-an-upload.jpg" }
    },
    {
      ...convertedUpload.session,
      prepared: { raw_path: "forbidden/path" }
    },
    {
      ...convertedUpload.session,
      commit: { raw_path: "forbidden/path" }
    }
  ];
  const stateBeforeActiveSchemaFailures = await readActiveSchemaState();
  const operationalBeforeActiveSchemaFailures = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  for (const malformed of malformedActiveCanonicals) {
    assert.throws(() => ingestionSessionCodec.parseStoredIngestionSession(
      JSON.stringify(malformed)
    ));
    await assert.rejects(productionIngestionRepository.mutateSemantic(
      convertedUpload.session,
      convertedUpload.session.version,
      (malformed) as unknown as StoredIngestionSession,
      canonicalCreatedAt + 1
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    assert.deepEqual(
      await readActiveSchemaState(),
      stateBeforeActiveSchemaFailures,
      "开放或畸形 active schema 必须在任何 Redis 写入前失败"
    );
  }
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeActiveSchemaFailures,
    "active schema 领域错误不得降级全局 Redis operational state"
  );

  const canonicalBeforeOpenSchemaRead = await redisClient.redis.hget(
    ingestionTestKeys.canonical,
    "snapshot"
  );
  assert.ok(canonicalBeforeOpenSchemaRead);
  const openSchemaCanonical = JSON.stringify({
    ...JSON.parse(canonicalBeforeOpenSchemaRead),
    raw_path: "forbidden/path"
  });
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    openSchemaCanonical
  );
  await assert.rejects(productionIngestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.equal(
    await redisClient.redis.hget(ingestionTestKeys.canonical, "snapshot"),
    openSchemaCanonical,
    "读取开放 schema canonical 必须 fail closed 且不得自动改写"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeActiveSchemaFailures
  );
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    canonicalBeforeOpenSchemaRead
  );
  const stateBeforeActiveDelete = await readIngestionBusinessState();
  await assert.rejects(productionIngestionRepository.deleteSession(
    convertedUpload.session as unknown as Parameters<typeof ingestionRepository.deleteSession>[0],
    convertedUpload.session.version,
    canonicalCreatedAt + 1
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_session_state_conflict");
  assert.deepEqual(
    await readIngestionBusinessState(),
    stateBeforeActiveDelete,
    "active canonical 的终态删除绕过必须零写入"
  );

  const originalOwnerScore = await redisClient.redis.zscore(
    ingestionTestKeys.owner,
    ingestionSessionId
  );
  const originalQueueMetadata = await redisClient.redis.hgetall(
    ingestionTestKeys.metadata
  );
  assert.ok(originalOwnerScore);
  const clockSessionId = ingestionSessionIdentity.createIngestionSessionId(
    ingestionOwner,
    "upload",
    "clock-regression"
  );
  const clockImageId = imageTime.createImageId(ingestionResolvedTime.date, 38);
  const clockRequestHash = "d".repeat(64);
  const clockIntent = {
    ...ingestionIntent,
    session_id: clockSessionId,
    candidate_image_id: clockImageId,
    request_hash: clockRequestHash,
    display_order_key: displayOrderKey(
      clockSessionId,
      38,
      canonicalCreatedAt + 10
    ),
    batch_position: 38,
    created_at: canonicalCreatedAt + 10
  };
  await ingestionRepository.createUploadIntent(clockIntent);
  const clockExecutionToken = coreUuid.randomUuidV7();
  const claimedClockIntent = await ingestionRepository.claimUploadIntent(
    ingestionOwner,
    {
      session_id: clockSessionId,
      candidate_image_id: clockImageId,
      request_hash: clockRequestHash
    },
    clockExecutionToken,
    clockIntent.created_at + 1
  );
  const clockCanonicalWithoutHash = {
    ...ingestionCanonicalWithoutHash,
    session_id: clockSessionId,
    image_id: clockImageId,
    image_time: claimedClockIntent.resolved_image_time,
    request_hash: clockRequestHash,
    raw_generation: coreUuid.randomUuidV7()
  };
  const clockCanonical = {
    ...clockCanonicalWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      clockCanonicalWithoutHash
    )
  };
  const clockTestKeys = ingestionSessionKeys.ingestionSessionKeys(
    ingestionOwner,
    "upload",
    clockSessionId
  );
  const clockIntentKey = ingestionSessionKeys.ingestionUploadIntentKey(
    ingestionOwner,
    clockSessionId
  );
  const readClockCreateState = async () => ({
    queue: await readActiveSchemaState(),
    canonicalType: await redisClient.redis.type(clockTestKeys.canonical),
    intent: await redisClient.redis.hgetall(clockIntentKey)
  });
  for (const [field, value] of [
    ["revision", "0"],
    ["last_accepted_order", "0"]
  ]) {
    await redisClient.redis.hset(ingestionTestKeys.metadata, field, value);
    const stateBeforeRegressedClockCreate = await readClockCreateState();
    const operationalBeforeRegressedClockCreate = {
      ...runtimeAvailability.getRedisOperationalState()
    };
    await assert.rejects(productionIngestionRepository.convertUploadIntent(
      clockCanonical,
      clockExecutionToken,
      clockIntent.created_at + 2
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    assert.deepEqual(
      await readClockCreateState(),
      stateBeforeRegressedClockCreate,
      "回退的队列时钟必须在 canonical 创建前 fail closed"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeRegressedClockCreate,
      "队列时钟领域损坏不得降级全局 Redis operational state"
    );
    await redisClient.redis.hset(
      ingestionTestKeys.metadata,
      field,
      originalQueueMetadata[field]
    );
  }
  const assertQueueReadFailsClosed = async (message: string) => {
    const operationalBefore = {
      ...runtimeAvailability.getRedisOperationalState()
    };
    await assert.rejects(productionIngestionRepository.readSession(
      ingestionOwner,
      ingestionSessionId
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.readSessions(
      ingestionOwner,
      [{ session_id: ingestionSessionId, image_id: ingestionImageId }]
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    await assert.rejects(productionIngestionRepository.discoverRunnable(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBefore,
      message
    );
  };
  const parsedOriginalQueueMetadata = ingestionSessionCodec.metadataFromHashReply(
    Object.entries(originalQueueMetadata).flat()
  );
  const operationalBeforeInvalidSnapshotRange = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    sharedAppConfig.appConfig.ingestionRuntime.snapshotMaxItems + 1
  ), RangeError);
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeInvalidSnapshotRange,
    "超上限 snapshot 必须在 Redis 调用前拒绝"
  );
  await assert.rejects(productionIngestionRepository.discoverRunnable(
    sharedAppConfig.appConfig.ingestionRuntime.ingestionSessionScanBatchSize + 1
  ), RangeError);
  await assert.rejects(
    productionIngestionRepository.discoverRunnablePage(-1, 0),
    RangeError
  );
  await assert.rejects(
    productionIngestionRepository.discoverRunnablePage(0, -1),
    RangeError
  );
  await assert.rejects(productionIngestionRepository.discoverExpired(
    canonicalCreatedAt,
    sharedAppConfig.appConfig.ingestionRuntime.expiryScanBatchSize + 1
  ), RangeError);
  await assert.rejects(productionIngestionRepository.discoverExpiryPage(
    0,
    sharedAppConfig.appConfig.ingestionRuntime.ingestionSessionScanBatchSize + 1
  ), RangeError);
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeInvalidSnapshotRange,
    "超上限 discovery 必须在 Redis 调用前拒绝"
  );
  assert.throws(() => ingestionSessionCodec.parseIngestionQueueMetadata({
    ...parsedOriginalQueueMetadata,
    revision: parsedOriginalQueueMetadata.last_accepted_order - 1
  }));
  assert.throws(() => ingestionSessionCodec.parseIngestionQueueMetadata({
    ...parsedOriginalQueueMetadata,
    committing_resolving: 0,
    resolving: 1
  }));
  for (const invalidIntegerText of ["1.0", "01", ""]) {
    assert.throws(() => ingestionSessionCodec.metadataFromHashReply(
      Object.entries({
        ...originalQueueMetadata,
        revision: invalidIntegerText
      }).flat()
    ));
  }
  assert.throws(() => ingestionSessionCodec.parseIngestionQueueMetadata({
    ...parsedOriginalQueueMetadata,
    unexpected: "leaks"
  }));
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    "unexpected",
    "leaks"
  );
  const stateWithUnexpectedMetadata = await readActiveSchemaState();
  await assertQueueReadFailsClosed(
    "metadata 额外字段必须只让当前队列 fail closed"
  );
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  await assert.rejects(productionIngestionRepository.mutateSemantic(
    convertedUpload.session,
    convertedUpload.session.version,
    {
      ...convertedUpload.session,
      message: "不得越过开放 metadata schema"
    },
    canonicalCreatedAt + 1
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await readActiveSchemaState(),
    stateWithUnexpectedMetadata,
    "metadata 额外字段必须在任何业务写入前失败"
  );
  await redisClient.redis.hdel(ingestionTestKeys.metadata, "unexpected");
  await redisClient.redis.zrem(ingestionTestKeys.owner, ingestionSessionId);
  await assertQueueReadFailsClosed(
    "owner 成员缺失必须让 pair read/discovery 领域失败而不降级全局 Redis"
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.owner,
    originalOwnerScore,
    ingestionSessionId
  );
  await redisClient.redis.del(ingestionTestKeys.metadata);
  await assertQueueReadFailsClosed(
    "metadata 缺失必须让 pair read/discovery 领域失败而不降级全局 Redis"
  );
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    ...Object.entries(originalQueueMetadata).flat()
  );

  const operationalBeforeMissingPairStructure = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await redisClient.redis.del(ingestionTestKeys.canonical);
  const stateBeforeMissingCanonicalIntent = {
    owner: await redisClient.redis.zrange(
      ingestionTestKeys.owner,
      0,
      "-1",
      "WITHSCORES"
    ),
    metadata: await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    intentType: await redisClient.redis.type(liveIntentKey)
  };
  await assert.rejects(productionIngestionRepository.createUploadIntent({
    ...ingestionIntent,
    created_at: canonicalCreatedAt + 2
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual({
    owner: await redisClient.redis.zrange(
      ingestionTestKeys.owner,
      0,
      "-1",
      "WITHSCORES"
    ),
    metadata: await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    intentType: await redisClient.redis.type(liveIntentKey)
  }, stateBeforeMissingCanonicalIntent,
  "canonical 缺失但 owner 成员仍在时不得创建 upload intent");
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeMissingPairStructure,
    "缺失 canonical 的 intent 领域失败不得降级全局 Redis"
  );
  const readMissingCanonicalDiscoveryState = async () => ({
    canonicalType: await redisClient.redis.type(ingestionTestKeys.canonical),
    owner: await redisClient.redis.zrange(
      ingestionTestKeys.owner,
      0,
      "-1",
      "WITHSCORES"
    ),
    display: await redisClient.redis.zrange(
      ingestionTestKeys.display,
      0,
      "-1",
      "WITHSCORES"
    ),
    metadata: await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    runnable: await redisClient.redis.zrange(
      ingestionTestKeys.runnable,
      0,
      "-1",
      "WITHSCORES"
    ),
    expires: await redisClient.redis.zrange(
      ingestionTestKeys.expires,
      0,
      "-1",
      "WITHSCORES"
    )
  });
  const stateBeforeMissingCanonicalDiscovery =
    await readMissingCanonicalDiscoveryState();
  for (const discover of [
    () => productionIngestionRepository.discoverRunnable(),
    () => productionIngestionRepository.discoverExpired(Number.MAX_SAFE_INTEGER),
    () => productionIngestionRepository.discoverExpiryPage(0)
  ]) {
    await assert.rejects(
      discover(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid"
    );
    assert.deepEqual(
      await readMissingCanonicalDiscoveryState(),
      stateBeforeMissingCanonicalDiscovery,
      "owner 仍引用缺失 canonical 时 discovery 必须 fail closed 且零写入"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeMissingPairStructure,
      "局部队列损坏不得降级全局 Redis operational state"
    );
  }
  const expiredIntentDuringMissingCanonical = {
    ...heartbeatedIngestionIntent,
    expires_at: canonicalCreatedAt + 1
  };
  await redisClient.redis.hset(
    liveIntentKey,
    "snapshot",
    JSON.stringify(expiredIntentDuringMissingCanonical),
    "session_id",
    expiredIntentDuringMissingCanonical.session_id,
    "candidate_image_id",
    expiredIntentDuringMissingCanonical.candidate_image_id,
    "request_hash",
    expiredIntentDuringMissingCanonical.request_hash,
    "display_order_key",
    expiredIntentDuringMissingCanonical.display_order_key,
    "execution_token",
    expiredIntentDuringMissingCanonical.execution_token
  );
  const expiredIntentHashDuringMissingCanonical = await redisClient.redis.hgetall(
    liveIntentKey
  );
  await assert.rejects(productionIngestionRepository.convertUploadIntent(
    ingestionCanonical,
    ingestionExecutionToken,
    canonicalCreatedAt + 2
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await redisClient.redis.hgetall(liveIntentKey),
    expiredIntentHashDuringMissingCanonical,
    "结构异常必须在删除过期 intent 前 fail closed"
  );
  await redisClient.redis.del(liveIntentKey);
  await redisClient.redis.zrem(ingestionTestKeys.owner, ingestionSessionId);
  const balancedOwnerSessionId = ingestionSessionIdentity.createIngestionSessionId(
    ingestionOwner,
    "upload",
    "balanced-display-corruption"
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.owner,
    originalOwnerScore,
    balancedOwnerSessionId
  );
  const balancedMissingCanonicalState =
    await readMissingCanonicalDiscoveryState();
  for (const discover of [
    () => productionIngestionRepository.discoverRunnable(),
    () => productionIngestionRepository.discoverExpired(Number.MAX_SAFE_INTEGER),
    () => productionIngestionRepository.discoverExpiryPage(0)
  ]) {
    await assert.rejects(
      discover(),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid"
    );
    assert.deepEqual(
      await readMissingCanonicalDiscoveryState(),
      balancedMissingCanonicalState,
      "display 仍引用缺失 canonical 时 discovery 必须 fail closed 且零写入"
    );
    assert.deepEqual(
      runtimeAvailability.getRedisOperationalState(),
      operationalBeforeMissingPairStructure,
      "计数平衡的局部队列损坏不得降级全局 Redis operational state"
    );
  }
  await redisClient.redis.zrem(ingestionTestKeys.owner, balancedOwnerSessionId);
  await assert.rejects(productionIngestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  await assert.rejects(productionIngestionRepository.readSessions(
    ingestionOwner,
    [{ session_id: ingestionSessionId, image_id: ingestionImageId }]
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await redisClient.redis.hgetall(ingestionTestKeys.metadata),
    originalQueueMetadata,
    "canonical 与对应 owner 成员同时缺失时不得把残留 display 误报为 missing"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeMissingPairStructure
  );

  await redisClient.redis.del(ingestionTestKeys.metadata);
  await redisClient.redis.set(ingestionTestKeys.metadata, "wrong-type");
  await assert.rejects(productionIngestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.equal(
    await redisClient.redis.get(ingestionTestKeys.metadata),
    "wrong-type",
    "missing pair read 不得改写 wrong-type metadata"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeMissingPairStructure
  );
  await redisClient.redis.del(ingestionTestKeys.metadata);
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    ...Object.entries(originalQueueMetadata).flat()
  );
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    ...Object.entries(originalCanonicalHash).flat()
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.owner,
    originalOwnerScore,
    ingestionSessionId
  );

  const missingDiscoverySessionId = ingestionSessionIdentity.createIngestionSessionId(
    ingestionOwner,
    "upload",
    "missing-derived-canonical"
  );
  const missingDiscoveryKey = ingestionSessionKeys.ingestionCanonicalKey(
    ingestionOwner,
    missingDiscoverySessionId
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.runnable,
    0,
    missingDiscoveryKey
  );
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "unexpected",
    "mixed-discovery-corruption"
  );
  const runnableBeforeMixedDiscoveryFailure = await redisClient.redis.zrange(
    ingestionTestKeys.runnable,
    0,
    "-1",
    "WITHSCORES"
  );
  await assert.rejects(productionIngestionRepository.discoverRunnable(),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await redisClient.redis.zrange(
      ingestionTestKeys.runnable,
      0,
      "-1",
      "WITHSCORES"
    ),
    runnableBeforeMixedDiscoveryFailure,
    "discovery 必须在整批校验完成后才清理缺失 canonical 的成员"
  );
  await redisClient.redis.hdel(ingestionTestKeys.canonical, "unexpected");
  await ingestionRepository.discoverRunnable();
  assert.equal(
    await redisClient.redis.zscore(ingestionTestKeys.runnable, missingDiscoveryKey),
    null
  );
  await redisClient.redis.zadd(
    ingestionTestKeys.expires,
    0,
    missingDiscoveryKey
  );
  await ingestionRepository.discoverExpired(canonicalCreatedAt + 1);
  assert.equal(
    await redisClient.redis.zscore(ingestionTestKeys.runnable, missingDiscoveryKey),
    null,
    "runnable 指向缺失 canonical 时只清理派生成员"
  );
  assert.equal(
    await redisClient.redis.zscore(ingestionTestKeys.expires, missingDiscoveryKey),
    null,
    "expires 指向缺失 canonical 时只清理派生成员"
  );
  await assert.rejects(ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    request_hash: "b".repeat(64),
    created_at: canonicalCreatedAt + 1
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "idempotency_conflict");
  assert.equal(ingestionListenerCalls, 1);
  assert.equal(ingestionAsyncListenerCalls, 1);
  const reusedUpload = activeResult(await ingestionRepository.convertUploadIntent(
    {
      ...ingestionCanonical,
      image_id: imageTime.createImageId(regeneratedIntentTime.date, 42),
      image_time: regeneratedIntentTime.iso
    },
    ingestionExecutionToken,
    canonicalCreatedAt + 1
  ));
  assert.equal(reusedUpload.created, false);
  assert.equal(reusedUpload.session.image_id, convertedUpload.session.image_id);
  assert.equal(ingestionListenerCalls, 1, "幂等 canonical 复用不得发送 semantic 事件");
  assert.equal(ingestionAsyncListenerCalls, 1);
  const reusedViaIntent = await ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    candidate_image_id: imageTime.createImageId(
      regeneratedIntentTime.date,
      43
    ),
    resolved_image_time: regeneratedIntentTime.iso,
    created_at: canonicalCreatedAt + 1
  });
  assert.equal(reusedViaIntent.kind, "canonical");
  assert.equal(reusedViaIntent.session.image_id, convertedUpload.session.image_id);
  assert.equal(ingestionListenerCalls, 1);
  const unchangedUpload = activeResult(await ingestionRepository.mutateSemantic(
    convertedUpload.session,
    convertedUpload.session.version,
    { ...convertedUpload.session, semantic_hash: "f".repeat(64) },
    canonicalCreatedAt + 2
  ));
  assert.equal(unchangedUpload.changed, false);
  assert.equal(unchangedUpload.session.version, 1);
  assert.equal(unchangedUpload.session.discard_at, convertedUpload.session.discard_at);
  assert.equal(ingestionListenerCalls, 1);
  assert.equal(ingestionAsyncListenerCalls, 1);
  const preparingUploadWithoutHash = {
    ...convertedUpload.session,
    status: "preparing" as const,
    phase: "prepare-waiting" as const,
    message: "waiting for normalization admission",
    progress: null,
    execution_token: coreUuid.randomUuidV7(),
    semantic_hash: ""
  };
  const preparingUpload = {
    ...preparingUploadWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      preparingUploadWithoutHash
    )
  };
  const preparedTransition = activeResult(await ingestionRepository.mutateSemantic(
    convertedUpload.session,
    convertedUpload.session.version,
    preparingUpload,
    canonicalCreatedAt + 3
  ));
  assert.equal(ingestionListenerCalls, 2);
  assert.equal(ingestionAsyncListenerCalls, 2);
  assert.equal(preparedTransition.metadata.waiting, 1);
  assert.equal(preparedTransition.metadata.running, 0);
  const progressUpload = activeResult(await ingestionRepository.updateProgress(
    preparedTransition.session,
    preparedTransition.session.version,
    { phase: "normalizing" as const, message: "normalizing", progress: 50 },
    canonicalCreatedAt + 4
  ));
  assert.equal(
    progressUpload.session.discard_at,
    preparedTransition.session.discard_at
  );
  assert.equal(progressUpload.session.progress_seq, 1);
  assert.equal(progressUpload.metadata.waiting, 0);
  assert.equal(progressUpload.metadata.running, 1);
  assert.equal(ingestionListenerCalls, 3);
  assert.equal(ingestionAsyncListenerCalls, 3);
  const stateBeforeNullProgress = await readActiveSchemaState();
  const operationalBeforeNullProgress = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.updateProgress(
    progressUpload.session,
    progressUpload.session.version,
    null as unknown as Parameters<typeof ingestionRepository.updateProgress>[2],
    canonicalCreatedAt + 5
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await readActiveSchemaState(),
    stateBeforeNullProgress,
    "null progress payload 必须在字段解引用前 fail closed"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeNullProgress,
    "null progress 领域错误不得降级全局 Redis operational state"
  );
  const discardAtBeforeOldHeartbeat = preparedTransition.session.discard_at;
  const oldHeartbeat = activeResult(await ingestionRepository.heartbeat(
    progressUpload.session,
    progressUpload.session.version,
    canonicalCreatedAt
  ));
  assert.equal(oldHeartbeat.session.discard_at, discardAtBeforeOldHeartbeat);
  assert.equal(ingestionListenerCalls, 3);
  assert.equal(ingestionAsyncListenerCalls, 3);
  const heartbeatAt = canonicalCreatedAt + 60_000;
  const extendedHeartbeat = activeResult(await ingestionRepository.heartbeat(
    progressUpload.session,
    progressUpload.session.version,
    heartbeatAt
  ));
  assert.equal(extendedHeartbeat.session.discard_at, heartbeatAt + uploadTtlMs);
  assert.equal(ingestionListenerCalls, 3, "执行心跳不得发布队列事件");
  assert.equal(ingestionAsyncListenerCalls, 3, "执行心跳不得发布异步队列事件");
  assert.equal(
    (activeSession(await ingestionRepository.readSession(ingestionOwner, ingestionSessionId))).discard_at,
    extendedHeartbeat.session.discard_at,
    "读取 canonical 不得延长逻辑有效期"
  );
  await assert.rejects(ingestionRepository.expireSession(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    discardAtBeforeOldHeartbeat,
    ingestionSessionTransitions.discardedIngestionReceipt(
      extendedHeartbeat.session,
      discardAtBeforeOldHeartbeat
    )
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_session_not_expired");
  assert.equal(
    (activeSession(await ingestionRepository.readSession(ingestionOwner, ingestionSessionId))).discard_at,
    extendedHeartbeat.session.discard_at,
    "旧 expiry 候选不得越过已经成功的 execution heartbeat"
  );
  await assert.rejects(ingestionRepository.updateProgress(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    { phase: "expired" as const, message: "expired", progress: 75 },
    extendedHeartbeat.session.discard_at
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_session_expired");
  const changedImageTimeWithoutHash = {
    ...extendedHeartbeat.session,
    image_time: "2027-08-23T01:02:03.456Z",
    semantic_hash: ""
  };
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    {
      ...changedImageTimeWithoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        changedImageTimeWithoutHash
      )
    },
    heartbeatAt + 1
  ));
  const canonicalBeforeStructureFailure = activeSession(await ingestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  ));
  await redisClient.redis.hset(
    ingestionSessionKeys.ingestionQueueMetadataKey(ingestionOwner, "upload"),
    "unfinished",
    "999"
  );
  const operationalStateBeforeDomainFailure = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalStateBeforeDomainFailure,
    "单队列领域错误不得降级全局 Redis operational state"
  );
  await assert.rejects(ingestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ));
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    {
      ...extendedHeartbeat.session,
      status: "ready" as const,
      semantic_hash: "b".repeat(64)
    },
    heartbeatAt + 2
  ));
  await assert.rejects(productionIngestionRepository.readSession(
    ingestionOwner,
    ingestionSessionId
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.equal(ingestionListenerCalls, 3);
  assert.equal(ingestionAsyncListenerCalls, 3);
  await redisClient.redis.hset(ingestionTestKeys.metadata, "unfinished", "1");
  assert.deepEqual(
    await ingestionRepository.readSession(ingestionOwner, ingestionSessionId),
    canonicalBeforeStructureFailure
  );

  const canonicalJsonBeforeCorruption = await redisClient.redis.hget(
    ingestionTestKeys.canonical,
    "snapshot"
  );
  assert.ok(canonicalJsonBeforeCorruption);
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    "{truncated"
  );
  const operationalStateBeforeBadJson = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalStateBeforeBadJson,
    "队列内坏 JSON 不得降级全局 Redis operational state"
  );
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    canonicalJsonBeforeCorruption
  );

  const ownerScoreBeforeWrongType = await redisClient.redis.zscore(
    ingestionTestKeys.owner,
    ingestionSessionId
  );
  assert.ok(ownerScoreBeforeWrongType);
  await redisClient.redis.del(ingestionTestKeys.owner);
  await redisClient.redis.set(ingestionTestKeys.owner, "wrong-type");
  const operationalStateBeforeWrongType = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalStateBeforeWrongType,
    "队列内 WRONGTYPE 不得降级全局 Redis operational state"
  );
  await redisClient.redis.del(ingestionTestKeys.owner);
  await redisClient.redis.zadd(
    ingestionTestKeys.owner,
    ownerScoreBeforeWrongType,
    ingestionSessionId
  );

  const displayOrderKeyBeforeWrongType = await redisClient.redis.hget(
    ingestionTestKeys.canonical,
    "display_order_key"
  );
  assert.ok(displayOrderKeyBeforeWrongType);
  assert.equal(
    await redisClient.redis.zscore(
      ingestionTestKeys.display,
      displayOrderKeyBeforeWrongType
    ),
    "0"
  );
  await redisClient.redis.del(ingestionTestKeys.display);
  await redisClient.redis.set(ingestionTestKeys.display, "wrong-type");
  await assert.rejects(productionIngestionRepository.snapshot(
    ingestionOwner,
    "upload",
    0,
    10
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  await redisClient.redis.del(ingestionTestKeys.display);
  await redisClient.redis.zadd(
    ingestionTestKeys.display,
    0,
    displayOrderKeyBeforeWrongType
  );

  const stateBeforeMalformedMutations = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    ({
      ...extendedHeartbeat.session,
      raw_size: "1",
      semantic_hash: ""
    }) as unknown as StoredIngestionSession,
    heartbeatAt + 3
  ));
  await assert.rejects(ingestionRepository.updateProgress(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    { phase: "invalid" as const, message: "invalid", progress: 101 },
    heartbeatAt + 3
  ));
  assert.deepEqual(
    await readIngestionBusinessState(),
    stateBeforeMalformedMutations,
    "malformed semantic/progress payload 必须在任何 Redis 写入前失败"
  );
  const blockedReady = {
    ...extendedHeartbeat.session,
    status: "ready" as const,
    phase: "ready" as const,
    message: "ready",
    progress: 100,
    execution_token: "",
    semantic_hash: ""
  };
  await redisClient.redis.hset(ingestionTestKeys.metadata, "running", "1.0");
  const readIntegerRegressionState = async () => ({
    ...await readIngestionBusinessState(),
    runnable: await redisClient.redis.zrange(
      ingestionTestKeys.runnable,
      0,
      "-1",
      "WITHSCORES"
    ),
    expires: await redisClient.redis.zrange(
      ingestionTestKeys.expires,
      0,
      "-1",
      "WITHSCORES"
    )
  });
  const stateWithNonCanonicalInteger = await readIntegerRegressionState();
  const operationalStateBeforeNonCanonicalInteger = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  await assert.rejects(productionIngestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    blockedReady,
    heartbeatAt + 3
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  assert.deepEqual(
    await readIntegerRegressionState(),
    stateWithNonCanonicalInteger,
    "非规范整数文本必须在 revision 或任何队列投影写入前失败"
  );
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalStateBeforeNonCanonicalInteger,
    "单队列整数结构错误不得降级全局 Redis operational state"
  );
  await redisClient.redis.hset(ingestionTestKeys.metadata, "running", "1");
  const originalRevision = await redisClient.redis.hget(
    ingestionTestKeys.metadata,
    "revision"
  );
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    "revision",
    String(Number.MAX_SAFE_INTEGER)
  );
  const stateAtMaximumRevision = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    blockedReady,
    heartbeatAt + 3
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateAtMaximumRevision);
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    "revision",
    String(Number.MAX_SAFE_INTEGER + 1)
  );
  const stateAtUnsafeRevision = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.updateProgress(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    { phase: "blocked" as const, message: "blocked", progress: 99 },
    heartbeatAt + 3
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateAtUnsafeRevision);
  await redisClient.redis.hset(
    ingestionTestKeys.metadata,
    "revision",
    requiredValue(originalRevision)
  );
  const stateBeforeWrongTypes = await readIngestionBusinessState();
  await redisClient.redis.set(ingestionTestKeys.runnable, "wrong-type");
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    blockedReady,
    heartbeatAt + 3
  ));
  await assert.rejects(ingestionRepository.deleteSession(
    extendedHeartbeat.session as unknown as Parameters<typeof ingestionRepository.deleteSession>[0],
    extendedHeartbeat.session.version,
    heartbeatAt + 3
  ));
  await assert.rejects(ingestionRepository.createUploadIntent({
    ...ingestionIntent,
    created_at: heartbeatAt + 3
  }));
  assert.deepEqual(await readIngestionBusinessState(), stateBeforeWrongTypes);
  assert.equal(await redisClient.redis.get(ingestionTestKeys.runnable), "wrong-type");
  await redisClient.redis.del(ingestionTestKeys.runnable);

  const expiresScore = await redisClient.redis.zscore(
    ingestionTestKeys.expires,
    ingestionTestKeys.canonical
  );
  assert.ok(expiresScore);
  await redisClient.redis.del(ingestionTestKeys.expires);
  await redisClient.redis.set(ingestionTestKeys.expires, "wrong-type");
  await assert.rejects(ingestionRepository.heartbeat(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    heartbeatAt + 4
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateBeforeWrongTypes);
  assert.equal(await redisClient.redis.get(ingestionTestKeys.expires), "wrong-type");
  await redisClient.redis.del(ingestionTestKeys.expires);
  await redisClient.redis.zadd(
    ingestionTestKeys.expires,
    expiresScore,
    ingestionTestKeys.canonical
  );

  const originalCanonicalJson = await redisClient.redis.hget(
    ingestionTestKeys.canonical,
    "snapshot"
  );
  assert.ok(originalCanonicalJson);
  const originalCanonicalValue = JSON.parse(originalCanonicalJson);
  const wrongOrderValue = {
    ...originalCanonicalValue,
    accepted_order: originalCanonicalValue.accepted_order + 1
  };
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    JSON.stringify(wrongOrderValue),
    "accepted_order",
    String(wrongOrderValue.accepted_order)
  );
  const stateWithWrongOrder = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    blockedReady,
    heartbeatAt + 5
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateWithWrongOrder);
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    originalCanonicalJson,
    "accepted_order",
    String(originalCanonicalValue.accepted_order)
  );

  const wrongStatusValue = { ...originalCanonicalValue, status: "corrupt" as const };
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    JSON.stringify(wrongStatusValue),
    "status",
    "corrupt"
  );
  const stateWithWrongStatus = await readIngestionBusinessState();
  await assert.rejects(ingestionRepository.deleteSession(
    extendedHeartbeat.session as unknown as Parameters<typeof ingestionRepository.deleteSession>[0],
    extendedHeartbeat.session.version,
    heartbeatAt + 6
  ));
  assert.deepEqual(await readIngestionBusinessState(), stateWithWrongStatus);
  await redisClient.redis.hset(
    ingestionTestKeys.canonical,
    "snapshot",
    originalCanonicalJson,
    "status",
    originalCanonicalValue.status
  );

  const preparedManifest = {
    prepared_image_key: "current/prepared-image.webp",
    prepared_thumbnail_key: "current/prepared-thumbnail.webp",
    original_size: 10,
    original_width: 100,
    original_height: 100,
    width: 100,
    height: 100,
    ext: "webp" as const,
    md5: "1".repeat(32),
    prepared_image_sha256: "2".repeat(64),
    prepared_thumbnail_sha256: "3".repeat(64),
    size: 8,
    thumbnail_size: 4,
    quality: 90,
    transcoded: true,
    detected_device: "pc" as const,
    detected_brightness: "dark" as const,
    duplicate_count: 2,
    generation: coreUuid.randomUuidV7()
  };
  const stateBeforeMissingPreparedHashes = await readActiveSchemaState();
  for (const omittedHash of [
    "prepared_image_sha256",
    "prepared_thumbnail_sha256"
  ]) {
    const preparedWithoutHash = { ...preparedManifest };
    Reflect.deleteProperty(preparedWithoutHash, omittedHash);
    const missingHashCandidate = {
      ...extendedHeartbeat.session,
      status: "ready" as const,
      phase: "ready" as const,
      message: "missing prepared hash",
      progress: 100,
      execution_token: "",
      prepared: preparedWithoutHash,
      semantic_hash: ""
    };
    const serializedMissingHashCandidate = {
      ...missingHashCandidate,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        missingHashCandidate
      )
    };
    assert.throws(() => ingestionSessionCodec.parseStoredIngestionSession(
      JSON.stringify(serializedMissingHashCandidate)
    ));
    await assert.rejects(ingestionRepository.mutateSemantic(
      extendedHeartbeat.session,
      extendedHeartbeat.session.version,
      missingHashCandidate,
      heartbeatAt + 9
    ), /INGESTION_QUEUE_STRUCTURE prepared_fields/);
    assert.deepEqual(
      await readActiveSchemaState(),
      stateBeforeMissingPreparedHashes,
      "缺少任一 prepared SHA-256 的 canonical 必须零写入"
    );
  }
  const readyDuplicate = activeResult(await ingestionRepository.mutateSemantic(
    extendedHeartbeat.session,
    extendedHeartbeat.session.version,
    {
      ...extendedHeartbeat.session,
      status: "ready" as const,
      phase: "ready" as const,
      message: "duplicate decision required",
      progress: 100,
      execution_token: "",
      prepared: preparedManifest,
      semantic_hash: ""
    },
    heartbeatAt + 10
  ));
  assert.equal(readyDuplicate.metadata.duplicate_pending, 1);
  assert.equal(readyDuplicate.metadata.ready, 0);
  const readyDecided = activeResult(await ingestionRepository.mutateSemantic(
    readyDuplicate.session,
    readyDuplicate.session.version,
    {
      ...readyDuplicate.session,
      duplicate_decision: "upload" as const,
      semantic_hash: ""
    },
    heartbeatAt + 11
  ));
  assert.equal(readyDecided.metadata.duplicate_pending, 0);
  assert.equal(readyDecided.metadata.ready, 1);
  const commitRequestId = coreUuid.randomUuidV7();
  const committing = activeResult(await ingestionRepository.mutateSemantic(
    readyDecided.session,
    readyDecided.session.version,
    {
      ...readyDecided.session,
      status: "committing" as const,
      phase: "committing" as const,
      message: "committing",
      progress: null,
      execution_token: coreUuid.randomUuidV7(),
      commit: {
        commit_request_id: commitRequestId,
        commit_intent_hash: "2".repeat(64),
        created_by: ingestionOwner,
        expected_md5: preparedManifest.md5,
        duplicate_decision: "upload" as const,
        metadata: { ...ingestionMetadata, tags: [] },
        final_object_key: imagePaths.storageObjectKey(readyDecided.session.image_id, "webp")
      },
      semantic_hash: ""
    },
    heartbeatAt + 12
  ));
  assert.equal(committing.metadata.committing_resolving, 1);
  assert.equal(committing.metadata.resolving, 0);
  assert.ok(Array.isArray(committing.session.metadata.tags));
  assert.ok(committing.session.commit);
  assert.ok(Array.isArray(committing.session.commit.metadata.tags));
  const committingRunnableScore = Number(await redisClient.redis.zscore(
    ingestionTestKeys.runnable,
    ingestionTestKeys.canonical
  ));
  assert.ok(
    Number.isSafeInteger(committingRunnableScore) && committingRunnableScore > 0
  );
  const stateBeforeCommittingDelete = await readIngestionBusinessState();
  await assert.rejects(productionIngestionRepository.deleteSession(
    committing.session as unknown as Parameters<typeof ingestionRepository.deleteSession>[0],
    committing.session.version,
    heartbeatAt + 13
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_session_state_conflict");
  assert.deepEqual(
    await readIngestionBusinessState(),
    stateBeforeCommittingDelete,
    "committing canonical 不能绕过 irreversible coordinator 被直接删除"
  );
  const resolvingCandidate = ingestionSessionTransitions.semanticIngestionSession(
    committing.session,
    {
      status: "resolving" as const,
      phase: "resolving" as const,
      message: "resolving",
      progress: null
    }
  );
  const resolvingUpload = activeResult(await ingestionRepository.expireSession(
    committing.session,
    committing.session.version,
    committing.session.discard_at,
    resolvingCandidate
  ));
  assert.equal(resolvingUpload.metadata.committing_resolving, 1);
  assert.equal(resolvingUpload.metadata.resolving, 1);
  await redisClient.redis.hdel(ingestionTestKeys.metadata, "resolving");
  await assert.rejects(
    productionIngestionRepository.snapshot(ingestionOwner, "upload", 0, 1),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid",
    "当前 metadata 缺少 resolving 子计数必须 fail closed，不能扫描队列修复"
  );
  await redisClient.redis.hset(ingestionTestKeys.metadata, "resolving", "1");
  assert.ok(
    resolvingUpload.session.discard_at > committing.session.discard_at,
    "过期 committing 进入 resolving 时必须在同一个 Lua 中刷新期限"
  );
  assert.equal(
    await redisClient.redis.zscore(
      ingestionTestKeys.runnable,
      ingestionTestKeys.canonical
    ),
    null
  );
  await assert.rejects(ingestionRepository.expireSession(
    resolvingUpload.session,
    resolvingUpload.session.version,
    committing.session.discard_at,
    ingestionSessionTransitions.semanticIngestionSession(
      resolvingUpload.session,
      { message: "stale expiry must not win" }
    )
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_session_not_expired");
  const completedReceipt = ingestionCommitCompletion.completedIngestionReceipt(
    resolvingUpload.session,
    heartbeatAt + 14
  );
  const publishedCompletionMutations: Parameters<typeof ingestionRepository.mutateSemantic>[] = [];
  const completionMutationClockLowerBound = Date.now();
  await ingestionCommitCompletion.publishCompletedReceipt(repositoryWithOverrides(ingestionRepository, {
    readSession: async () => resolvingUpload.session,
    mutateSemantic: async (...args) => {
      publishedCompletionMutations.push(args);
      return { changed: true, session: args[2], metadata: resolvingUpload.metadata };
    }
  }), resolvingUpload.session, heartbeatAt + 14);
  assert.equal(
    (publishedCompletionMutations[0]?.[2] as { completed_at?: number }).completed_at,
    heartbeatAt + 14,
    "完成回执必须保留 PostgreSQL 投影可见时冻结的完成水位"
  );
  assert.ok(
    requiredValue(publishedCompletionMutations[0]?.[3]) >= completionMutationClockLowerBound,
    "Redis TTL 变更必须使用发布时钟而非较早的数据库可见水位"
  );
  const stateBeforeInvalidCompletedIdentity = await readActiveSchemaState();
  const operationalBeforeInvalidCompletedIdentity = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  const invalidCompletedIdentities = [
    {
      receipt: { ...completedReceipt, commit_intent_hash: "x" },
      code: "ingestion_queue_structure_invalid"
    },
    {
      receipt: { ...completedReceipt, commit_intent_hash: "3".repeat(64) },
      code: "ingestion_session_state_conflict"
    },
    {
      receipt: {
        ...completedReceipt,
        commit_request_id: coreUuid.randomUuidV7()
      },
      code: "ingestion_session_state_conflict"
    },
    {
      receipt: {
        ...completedReceipt,
        display: {
          ...completedReceipt.display,
          original_width: 0
        }
      },
      code: "ingestion_queue_structure_invalid"
    }
  ];
  assert.throws(() => ingestionSessionCodec.parseStoredIngestionSession(
    JSON.stringify(invalidCompletedIdentities[0].receipt)
  ));
  for (const invalid of invalidCompletedIdentities) {
    await assert.rejects(productionIngestionRepository.mutateSemantic(
      resolvingUpload.session,
      resolvingUpload.session.version,
      (invalid.receipt) as unknown as StoredIngestionSession,
      heartbeatAt + 14
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === invalid.code);
    assert.deepEqual(
      await readActiveSchemaState(),
      stateBeforeInvalidCompletedIdentity,
      "completed receipt 必须绑定冻结的 commit request 与 intent hash"
    );
  }
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeInvalidCompletedIdentity,
    "completed identity 领域错误不得降级全局 Redis operational state"
  );
  const completedUpload = completedResult(await ingestionRepository.expireSession(
    resolvingUpload.session,
    resolvingUpload.session.version,
    resolvingUpload.session.discard_at,
    completedReceipt
  ));
  assert.equal(completedUpload.metadata.completed, 1);
  assert.equal(completedUpload.metadata.unfinished, 0);
  assert.equal(completedUpload.metadata.total, 1);
  const completedReceiptFields = [
    "owner",
    "queue",
    "session_id",
    "image_id",
    "request_hash",
    "commit_request_id",
    "commit_intent_hash",
    "status",
    "version",
    "last_semantic_revision",
    "accepted_at",
    "accepted_order",
    "completed_at",
    "display",
    "discard_at"
  ].sort();
  assert.deepEqual(
    Object.keys(completedUpload.session).sort(),
    completedReceiptFields,
    "completed Redis 收据不得保留 progress_seq、semantic_hash 或活动态字段"
  );
  assert.deepEqual(
    Object.keys(JSON.parse(requiredValue(await redisClient.redis.hget(
      ingestionTestKeys.canonical,
      "snapshot"
    )))).sort(),
    completedReceiptFields
  );
  const metadataBeforeTerminalMutation = completedUpload.metadata;
  await assert.rejects(ingestionRepository.mutateSemantic(
    completedUpload.session,
    completedUpload.session.version,
    completedUpload.session,
    heartbeatAt + 15
  ));
  assert.deepEqual(
    (await ingestionRepository.snapshot(ingestionOwner, "upload", 0, 10)).metadata,
    metadataBeforeTerminalMutation,
    "终态收据不得再走 semantic mutation"
  );
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5) VALUES ($1, $2, 'local', $3, 'pc', 'dark', "
      + "NULL, 'webp', $4)",
    [
      completedUpload.session.image_id,
      ingestionOwner,
      imagePaths.storageObjectKey(completedUpload.session.image_id, "webp"),
      "9".repeat(32)
    ]
  );
  const completedStatus = await ingestionSessionView.readIngestionStatuses(
    ingestionRepository,
    ingestionOwner,
    [{
      session_id: completedUpload.session.session_id,
      image_id: completedUpload.session.image_id
    }]
  );
  assert.equal(completedStatus[0].status, "completed");
  assert.equal(completedStatus[0].redis_status, "completed");
  assert.deepEqual(
    completedStatus[0].display,
    completedUpload.session.display
  );
  assert.equal(
    completedStatus[0].redis_last_semantic_revision,
    completedUpload.session.last_semantic_revision
  );
  const statusBarrierImageId = coreUuid.randomUuidV7();
  const statusBarrierReceipt = {
    ...completedUpload.session,
    session_id: "B".repeat(43),
    image_id: statusBarrierImageId
  };
  let statusBarrierDeleteAttempted = false;
  let statusBarrierPublished = false;
  let statusBarrierReads = 0;
  const statusBarrierRepository = repositoryWithOverrides(ingestionRepository, {
    async readSessions() {
      await database.pool.query(
        "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
          + "theme, ext, md5) VALUES ($1, $2, 'local', $3, 'pc', 'dark', "
          + "NULL, 'webp', $4)",
        [
          statusBarrierImageId,
          ingestionOwner,
          imagePaths.storageObjectKey(statusBarrierImageId, "webp"),
          "7".repeat(32)
        ]
      );
      statusBarrierPublished = true;
      return [statusBarrierReceipt];
    },
    async deleteSession() {
      statusBarrierDeleteAttempted = true;
      return completedUpload.metadata;
    }
  });
  const restoreStatusQueries = interceptSqlQueries(database.pool, async (sql, values, query) => {
    if (sql.includes("SELECT") && sql.includes("FROM metadata")
      && Array.isArray(values)
      && values.some((value) => Array.isArray(value)
        && value.length === 1 && value[0] === statusBarrierImageId)) {
      statusBarrierReads += 1;
      assert.equal(statusBarrierPublished, true,
        "status lookup must observe PostgreSQL after the completed receipt publication");
    }
    return query();
  });
  try {
    const statusAfterCompletedPublication = await ingestionSessionView
    .readIngestionStatuses(
      statusBarrierRepository,
      ingestionOwner,
      [{
        session_id: statusBarrierReceipt.session_id,
        image_id: statusBarrierImageId
      }]
    );
  assert.equal(statusAfterCompletedPublication[0].status, "completed");
  assert.equal(statusAfterCompletedPublication[0].redis_status, "completed");
  assert.ok(statusBarrierReads > 0, "the actual PostgreSQL status lookup must be observed");
  assert.equal(
    statusBarrierDeleteAttempted,
    false,
    "先观察到 Redis completed 后的 PG 查询不得误删有效回执"
  );
  } finally {
    restoreStatusQueries();
    await database.pool.query("DELETE FROM metadata WHERE id=$1", [statusBarrierImageId]);
  }
  const pgOnlyImageId = coreUuid.randomUuidV7();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, brightness, "
      + "theme, ext, md5) VALUES ($1, $2, 'local', $3, 'pc', 'dark', "
      + "NULL, 'webp', $4)",
    [
      pgOnlyImageId,
      ingestionOwner,
      imagePaths.storageObjectKey(pgOnlyImageId, "webp"),
      "8".repeat(32)
    ]
  );
  const pgOnlyStatus = await ingestionSessionView.readIngestionStatuses(
    ingestionRepository,
    ingestionOwner,
    [{ session_id: "P".repeat(43), image_id: pgOnlyImageId }]
  );
  assert.equal(pgOnlyStatus[0].status, "completed");
  assert.equal(pgOnlyStatus[0].redis_status, "missing");
  await database.pool.query("DELETE FROM metadata WHERE id=$1", [pgOnlyImageId]);
  const snapshotTokens = new ingestionTokenService.IngestionTokenService({
    rootKey: new Uint8Array(32).fill(37)
  });
  const snapshotScope = ingestionActionScope.openIngestionActionScope(
    { id: "snapshot-admin-session", username: ingestionOwner },
    "upload",
    () => undefined
  );
  const hydratedCompletedPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: snapshotTokens,
      session: { id: "snapshot-admin-session", username: ingestionOwner },
      actionScope: snapshotScope.id,
      queue: "upload" as const,
      offset: 0,
      limit: 10
    });
  assert.equal(hydratedCompletedPage.items.length, 1);
  assert.equal(hydratedCompletedPage.items[0].status, "completed");
  assert.deepEqual(
    hydratedCompletedPage.items[0].display,
    completedUpload.session.display
  );
  assert.equal(
    hydratedCompletedPage.items[0].completed_item.id,
    completedUpload.session.image_id
  );
  assert.deepEqual({
    total: hydratedCompletedPage.total,
    unfinished: hydratedCompletedPage.unfinished,
    waiting: hydratedCompletedPage.waiting,
    running: hydratedCompletedPage.running,
    ready: hydratedCompletedPage.ready,
    duplicate_pending: hydratedCompletedPage.duplicate_pending,
    committing: hydratedCompletedPage.committing,
    resolving: hydratedCompletedPage.resolving,
    completed: hydratedCompletedPage.completed,
    failed: hydratedCompletedPage.failed
  }, ingestionSessionProjection.presentIngestionQueueSummary(
    completedUpload.metadata
  ), "稳定 snapshot 顶层 summary 必须独立于 action watermark");
  const watermarkClaims = snapshotTokens.verify(
    "imageshow/ingestion/action/watermark",
    hydratedCompletedPage.action_watermark,
    (value): value is IngestionTokenEnvelope => value.action_scope === snapshotScope.id
      && value.owner === ingestionOwner
      && value.queue === "upload"
  );
  assert.equal(
    watermarkClaims.captured_queue_revision,
    hydratedCompletedPage.revision
  );
  assert.equal(
    watermarkClaims.max_accepted_order,
    completedUpload.metadata.last_accepted_order
  );

  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [completedUpload.session.image_id]
  );
  const stablePageAfterStaleCleanup = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: snapshotTokens,
      session: { id: "snapshot-admin-session", username: ingestionOwner },
      actionScope: snapshotScope.id,
      queue: "upload" as const,
      offset: 0,
      limit: 10
    });
  assert.equal(stablePageAfterStaleCleanup.items.length, 0);
  assert.equal(stablePageAfterStaleCleanup.total, 0);
  assert.equal(stablePageAfterStaleCleanup.completed, 0);
  assert.equal(await redisClient.redis.exists(ingestionTestKeys.canonical), 0);
  const metadataOnlyPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: snapshotTokens,
      session: { id: "snapshot-admin-session", username: ingestionOwner },
      actionScope: snapshotScope.id,
      queue: "upload" as const,
      offset: 500,
      limit: 0
    });
  assert.equal(metadataOnlyPage.offset, 500);
  assert.equal(metadataOnlyPage.limit, 0);
  assert.deepEqual(metadataOnlyPage.items, []);
  assert.ok(metadataOnlyPage.action_watermark);
  snapshotScope.close();
  await assert.rejects(ingestionQueueSnapshot.readStableIngestionQueueSnapshot({
    repository: ingestionRepository,
    tokens: snapshotTokens,
    session: { id: "snapshot-admin-session", username: ingestionOwner },
    actionScope: snapshotScope.id,
    queue: "upload" as const,
    offset: 0,
    limit: 10
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_action_scope_stale");
  assert.equal(
    stablePageAfterStaleCleanup.action_watermark.length
      <= sharedAppConfig.appConfig.ingestionRuntime.tokenMaxBytes,
    true
  );
  assert.ok(
    stablePageAfterStaleCleanup.revision > completedUpload.metadata.revision
  );
  await redisClient.redis.del(
    ingestionTestKeys.owner,
    ingestionTestKeys.metadata
  );
  await redisClient.redis.del(
    ingestionSessionKeys.ingestionUploadIntentKey(
      expiredIntentOwner,
      expiredIntentSessionId
    )
  );
});
