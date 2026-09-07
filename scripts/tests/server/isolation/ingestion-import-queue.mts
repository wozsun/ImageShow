import { activeResult, discardedResult } from "./ingestion-scenario-fixture.mts";
import assert from "node:assert/strict";
import type { IngestionSessionSnapshot, UploadIntentSnapshot } from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import { activeSession, requiredValue } from "./ingestion-scenario-fixture.mts";
import { createHash, randomUUID } from "node:crypto";
import { createIngestionScenarioFixture } from "./ingestion-scenario-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const sharedAppConfig = await import("@imageshow/shared");
const redisClient = await import("../../../../packages/server/src/core/redis/client.ts");
const runtimeAvailability = await import("../../../../packages/server/src/core/runtime-availability.ts");
const ingestionSessionTransitions = await import(
  "../../../../packages/server/src/images/ingestion/sessions/transitions.ts"
);
const ingestionSessionCodec = await import("../../../../packages/server/src/images/ingestion/sessions/codec.ts");
const ingestionSessionIdentity = await import("../../../../packages/server/src/images/ingestion/sessions/identity.ts");
const ingestionSessionProjection = await import(
  "../../../../packages/server/src/images/ingestion/sessions/projection.ts"
);
const ingestionSessionKeys = await import("../../../../packages/server/src/images/ingestion/sessions/keys.ts");
const coreUuid = await import("../../../../packages/server/src/core/uuid.ts");
const imageTime = await import("../../../../packages/server/src/images/image-time.ts");
const { ingestionRepository, productionIngestionRepository, serviceNow, displayOrderKey, ingestionMetadata } = await createIngestionScenarioFixture(runtime);
const importTtlMs = sharedAppConfig.appConfig.ingestionRuntime.importSessionIdleTtlSeconds * 1000;
  const importOwner = "current-import-domain-" + randomUUID();
  const importSessionId = ingestionSessionIdentity.createIngestionSessionId(
    importOwner,
    "import",
    "import-ttl"
  );
  const importResolvedTime = imageTime.parseImageTime(
    "2026-08-23T01:02:05.456Z"
  );
  const importImageId = imageTime.createImageId(importResolvedTime.date, 39);
  const importCreatedAt = 5_000;
  const importCanonicalWithoutHash = {
    owner: importOwner,
    queue: "import" as const,
    source_type: "url" as const,
    session_id: importSessionId,
    image_id: importImageId,
    image_time: importResolvedTime.iso,
    request_hash: "d".repeat(64),
    import_download: { url: "https://example.com/current-domain.jpg" },
    metadata: ingestionMetadata,
    storage_slug: "local",
    status: "queued" as const,
    phase: "queued" as const,
    message: "queued",
    progress: null,
    version: 0,
    progress_seq: 0,
    last_semantic_revision: 0,
    accepted_at: 0,
    accepted_order: 0,
    execution_token: "",
    raw_generation: "",
    raw_size: 0,
    discard_at: 0
  };
  const importCanonical = {
    ...importCanonicalWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      importCanonicalWithoutHash
    )
  };
  const malformedImportOwner = "current-malformed-import-" + randomUUID();
  const malformedImportSessionId = ingestionSessionIdentity.createIngestionSessionId(
    malformedImportOwner,
    "import",
    "malformed-create"
  );
  const malformedImportDisplayOrderKey = displayOrderKey(
    malformedImportSessionId,
    39,
    importCreatedAt
  );
  const malformedImportKeys = ingestionSessionKeys.ingestionSessionKeys(
    malformedImportOwner,
    "import",
    malformedImportSessionId
  );
  const readMalformedImportState = async () => ({
    canonicalType: await redisClient.redis.type(malformedImportKeys.canonical),
    ownerType: await redisClient.redis.type(malformedImportKeys.owner),
    metadataType: await redisClient.redis.type(malformedImportKeys.metadata),
    runnableScore: await redisClient.redis.zscore(
      malformedImportKeys.runnable,
      malformedImportKeys.canonical
    ),
    expiresScore: await redisClient.redis.zscore(
      malformedImportKeys.expires,
      malformedImportKeys.canonical
    ),
    runnableCount: await redisClient.redis.zcard(malformedImportKeys.runnable),
    expiresCount: await redisClient.redis.zcard(malformedImportKeys.expires)
  });
  const malformedImportStateBefore = await readMalformedImportState();
  await assert.rejects(ingestionRepository.acceptImportSession({
    ...importCanonical,
    owner: malformedImportOwner,
    session_id: malformedImportSessionId,
    request_hash: ""
  }, malformedImportDisplayOrderKey, importCreatedAt));
  await assert.rejects(ingestionRepository.acceptImportSession({
    ...importCanonical,
    owner: malformedImportOwner,
    session_id: malformedImportSessionId
  }, malformedImportDisplayOrderKey, Number.NaN));
  const {
    import_download: retainedImportDownload,
    ...importWithoutDownload
  } = importCanonical;
  const malformedImportSchemas = [
    {
      ...importWithoutDownload,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId
    },
    {
      ...importCanonical,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId,
      raw_path: "forbidden/path"
    },
    {
      ...importCanonical,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId,
      import_download: {
        ...importCanonical.import_download,
        response_body: "forbidden"
      }
    },
    {
      ...importCanonical,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId,
      import_download: null
    },
    {
      ...importCanonical,
      owner: malformedImportOwner,
      session_id: malformedImportSessionId,
      metadata: null
    }
  ];
  assert.ok(retainedImportDownload);
  const operationalBeforeMalformedImportSchemas = {
    ...runtimeAvailability.getRedisOperationalState()
  };
  for (const malformed of malformedImportSchemas) {
    assert.throws(() => ingestionSessionCodec.parseStoredIngestionSession(
      JSON.stringify({
        ...malformed,
        version: 1,
        last_semantic_revision: 1,
        accepted_at: importCreatedAt,
        accepted_order: 1,
        discard_at: importCreatedAt + importTtlMs
      })
    ));
    await assert.rejects(productionIngestionRepository.acceptImportSession(
      malformed as unknown as IngestionSessionSnapshot,
      malformedImportDisplayOrderKey,
      importCreatedAt
    ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid");
  }
  assert.deepEqual(
    runtimeAvailability.getRedisOperationalState(),
    operationalBeforeMalformedImportSchemas,
    "import_download/metadata null 必须按队列领域错误处理而不降级全局 Redis"
  );
  assert.deepEqual(
    await readMalformedImportState(),
    malformedImportStateBefore,
    "malformed canonical create 必须在任何 Redis 写入前失败"
  );
  let importListenerCalls = 0;
  ingestionRepository.subscribe(importOwner, "import", () => {
    importListenerCalls += 1;
  });
  const acceptedImport = activeResult(await ingestionRepository.acceptImportSession(
    importCanonical,
    displayOrderKey(importSessionId, 39, importCreatedAt),
    importCreatedAt
  ));
  assert.equal(
    acceptedImport.session.discard_at,
    importCreatedAt + importTtlMs
  );
  assert.equal(importListenerCalls, 1);
  const importTestKeys = ingestionSessionKeys.ingestionSessionKeys(
    importOwner,
    "import",
    importSessionId
  );
  const importSnapshot = await ingestionRepository.snapshot(
    importOwner,
    "import",
    0,
    10
  );
  assert.equal(importSnapshot.items.length, 1);
  assert.equal(
    importSnapshot.items[0].discard_at,
    acceptedImport.session.discard_at,
    "队列快照不得延长 Import 任务的逻辑有效期"
  );

  const discardOrderProbe = async (session: IngestionSessionSnapshot, now: number) => {
    const discarded = discardedResult(await ingestionRepository.mutateSemantic(
      session,
      session.version,
      ingestionSessionTransitions.discardedIngestionReceipt(session, now),
      now
    ));
    await ingestionRepository.deleteSession(
      discarded.session,
      discarded.session.version,
      now + 1
    );
  };
  const importOrderOwner = "current-display-order-import-" + randomUUID();
  const olderImportBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 1_000)
  );
  const newerImportBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 2_000)
  );
  const importOrderSessions = new Map();
  const acceptImportOrderProbe = async (batchKey: string, label: string, position: number, now: number) => {
    const sessionId = ingestionSessionIdentity.createIngestionSessionId(
      importOrderOwner,
      "import",
      label + "-" + String(position)
    );
    const resolved = imageTime.parseImageTime(
      "2026-08-23T01:10:" + String(position).padStart(2, "0") + ".456Z"
    );
    const withoutHash = {
      ...importCanonicalWithoutHash,
      owner: importOrderOwner,
      session_id: sessionId,
      image_id: imageTime.createImageId(resolved.date, position),
      image_time: resolved.iso,
      request_hash: createHash("sha256")
        .update(label + "-" + String(position))
        .digest("hex")
    };
    const accepted = activeResult(await ingestionRepository.acceptImportSession({
      ...withoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        withoutHash
      )
    }, ingestionSessionIdentity.createIngestionDisplayOrderKey(
      batchKey,
      position,
      sessionId
    ), now));
    importOrderSessions.set(label + "-" + String(position), accepted.session);
  };
  for (const position of [1, 0]) {
    await acceptImportOrderProbe(
      olderImportBatchKey,
      "older",
      position,
      serviceNow + 3_000 + position
    );
  }
  const scrambledNewerPositions = [5, 11, 2, 8, 0, 10, 4, 7, 1, 9, 3, 6];
  for (const [acceptIndex, position] of scrambledNewerPositions.entries()) {
    await acceptImportOrderProbe(
      newerImportBatchKey,
      "newer",
      position,
      serviceNow + 4_000 + acceptIndex
    );
  }
  const importOrderFirstPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    10
  );
  const importOrderSecondPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    10,
    10
  );
  assert.deepEqual(
    importOrderFirstPage.items.map((item) => item.session_id),
    Array.from({ length: 10 }, (_, position) => (
      importOrderSessions.get("newer-" + String(position)).session_id
    )),
    "新导入批次必须置顶，且第一页严格保持来源 1→N"
  );
  assert.deepEqual(
    importOrderSecondPage.items.map((item) => item.session_id),
    [
      importOrderSessions.get("newer-10").session_id,
      importOrderSessions.get("newer-11").session_id,
      importOrderSessions.get("older-0").session_id,
      importOrderSessions.get("older-1").session_id
    ],
    "批内来源顺序必须跨页稳定，旧批次紧随新批次"
  );
  const externalImportBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 3_000)
  );
  await acceptImportOrderProbe(
    externalImportBatchKey,
    "external",
    0,
    serviceNow + 18_000
  );
  const currentDocumentPairs = Array.from({ length: 12 }, (_, position) => {
    const session = importOrderSessions.get("newer-" + String(position));
    return {
      session_id: session.session_id,
      image_id: session.image_id
    };
  });
  const filteredImportPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    3,
    {
      excludeItems: currentDocumentPairs,
      includeItems: [currentDocumentPairs[0], currentDocumentPairs[11]]
    }
  );
  assert.deepEqual(
    filteredImportPage.items.map((item) => item.session_id),
    [
      importOrderSessions.get("external-0").session_id,
      importOrderSessions.get("older-0").session_id,
      importOrderSessions.get("older-1").session_id,
      importOrderSessions.get("newer-0").session_id,
      importOrderSessions.get("newer-11").session_id
    ],
    "快照须先排除当前文档 pair，再分页并原子补入当前页 canonical"
  );
  assert.deepEqual(filteredImportPage.staleItems, []);
  const staleCurrentDocumentTime = imageTime.parseImageTime(
    "2026-08-23T01:10:59.456Z"
  );
  const staleCurrentDocumentPair = {
    session_id: ingestionSessionIdentity.createIngestionSessionId(
      importOrderOwner,
      "import",
      "stale-current-document"
    ),
    image_id: imageTime.createImageId(staleCurrentDocumentTime.date, 0)
  };
  const mixedActiveAndStalePage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    3,
    {
      excludeItems: [...currentDocumentPairs, staleCurrentDocumentPair],
      includeItems: [currentDocumentPairs[0], currentDocumentPairs[11]]
    }
  );
  assert.deepEqual(
    mixedActiveAndStalePage.items.map((item) => ({
      session_id: item.session_id,
      image_id: item.image_id
    })),
    filteredImportPage.items.map((item) => ({
      session_id: item.session_id,
      image_id: item.image_id
    })),
    "active / stale 混合排除项不得改变过滤分页或原有顺序"
  );
  assert.deepEqual(
    mixedActiveAndStalePage.staleItems,
    [staleCurrentDocumentPair],
    "canonical、owner 与 display 均已退休的 pair 必须精确返回 stale"
  );
  const displacedDisplaySession = importOrderSessions.get("external-0");
  const displacedDisplayOrderKey = await redisClient.redis.hget(
    ingestionSessionKeys.ingestionCanonicalKey(
      importOrderOwner,
      displacedDisplaySession.session_id
    ),
    "display_order_key"
  );
  assert.ok(typeof displacedDisplayOrderKey === "string");
  const orphanDisplayOrderKey = ingestionSessionIdentity
    .createIngestionDisplayOrderKey(
      coreUuid.randomUuidV7At(new Date(serviceNow + 18_500)),
      0,
      staleCurrentDocumentPair.session_id
    );
  const importDisplayQueueKey = ingestionSessionKeys.ingestionDisplayQueueKey(
    importOrderOwner,
    "import"
  );
  assert.equal(
    await redisClient.redis.zrem(importDisplayQueueKey, displacedDisplayOrderKey),
    1
  );
  assert.equal(
    await redisClient.redis.zadd(importDisplayQueueKey, 0, orphanDisplayOrderKey),
    1
  );
  try {
    await assert.rejects(
      productionIngestionRepository.snapshot(
        importOrderOwner,
        "import",
        0,
        0,
        { excludeItems: [staleCurrentDocumentPair] }
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_queue_structure_invalid",
      "缺失 canonical 的 session 仍在 display 时必须报告真实孤儿投影"
    );
  } finally {
    await redisClient.redis.zrem(importDisplayQueueKey, orphanDisplayOrderKey);
    await redisClient.redis.zadd(
      importDisplayQueueKey,
      0,
      displacedDisplayOrderKey
    );
  }
  const beyondFilteredImportPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    9_000_000,
    3,
    { excludeItems: currentDocumentPairs }
  );
  assert.deepEqual(
    beyondFilteredImportPage.items,
    [],
    "巨大 offset 必须直接读取目标 rank，不能线性扫描队列前缀"
  );
  const staleIncludedSession = importOrderSessions.get("newer-0");
  await discardOrderProbe(staleIncludedSession, serviceNow + 19_000);
  const staleIncludedImportPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    3,
    {
      excludeItems: currentDocumentPairs,
      includeItems: [currentDocumentPairs[0], currentDocumentPairs[11]]
    }
  );
  assert.deepEqual(
    staleIncludedImportPage.items.map((item) => item.session_id),
    [
      importOrderSessions.get("external-0").session_id,
      importOrderSessions.get("older-0").session_id,
      importOrderSessions.get("older-1").session_id,
      importOrderSessions.get("newer-11").session_id
    ],
    "当前文档已释放的旧 pair 必须跳过，不能把正常状态变化误报为结构损坏"
  );
  assert.deepEqual(staleIncludedImportPage.staleItems, [
    currentDocumentPairs[0]
  ]);
  const replacementTime = imageTime.parseImageTime(
    "2026-08-23T01:11:00.456Z"
  );
  const replacementWithoutHash = {
    ...importCanonicalWithoutHash,
    owner: importOrderOwner,
    session_id: staleIncludedSession.session_id,
    image_id: imageTime.createImageId(replacementTime.date, 0),
    image_time: replacementTime.iso,
    request_hash: createHash("sha256")
      .update("newer-0-replacement")
      .digest("hex")
  };
  const replacement = activeResult(await ingestionRepository.acceptImportSession({
    ...replacementWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      replacementWithoutHash
    )
  }, ingestionSessionIdentity.createIngestionDisplayOrderKey(
    coreUuid.randomUuidV7At(new Date(serviceNow + 19_500)),
    0,
    staleIncludedSession.session_id
  ), serviceNow + 19_500));
  const replacedIncarnationPage = await ingestionRepository.snapshot(
    importOrderOwner,
    "import",
    0,
    3,
    {
      excludeItems: currentDocumentPairs,
      includeItems: [currentDocumentPairs[0]]
    }
  );
  assert.deepEqual(replacedIncarnationPage.staleItems, [
    currentDocumentPairs[0]
  ]);
  assert.equal(
    replacedIncarnationPage.items.filter((item) => (
      item.session_id === replacement.session.session_id
      && item.image_id === replacement.session.image_id
    )).length,
    1,
    "同 session 新 incarnation 必须进入正常 Server 页且旧 pair 只作为 stale 返回"
  );
  await discardOrderProbe(replacement.session, serviceNow + 19_750);
  const importOrderActionPage = await ingestionRepository.scanAction(
    importOrderOwner,
    "import",
    importOrderSecondPage.metadata.last_accepted_order,
    importOrderSecondPage.metadata.last_accepted_order === 0 ? 0 : 1,
    20
  );
  assert.deepEqual(
    importOrderActionPage.items.map((item) => item.accepted_order),
    importOrderActionPage.items.map((item) => item.accepted_order)
      .toSorted((left, right) => left - right),
    "动作候选必须在冻结水位内按 accepted-order 递增扫描"
  );
  for (const session of importOrderSessions.values()) {
    if (session.session_id === staleIncludedSession.session_id) continue;
    await discardOrderProbe(session, serviceNow + 20_000);
  }

  const staleScaleOwner = "current-stale-scale-" + randomUUID();
  const staleScaleCount = 3_600;
  const staleScaleBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 21_000)
  );
  const staleScaleTime = imageTime.parseImageTime(
    "2026-08-23T01:30:00.456Z"
  );
  const staleScaleMissingTime = imageTime.parseImageTime(
    "2026-08-23T01:31:00.456Z"
  );
  const staleScaleSeedSessionId = ingestionSessionIdentity
    .createIngestionSessionId(staleScaleOwner, "import", "active-seed");
  const staleScaleKeys = ingestionSessionKeys.ingestionSessionKeys(
    staleScaleOwner,
    "import",
    staleScaleSeedSessionId
  );
  const staleScaleCanonicalKeys = [];
  const staleScaleActiveSessionIds = [];
  const staleScaleMissingPairs = [];
  const staleScaleOwnerMembers = [];
  const staleScaleDisplayMembers = [];
  const staleScaleRunnableMembers = [];
  const staleScaleExpiryMembers = [];
  try {
    const staleScaleFixture = redisClient.redis.pipeline();
    const discardAt = serviceNow + 86_400_000;
    for (let position = 0; position < staleScaleCount; position += 1) {
      const acceptedOrder = position + 1;
      const sessionId = ingestionSessionIdentity.createIngestionSessionId(
        staleScaleOwner,
        "import",
        "active-" + String(position)
      );
      const imageId = imageTime.createImageId(staleScaleTime.date, position);
      const displayKey = ingestionSessionIdentity.createIngestionDisplayOrderKey(
        staleScaleBatchKey,
        position,
        sessionId
      );
      const canonicalKey = ingestionSessionKeys.ingestionCanonicalKey(
        staleScaleOwner,
        sessionId
      );
      const snapshotWithoutHash = {
        ...importCanonicalWithoutHash,
        owner: staleScaleOwner,
        session_id: sessionId,
        image_id: imageId,
        image_time: staleScaleTime.iso,
        request_hash: createHash("sha256")
          .update("stale-scale-active-" + String(position))
          .digest("hex"),
        batch_position: position,
        version: 1,
        last_semantic_revision: acceptedOrder,
        accepted_at: serviceNow + 21_000 + position,
        accepted_order: acceptedOrder,
        discard_at: discardAt
      };
      const snapshot = {
        ...snapshotWithoutHash,
        semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
          snapshotWithoutHash
        )
      };
      staleScaleCanonicalKeys.push(canonicalKey);
      staleScaleActiveSessionIds.push(sessionId);
      staleScaleOwnerMembers.push(acceptedOrder, sessionId);
      staleScaleDisplayMembers.push(0, displayKey);
      staleScaleRunnableMembers.push(acceptedOrder, canonicalKey);
      staleScaleExpiryMembers.push(discardAt, canonicalKey);
      staleScaleMissingPairs.push({
        session_id: ingestionSessionIdentity.createIngestionSessionId(
          staleScaleOwner,
          "import",
          "missing-" + String(position)
        ),
        image_id: imageTime.createImageId(staleScaleMissingTime.date, position)
      });
      staleScaleFixture.hset(
        canonicalKey,
        "snapshot", JSON.stringify(snapshot),
        "session_id", sessionId,
        "image_id", imageId,
        "owner", staleScaleOwner,
        "queue", "import",
        "status", "queued",
        "version", "1",
        "request_hash", snapshot.request_hash,
        "accepted_order", String(acceptedOrder),
        "display_order_key", displayKey,
        "discard_at", String(discardAt),
        "last_semantic_revision", String(acceptedOrder)
      );
    }
    staleScaleFixture.zadd(staleScaleKeys.owner, ...staleScaleOwnerMembers);
    staleScaleFixture.zadd(staleScaleKeys.display, ...staleScaleDisplayMembers);
    staleScaleFixture.zadd(staleScaleKeys.runnable, ...staleScaleRunnableMembers);
    staleScaleFixture.zadd(staleScaleKeys.expires, ...staleScaleExpiryMembers);
    staleScaleFixture.hset(
      staleScaleKeys.metadata,
      "owner", staleScaleOwner,
      "queue", "import",
      "revision", String(staleScaleCount),
      "last_accepted_order", String(staleScaleCount),
      "total", String(staleScaleCount),
      "unfinished", String(staleScaleCount),
      "waiting", String(staleScaleCount),
      "running", "0",
      "ready", "0",
      "duplicate_pending", "0",
      "committing_resolving", "0",
      "resolving", "0",
      "completed", "0",
      "failed", "0"
    );
    const staleScaleFixtureResult = await staleScaleFixture.exec();
    assert.ok(
      staleScaleFixtureResult
        && staleScaleFixtureResult.every(([error]) => error === null),
      "3,600 项合成队列夹具必须完整建立"
    );

    await redisClient.redis.call("CONFIG", "RESETSTAT");
    const staleScaleSnapshot = await productionIngestionRepository.snapshot(
      staleScaleOwner,
      "import",
      0,
      20,
      { excludeItems: staleScaleMissingPairs }
    );
    const staleScaleCommandStats = redisClient.parseRedisInfoFields(
      await redisClient.redis.info("commandstats")
    );
    const staleScaleZscanCalls = Number(
      staleScaleCommandStats.get("cmdstat_zscan")
        ?.split(",", 1)[0]
        ?.replace("calls=", "") ?? "0"
    );
    assert.deepEqual(
      staleScaleSnapshot.items.map((item) => item.session_id),
      staleScaleActiveSessionIds.slice(0, 20),
      "3,600 个 stale exclusion 不得改变非空大队列第一页顺序"
    );
    assert.deepEqual(
      staleScaleSnapshot.staleItems,
      staleScaleMissingPairs,
      "3,600 个已退休 pair 必须按请求顺序精确返回 stale"
    );
    assert.ok(
      staleScaleZscanCalls > 0 && staleScaleZscanCalls <= 64,
      "display ZSET 必须只扫描一遍，实际 ZSCAN 次数："
        + String(staleScaleZscanCalls)
    );
  } finally {
    const staleScaleCleanup = redisClient.redis.pipeline();
    for (
      let offset = 0;
      offset < staleScaleCanonicalKeys.length;
      offset += 250
    ) {
      const keys = staleScaleCanonicalKeys.slice(offset, offset + 250);
      if (keys.length > 0) {
        staleScaleCleanup.zrem(staleScaleKeys.runnable, ...keys);
        staleScaleCleanup.zrem(staleScaleKeys.expires, ...keys);
        staleScaleCleanup.unlink(...keys);
      }
    }
    staleScaleCleanup.unlink(
      staleScaleKeys.owner,
      staleScaleKeys.display,
      staleScaleKeys.metadata
    );
    const staleScaleCleanupResult = await staleScaleCleanup.exec();
    assert.ok(
      staleScaleCleanupResult
        && staleScaleCleanupResult.every(([error]) => error === null),
      "3,600 项合成队列夹具必须完整清理"
    );
  }

  const uploadOrderOwner = "current-display-order-upload-" + randomUUID();
  const uploadOrderBatchKey = coreUuid.randomUuidV7At(
    new Date(serviceNow + 30_000)
  );
  const uploadOrderTime = imageTime.parseImageTime(
    "2026-08-23T01:20:00.456Z"
  );
  const uploadOrderIntents: UploadIntentSnapshot[] = [];
  for (let position = 0; position < 5; position += 1) {
    const sessionId = ingestionSessionIdentity.createIngestionSessionId(
      uploadOrderOwner,
      "upload",
      "upload-order-" + String(position)
    );
    const requestHash = createHash("sha256")
      .update("upload-order-" + String(position))
      .digest("hex");
    const created = await ingestionRepository.createUploadIntent({
      owner: uploadOrderOwner,
      session_id: sessionId,
      candidate_image_id: imageTime.createImageId(
        uploadOrderTime.date,
        position
      ),
      resolved_image_time: uploadOrderTime.iso,
      request_hash: requestHash,
      display_order_key: ingestionSessionIdentity.createIngestionDisplayOrderKey(
        uploadOrderBatchKey,
        position,
        sessionId
      ),
      batch_position: position,
      metadata: ingestionMetadata,
      storage_slug: "local",
      expected_size: 10,
      max_long_edge: 1_000,
      created_at: serviceNow + 31_000,
      expires_at: 0,
      execution_token: "",
      claim_heartbeat_at: 0
    });
    assert.ok(created.kind === "intent");
    uploadOrderIntents[position] = created.intent;
  }
  const convertedUploadOrderSessions: IngestionSessionSnapshot[] = [];
  for (const [conversionIndex, position] of [4, 1, 3, 0, 2].entries()) {
    const intent = uploadOrderIntents[position];
    assert.ok(intent);
    const token = coreUuid.randomUuidV7();
    await ingestionRepository.claimUploadIntent(
      uploadOrderOwner,
      {
        session_id: intent.session_id,
        candidate_image_id: intent.candidate_image_id,
        request_hash: intent.request_hash
      },
      token,
      serviceNow + 32_000 + conversionIndex
    );
    const withoutHash = {
      owner: uploadOrderOwner,
      queue: "upload" as const,
      source_type: "upload" as const,
      session_id: intent.session_id,
      image_id: intent.candidate_image_id,
      image_time: intent.resolved_image_time,
      request_hash: intent.request_hash,
      metadata: intent.metadata,
      storage_slug: intent.storage_slug,
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
      raw_size: intent.expected_size,
      discard_at: 0
    };
    convertedUploadOrderSessions[position] = activeSession((
      await ingestionRepository.convertUploadIntent({
        ...withoutHash,
        semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
          withoutHash
        )
      }, token, serviceNow + 33_000 + conversionIndex)
    ).session);
  }
  const uploadOrderSnapshot = await ingestionRepository.snapshot(
    uploadOrderOwner,
    "upload",
    0,
    10
  );
  assert.deepEqual(
    uploadOrderSnapshot.items.map((item) => item.session_id),
    convertedUploadOrderSessions.map((item) => item.session_id),
    "Upload raw 接管完成顺序不得打乱同批来源 1→N"
  );
  for (const session of convertedUploadOrderSessions) {
    await discardOrderProbe(session, serviceNow + 40_000);
  }

  const runnableProbe = async (label: string, position: number, createdAt: number) => {
    const owner = "current-runnable-" + label + "-" + randomUUID();
    const sessionId = ingestionSessionIdentity.createIngestionSessionId(
      owner,
      "import",
      label
    );
    const withoutHash = {
      ...importCanonicalWithoutHash,
      owner,
      session_id: sessionId,
      image_id: imageTime.createImageId(importResolvedTime.date, position),
      request_hash: createHash("sha256").update(label).digest("hex")
    };
    const accepted = activeResult(await ingestionRepository.acceptImportSession({
      ...withoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(withoutHash)
    }, displayOrderKey(sessionId, position, createdAt), createdAt));
    return {
      accepted,
      keys: ingestionSessionKeys.ingestionSessionKeys(owner, "import", sessionId)
    };
  };
  const oldRunnableProbes = [];
  for (let index = 0; index < 3; index += 1) {
    oldRunnableProbes.push(await runnableProbe(
      "old-" + String(index),
      100 + index,
      importCreatedAt + 20 + index
    ));
  }
  let runnablePage = await ingestionRepository.discoverRunnablePage(0, 0, 1);
  const frozenRunnableTail = runnablePage.frozenTailScore;
  const frozenRunnableKeys = new Set(
    runnablePage.items.map((item) => item.canonicalKey)
  );
  const newRunnableProbes = [];
  for (let index = 0; index < 3; index += 1) {
    newRunnableProbes.push(await runnableProbe(
      "new-" + String(index),
      110 + index,
      importCreatedAt + 30 + index
    ));
  }
  while (
    runnablePage.scanned
    && runnablePage.lastScannedScore < frozenRunnableTail
  ) {
    runnablePage = await ingestionRepository.discoverRunnablePage(
      runnablePage.lastScannedScore,
      frozenRunnableTail,
      1
    );
    for (const item of runnablePage.items) {
      frozenRunnableKeys.add(item.canonicalKey);
    }
  }
  assert.ok(oldRunnableProbes.every(
    (probe) => frozenRunnableKeys.has(probe.keys.canonical)
  ));
  assert.ok(newRunnableProbes.every(
    (probe) => !frozenRunnableKeys.has(probe.keys.canonical)
  ), "冻结尾部后的低 accepted_order 新 owner 不得把旧任务推出本轮扫描");
  const runnableProbeScores = await Promise.all([
    ...oldRunnableProbes,
    ...newRunnableProbes
  ].map((probe) => redisClient.redis.zscore(
    probe.keys.runnable,
    probe.keys.canonical
  )));
  assert.ok(runnableProbeScores.every((score) => score !== null));
  assert.ok(runnableProbeScores.every((score, index, scores) => (
    index === 0 || Number(score) > Number(scores[index - 1])
  )), "全局 runnable score 必须与各 owner 的 accepted_order 独立递增");
  assert.ok([
    ...oldRunnableProbes,
    ...newRunnableProbes
  ].every((probe) => probe.accepted.session.accepted_order === 1));
  const nextRunnablePassKeys = new Set();
  const runnableScanBatchSize = sharedAppConfig.appConfig.ingestionRuntime
    .ingestionSessionScanBatchSize;
  runnablePage = await ingestionRepository.discoverRunnablePage(
    0,
    0,
    runnableScanBatchSize
  );
  while (true) {
    for (const item of runnablePage.items) {
      nextRunnablePassKeys.add(item.canonicalKey);
    }
    if (
      !runnablePage.scanned
      || runnablePage.lastScannedScore >= runnablePage.frozenTailScore
    ) break;
    runnablePage = await ingestionRepository.discoverRunnablePage(
      runnablePage.lastScannedScore,
      runnablePage.frozenTailScore,
      runnableScanBatchSize
    );
  }
  assert.ok(newRunnableProbes.every(
    (probe) => nextRunnablePassKeys.has(probe.keys.canonical)
  ));
  for (const probe of [...oldRunnableProbes, ...newRunnableProbes]) {
    await redisClient.redis
      .multi()
      .zrem(probe.keys.runnable, probe.keys.canonical)
      .zrem(probe.keys.expires, probe.keys.canonical)
      .del(probe.keys.canonical, probe.keys.owner, probe.keys.metadata)
      .exec();
  }
  await redisClient.redis.zrem(
    importTestKeys.runnable,
    importTestKeys.canonical
  );
  await assert.rejects(ingestionRepository.snapshot(
    importOwner,
    "import",
    0,
    10
  ));
  await redisClient.redis.zadd(
    importTestKeys.runnable,
    acceptedImport.session.accepted_order,
    importTestKeys.canonical
  );
  await redisClient.redis.zrem(
    importTestKeys.expires,
    importTestKeys.canonical
  );
  await assert.rejects(ingestionRepository.snapshot(
    importOwner,
    "import",
    0,
    10
  ));
  await redisClient.redis.zadd(
    importTestKeys.expires,
    acceptedImport.session.discard_at,
    importTestKeys.canonical
  );
  const expiredImportWithoutHash = {
    ...acceptedImport.session,
    status: "failed" as const,
    error: { code: "expired", message: "expired" },
    semantic_hash: ""
  };
  await assert.rejects(ingestionRepository.mutateSemantic(
    acceptedImport.session,
    acceptedImport.session.version,
    {
      ...expiredImportWithoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        expiredImportWithoutHash
      )
    },
    acceptedImport.session.discard_at
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_session_expired");
  const downloadingImport = activeResult(await ingestionRepository.mutateSemantic(
    acceptedImport.session,
    acceptedImport.session.version,
    {
      ...acceptedImport.session,
      status: "downloading" as const,
      phase: "downloading" as const,
      message: "downloading",
      progress: 0,
      execution_token: coreUuid.randomUuidV7(),
      semantic_hash: ""
    },
    importCreatedAt + 1
  ));
  assert.equal(downloadingImport.metadata.waiting, 0);
  assert.equal(downloadingImport.metadata.running, 1);
  assert.equal(
    await redisClient.redis.zscore(
      importTestKeys.runnable,
      importTestKeys.canonical
    ),
    null
  );
  const receivedImport = activeResult(await ingestionRepository.mutateSemantic(
    downloadingImport.session,
    downloadingImport.session.version,
    {
      ...downloadingImport.session,
      status: "received" as const,
      phase: "received" as const,
      message: "received",
      progress: 100,
      execution_token: "",
      raw_generation: coreUuid.randomUuidV7(),
      raw_size: 10,
      semantic_hash: ""
    },
    importCreatedAt + 2
  ));
  assert.equal(receivedImport.metadata.waiting, 1);
  assert.equal(receivedImport.metadata.running, 0);
  const receivedRunnableScore = Number(await redisClient.redis.zscore(
    importTestKeys.runnable,
    importTestKeys.canonical
  ));
  assert.ok(
    Number.isSafeInteger(receivedRunnableScore) && receivedRunnableScore > 0
  );
  const failedImport = activeResult(await ingestionRepository.mutateSemantic(
    receivedImport.session,
    receivedImport.session.version,
    {
      ...receivedImport.session,
      status: "failed" as const,
      phase: "failed" as const,
      message: "failed",
      progress: null,
      execution_token: "",
      error: { code: "download_failed", message: "failed" },
      semantic_hash: ""
    },
    importCreatedAt + 3
  ));
  assert.equal(failedImport.metadata.waiting, 0);
  assert.equal(failedImport.metadata.running, 0);
  assert.equal(failedImport.metadata.failed, 1);
  const retriedImport = activeResult(await ingestionRepository.mutateSemantic(
    failedImport.session,
    failedImport.session.version,
    {
      ...failedImport.session,
      status: "queued" as const,
      phase: "queued" as const,
      message: "queued again",
      progress: null,
      execution_token: "",
      raw_generation: "",
      raw_size: 0,
      error: undefined,
      semantic_hash: ""
    },
    importCreatedAt + 4
  ));
  assert.equal(retriedImport.metadata.waiting, 1);
  assert.equal(retriedImport.metadata.running, 0);
  assert.equal(retriedImport.metadata.failed, 0);
  const discardedImport = discardedResult(await ingestionRepository.expireSession(
    retriedImport.session,
    retriedImport.session.version,
    retriedImport.session.discard_at,
    ingestionSessionTransitions.discardedIngestionReceipt(
      retriedImport.session,
      importCreatedAt + 5
    )
  ));
  assert.ok(discardedImport.session);
  assert.equal(discardedImport.session.status, "discarded");
  assert.equal(discardedImport.session.image_time, importResolvedTime.iso);
  const discardedReceiptFields = [
    "owner",
    "queue",
    "session_id",
    "image_id",
    "image_time",
    "request_hash",
    "status",
    "version",
    "last_semantic_revision",
    "accepted_at",
    "accepted_order",
    "discarded_at",
    "discard_at"
  ].sort();
  assert.deepEqual(
    Object.keys(discardedImport.session).sort(),
    discardedReceiptFields,
    "discarded Redis 收据不得保留 progress_seq、semantic_hash 或活动态字段"
  );
  assert.deepEqual(
    Object.keys(JSON.parse(requiredValue(await redisClient.redis.hget(
      importTestKeys.canonical,
      "snapshot"
    )))).sort(),
    discardedReceiptFields
  );
  assert.equal(discardedImport.metadata.total, 0);
  assert.equal(discardedImport.metadata.unfinished, 0);
  assert.equal(await redisClient.redis.zcard(importTestKeys.owner), 0);
  const importEventsBeforeReuse = importListenerCalls;
  const regeneratedImportTime = imageTime.parseImageTime(
    "2026-08-23T01:02:07.456Z"
  );
  const reusedDiscardedImport = discardedResult(await ingestionRepository.acceptImportSession(
    {
      ...importCanonical,
      image_id: imageTime.createImageId(regeneratedImportTime.date, 44),
      image_time: regeneratedImportTime.iso
    },
    displayOrderKey(importSessionId, 39, importCreatedAt),
    importCreatedAt + 6
  ));
  assert.equal(reusedDiscardedImport.created, false);
  assert.equal(reusedDiscardedImport.session.image_time, importResolvedTime.iso);
  assert.equal(importListenerCalls, importEventsBeforeReuse);
  await ingestionRepository.expireSession(
    discardedImport.session,
    discardedImport.session.version,
    discardedImport.session.discard_at
  );
  assert.equal(
    importListenerCalls,
    importEventsBeforeReuse,
    "删除 owner 不可见的 discarded tombstone 不得发送事件"
  );
  assert.equal(
    await redisClient.redis.hget(importTestKeys.metadata, "last_accepted_order"),
    String(discardedImport.metadata.last_accepted_order)
  );
  await redisClient.redis.hset(
    importTestKeys.metadata,
    "last_accepted_order",
    String(Number.MAX_SAFE_INTEGER)
  );
  const exhaustedOrderSessionId = ingestionSessionIdentity.createIngestionSessionId(
    importOwner,
    "import",
    "exhausted-order"
  );
  const exhaustedOrderImageId = imageTime.createImageId(
    importResolvedTime.date,
    45
  );
  const exhaustedOrderWithoutHash = {
    ...importCanonicalWithoutHash,
    session_id: exhaustedOrderSessionId,
    image_id: exhaustedOrderImageId,
    request_hash: "6".repeat(64)
  };
  await assert.rejects(ingestionRepository.acceptImportSession({
    ...exhaustedOrderWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      exhaustedOrderWithoutHash
    )
  }, displayOrderKey(
    exhaustedOrderSessionId,
    45,
    importCreatedAt + 8
  ), importCreatedAt + 8));
  const exhaustedOrderKeys = ingestionSessionKeys.ingestionSessionKeys(
    importOwner,
    "import",
    exhaustedOrderSessionId
  );
  assert.equal(await redisClient.redis.exists(exhaustedOrderKeys.canonical), 0);
  assert.equal(await redisClient.redis.zcard(exhaustedOrderKeys.owner), 0);
  assert.equal(
    await redisClient.redis.hget(importTestKeys.metadata, "last_accepted_order"),
    String(Number.MAX_SAFE_INTEGER)
  );
  await redisClient.redis.del(
    importTestKeys.owner,
    importTestKeys.display,
    importTestKeys.metadata
  );

  const blockedCreateOwner = "current-blocked-create-" + randomUUID();
  const blockedCreateSessionId = ingestionSessionIdentity.createIngestionSessionId(
    blockedCreateOwner,
    "import",
    "wrong-index-type"
  );
  const blockedCreateImageId = imageTime.createImageId(
    importResolvedTime.date,
    40
  );
  const blockedCreateWithoutHash = {
    ...importCanonicalWithoutHash,
    owner: blockedCreateOwner,
    session_id: blockedCreateSessionId,
    image_id: blockedCreateImageId,
    request_hash: "e".repeat(64)
  };
  const blockedCreate = {
    ...blockedCreateWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      blockedCreateWithoutHash
    )
  };
  await redisClient.redis.set(importTestKeys.expires, "wrong-type");
  await assert.rejects(ingestionRepository.acceptImportSession(
    blockedCreate,
    displayOrderKey(blockedCreateSessionId, 40, importCreatedAt + 8),
    importCreatedAt + 8
  ));
  const blockedCreateKeys = ingestionSessionKeys.ingestionSessionKeys(
    blockedCreateOwner,
    "import",
    blockedCreateSessionId
  );
  assert.equal(await redisClient.redis.exists(blockedCreateKeys.canonical), 0);
  assert.equal(await redisClient.redis.exists(blockedCreateKeys.metadata), 0);
  assert.equal(await redisClient.redis.zcard(blockedCreateKeys.owner), 0);
  assert.equal(await redisClient.redis.get(importTestKeys.expires), "wrong-type");
  await redisClient.redis.del(importTestKeys.expires);

});
