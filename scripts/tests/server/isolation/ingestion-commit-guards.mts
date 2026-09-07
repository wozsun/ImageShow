import { activeSession, preparedSession, committingSession, completedSession } from "./ingestion-scenario-fixture.mts";
import { repositoryWithOverrides } from "./ingestion-scenario-fixture.mts";
import assert from "node:assert/strict";
import { removeDriverObject } from "./storage-fixture.mts";
import { interceptSqlQueries } from "./database-faults.mts";
import { createHash, randomUUID } from "node:crypto";
import { createIngestionScenarioFixture } from "./ingestion-scenario-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const cleanupJob = await import("../../../../packages/server/src/storage/cleanup/job.ts");
const jobs = await import("../../../../packages/server/src/jobs/repository.ts");
const registry = await import("../../../../packages/server/src/storage/backends/registry.ts");
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const runtimeConfigStore = await import("../../../../packages/server/src/config/runtime-config-store.ts");
const objectAccess = await import("../../../../packages/server/src/storage/objects/access.ts");
const redisClient = await import("../../../../packages/server/src/core/redis/client.ts");
const ingestionSessionTransitions = await import(
  "../../../../packages/server/src/images/ingestion/sessions/transitions.ts"
);
const ingestionCommitIntent = await import("../../../../packages/server/src/images/ingestion/commit/intent.ts");
const ingestionCommitWorker = await import("../../../../packages/server/src/images/ingestion/commit/worker.ts");
const ingestionIrreversibleCoordinator = await import(
  "../../../../packages/server/src/images/ingestion/execution/irreversible-coordinator.ts"
);
const ingestionQueueActionHandlers = await import(
  "../../../../packages/server/src/images/ingestion/queue/action-handlers.ts"
);
const ingestionSessionUpdate = await import("../../../../packages/server/src/images/ingestion/queue/session-update.ts");
const ingestionSessionIdentity = await import("../../../../packages/server/src/images/ingestion/sessions/identity.ts");
const ingestionSessionProjection = await import(
  "../../../../packages/server/src/images/ingestion/sessions/projection.ts"
);
const ingestionSessionKeys = await import("../../../../packages/server/src/images/ingestion/sessions/keys.ts");
const ingestionStagingKeys = await import("../../../../packages/server/src/images/ingestion/staging-keys.ts");
const coreUuid = await import("../../../../packages/server/src/core/uuid.ts");
const imageTime = await import("../../../../packages/server/src/images/image-time.ts");
const { ingestionRepository, displayOrderKey, ingestionMetadata, importTemplate: importCanonicalWithoutHash } = await createIngestionScenarioFixture(runtime);
const originalRuntimeConfig = structuredClone(runtimeConfigStore.getRuntimeConfig());
  const commitActor = "current-commit-actor-" + randomUUID();
  const commitSessionId = ingestionSessionIdentity.createIngestionSessionId(
    commitActor,
    "import",
    "real-commit"
  );
  const commitImageTime = imageTime.parseImageTime(
    "2026-08-23T01:02:06.456Z"
  );
  const commitImageId = imageTime.createImageId(commitImageTime.date, 46);
  const commitAcceptedAt = Date.now();
  const commitQueuedWithoutHash = {
    ...importCanonicalWithoutHash,
    owner: commitActor,
    source_type: "weibo" as const,
    session_id: commitSessionId,
    image_id: commitImageId,
    image_time: commitImageTime.iso,
    request_hash: createHash("sha256")
      .update("real-commit-" + commitImageId)
      .digest("hex"),
    import_download: { url: "https://example.com/real-commit.webp" },
    metadata: {
      ...ingestionMetadata,
      title: "real commit actor",
      source: "https://weibo.com/1234567890/PolicyDraft",
      original: "https://submitted.example.com/policy-draft.webp"
    }
  };
  const commitQueued = activeSession((await ingestionRepository.acceptImportSession({
    ...commitQueuedWithoutHash,
    semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
      commitQueuedWithoutHash
    )
  }, displayOrderKey(
    commitSessionId,
    46,
    commitAcceptedAt
  ), commitAcceptedAt)).session);
  const commitPreparationToken = coreUuid.randomUuidV7();
  const commitGeneration = coreUuid.randomUuidV7();
  const commitImageKey = ingestionStagingKeys.ingestionStagingImageKey({
    session_id: commitSessionId,
    image_id: commitImageId,
    generation: commitGeneration,
    execution_token: commitPreparationToken
  });
  const commitThumbnailKey = ingestionStagingKeys.ingestionStagingThumbnailKey({
    session_id: commitSessionId,
    image_id: commitImageId,
    generation: commitGeneration,
    execution_token: commitPreparationToken
  });
  const commitImageBody = Buffer.from("current-real-commit-image-" + commitImageId);
  const commitThumbnailBody = Buffer.from(
    "current-real-commit-thumbnail-" + commitImageId
  );
  await objectAccess.writeStorageBuffer(
    "_uploads",
    commitImageKey,
    commitImageBody,
    "image/webp",
    "local"
  );
  await objectAccess.writeStorageBuffer(
    "_uploads",
    commitThumbnailKey,
    commitThumbnailBody,
    "image/webp",
    "local"
  );
  const realPrepared = {
    prepared_image_key: commitImageKey,
    prepared_thumbnail_key: commitThumbnailKey,
    prepared_image_sha256: createHash("sha256")
      .update(commitImageBody)
      .digest("hex"),
    prepared_thumbnail_sha256: createHash("sha256")
      .update(commitThumbnailBody)
      .digest("hex"),
    original_size: commitImageBody.length,
    original_width: 1200,
    original_height: 800,
    width: 1200,
    height: 800,
    ext: "webp" as const,
    md5: createHash("md5").update(commitImageBody).digest("hex"),
    size: commitImageBody.length,
    thumbnail_size: commitThumbnailBody.length,
    quality: 90,
    transcoded: true,
    detected_device: "pc" as const,
    detected_brightness: "dark" as const,
    duplicate_count: 0,
    generation: commitGeneration
  };
  const commitReady = preparedSession((await ingestionRepository.mutateSemantic(
    commitQueued,
    commitQueued.version,
    ingestionSessionTransitions.semanticIngestionSession(commitQueued, {
      status: "ready" as const,
      phase: "ready" as const,
      message: "ready for real commit",
      progress: 100,
      execution_token: "",
      prepared: realPrepared
    }),
    commitAcceptedAt + 1
  )).session);
  const [directPolicyUpdate] = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    commitActor,
    [{
      session_id: commitReady.session_id,
      image_id: commitReady.image_id,
      expected_version: commitReady.version,
      metadata: {
        ...commitReady.metadata,
        source: "https://weibo.com/1234567890/DirectUpdate",
        original: "https://submitted.example.com/direct-update.webp"
      }
    }]
  );
  assert.equal(directPolicyUpdate.status, "changed");
  const afterDirectPolicyUpdate = activeSession(await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  ));
  const [bulkPolicyUpdate] = await ingestionQueueActionHandlers
    .executeIngestionQueueActionBatch({
      repository: ingestionRepository,
      coordinator: new (
        ingestionIrreversibleCoordinator.IngestionIrreversibleCoordinator
      )(),
      owner: commitActor,
      request: {
        queue: "import" as const,
        action_request_id: coreUuid.randomUuidV7(),
        action: "apply_metadata" as const,
        action_watermark: "batch-handler-receives-verified-watermark",
        metadata: {
          source: "https://weibo.com/1234567890/BulkUpdate",
          original: "https://submitted.example.com/bulk-update.webp"
        }
      },
      sessions: [afterDirectPolicyUpdate],
      capturedRevision: afterDirectPolicyUpdate.last_semantic_revision,
      abortActive: () => {},
      assertScope: () => {}
    });
  assert.equal(bulkPolicyUpdate.status, "changed");
  const commitPolicyReady = preparedSession(await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  ));
  const realCommitRequest = {
    session_id: commitSessionId,
    image_id: commitImageId,
    expected_version: commitPolicyReady.version,
    expected_md5: realPrepared.md5,
    commit_request_id: coreUuid.randomUuidV7(),
    duplicate_decision: "upload" as const,
    metadata: {
      ...commitPolicyReady.metadata,
      title: "committed by frozen actor",
      source: "https://weibo.com/1234567890/DirectCommit",
      original: "https://submitted.example.com/direct-commit.webp"
    }
  };
  const staleCommitRequest = {
    ...realCommitRequest,
    image_id: imageTime.createImageId(
      imageTime.parseImageTime("2026-08-23T01:02:08.456Z").date,
      47
    ),
    commit_request_id: coreUuid.randomUuidV7()
  };
  let concurrentCommitReads = 0;
  let releaseConcurrentCommitReads!: () => void;
  let releaseFirstConcurrentRead!: () => void;
  let releaseFirstConcurrentMutation!: () => void;
  const concurrentCommitReadBarrier = new Promise<void>((resolve) => {
    releaseConcurrentCommitReads = resolve;
  });
  const firstConcurrentRead = new Promise<void>((resolve) => {
    releaseFirstConcurrentRead = resolve;
  });
  const firstConcurrentMutation = new Promise<void>((resolve) => {
    releaseFirstConcurrentMutation = resolve;
  });
  const concurrentReadSessions: typeof ingestionRepository.readSessions = async (...args) => {
    const result = await ingestionRepository.readSessions(...args);
    concurrentCommitReads += 1;
    if (concurrentCommitReads === 1) releaseFirstConcurrentRead();
    if (concurrentCommitReads === 2) releaseConcurrentCommitReads();
    await concurrentCommitReadBarrier;
    return result;
  };
  const firstConcurrentCommitRepository = repositoryWithOverrides(ingestionRepository, {
    readSessions: concurrentReadSessions,
    mutateSemantic: async (...args) => {
      try {
        return await ingestionRepository.mutateSemantic(...args);
      } finally {
        releaseFirstConcurrentMutation();
      }
    }
  });
  const secondConcurrentCommitRepository = repositoryWithOverrides(ingestionRepository, {
    readSessions: concurrentReadSessions,
    mutateSemantic: async (...args) => {
      await firstConcurrentMutation;
      return ingestionRepository.mutateSemantic(...args);
    }
  });
  let overlappingCommitResults;
  const concurrentCommits: Array<ReturnType<
    typeof ingestionCommitIntent.acceptIngestionCommitIntents
  >> = [];
  await runtimeConfigStore.updateRuntimeConfig({
    import: { keep_original_link: ["url"] },
    weibo: { source_enabled: false }
  });
  try {
    const firstConcurrentCommit = ingestionCommitIntent
      .acceptIngestionCommitIntents(
        firstConcurrentCommitRepository,
        commitActor,
        [realCommitRequest]
      );
    concurrentCommits.push(firstConcurrentCommit);
    void firstConcurrentCommit.catch(() => undefined);
    await Promise.race([
      firstConcurrentRead,
      firstConcurrentCommit.then(() => assert.fail("first commit ended before the read barrier"))
    ]);
    await runtimeConfigStore.updateRuntimeConfig({
      import: { keep_original_link: ["url", "jsonl", "weibo"] },
      weibo: { source_enabled: true }
    });
    const secondConcurrentCommit = ingestionCommitIntent
      .acceptIngestionCommitIntents(
        secondConcurrentCommitRepository,
        commitActor,
        [realCommitRequest]
      );
    concurrentCommits.push(secondConcurrentCommit);
    void secondConcurrentCommit.catch(() => undefined);
    overlappingCommitResults = await Promise.all(concurrentCommits);
  } finally {
    releaseConcurrentCommitReads();
    releaseFirstConcurrentMutation();
    await Promise.allSettled(concurrentCommits);
    await runtimeConfigStore.updateRuntimeConfig({
      import: {
        keep_original_link: originalRuntimeConfig.import.keep_original_link
      },
      weibo: {
        source_enabled: originalRuntimeConfig.weibo.source_enabled
      }
    });
  }
  assert.deepEqual(
    overlappingCommitResults.map(([result]) => result.status),
    ["accepted", "accepted"],
    "重叠的相同提交意图必须在 CAS 冲突后收敛为已受理"
  );
  const realCommitAccepted = await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    commitActor,
    [staleCommitRequest, realCommitRequest]
  );
  assert.equal(realCommitAccepted[0].status, "failed");
  assert.equal(realCommitAccepted[0].code, "ingestion_incarnation_conflict");
  assert.equal(realCommitAccepted[1].status, "accepted");
  const firstFrozenCommitSession = committingSession(await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  ));
  assert.equal(firstFrozenCommitSession.status, "committing");
  assert.equal(firstFrozenCommitSession.commit.created_by, commitActor);
  assert.equal(firstFrozenCommitSession.commit.metadata.source, "");
  assert.equal(firstFrozenCommitSession.commit.metadata.original, "");
  const [controlledFieldReplay] = await ingestionCommitIntent
    .acceptIngestionCommitIntents(ingestionRepository, commitActor, [{
      ...realCommitRequest,
      metadata: {
        ...realCommitRequest.metadata,
        source: "https://weibo.com/1234567890/LateReplay",
        original: "https://submitted.example.com/late-replay.webp"
      }
    }]);
  assert.equal(controlledFieldReplay.status, "accepted");
  const [changedTitleReplay] = await ingestionCommitIntent
    .acceptIngestionCommitIntents(ingestionRepository, commitActor, [{
      ...realCommitRequest,
      metadata: {
        ...realCommitRequest.metadata,
        title: "conflicting replay title"
      }
    }]);
  assert.equal(changedTitleReplay.status, "failed");
  assert.equal(changedTitleReplay.code, "ingestion_commit_intent_conflict");
  const failedCommitSession = activeSession((await ingestionRepository.mutateSemantic(
    firstFrozenCommitSession,
    firstFrozenCommitSession.version,
    ingestionSessionTransitions.failedIngestionSession(
      firstFrozenCommitSession,
      new Error("retryable commit failure")
    )
  )).session);
  const retriedCommit = await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    commitActor,
    [{ ...realCommitRequest, expected_version: failedCommitSession.version }]
  );
  assert.equal(retriedCommit[0].status, "accepted");
  assert.ok(retriedCommit[0].version > failedCommitSession.version);
  const frozenCommitSession = committingSession(await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  ));
  assert.equal(frozenCommitSession.status, "committing");
  assert.equal(
    frozenCommitSession.commit.commit_request_id,
    realCommitRequest.commit_request_id,
    "提交失败重试必须复用已经冻结的意图"
  );
  assert.equal(frozenCommitSession.commit.created_by, commitActor);
  const realCommitCoordinator = new (
    ingestionIrreversibleCoordinator.IngestionIrreversibleCoordinator
  )();
  const committedObjectKey = frozenCommitSession.commit.final_object_key;
  const committedObjectPrefix = "full";
  const committedThumbnailKey = imagePaths.thumbnailObjectKey(
    committedObjectKey
  );
  const commitStorageAccess = await registry.resolveStorageAccess("local");
  const originalCommitCopy = commitStorageAccess.driver.copy.bind(
    commitStorageAccess.driver
  );
  let commitCopyCalls = 0;
  commitStorageAccess.driver.copy = async (...args) => {
    commitCopyCalls += 1;
    return originalCommitCopy(...args);
  };
  const preExistingConflictBody = Buffer.from(
    "unowned-formal-conflict-" + commitImageId
  );
  await commitStorageAccess.driver.writeBuffer(
    committedObjectPrefix,
    committedObjectKey,
    preExistingConflictBody,
    "image/webp"
  );
  const originalCommitExists = commitStorageAccess.driver.exists.bind(
    commitStorageAccess.driver
  );
  let siblingPreflightStarted = false;
  let siblingPreflightAborted = false;
  let siblingPreflightDrained = false;
  commitStorageAccess.driver.exists = async (prefix, key, options) => {
    if (prefix === "thumbs" && key === committedThumbnailKey) {
      siblingPreflightStarted = true;
      const preflightSignal = options?.signal;
      await new Promise((_, reject) => {
        const rejectAfterDrain = () => {
          siblingPreflightAborted = true;
          setTimeout(() => {
            siblingPreflightDrained = true;
            reject(preflightSignal?.reason ?? new Error("preflight aborted"));
          }, 10);
        };
        if (preflightSignal?.aborted) rejectAfterDrain();
        else preflightSignal?.addEventListener("abort", rejectAfterDrain, {
          once: true
        });
      });
    }
    return originalCommitExists(prefix, key, options);
  };
  try {
    await assert.rejects(
      ingestionCommitWorker.commitIngestionSessionSnapshot(
        ingestionRepository,
        realCommitCoordinator,
        frozenCommitSession,
        new AbortController().signal
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "storage_object_conflict"
    );
  } finally {
    commitStorageAccess.driver.exists = originalCommitExists;
  }
  assert.equal(siblingPreflightStarted, true);
  assert.equal(siblingPreflightAborted, true);
  assert.equal(
    siblingPreflightDrained,
    true,
    "任一正式目标冲突时必须取消并排空另一条摘要读取后再释放锁"
  );
  assert.equal(commitCopyCalls, 0);
  assert.equal(Number((await database.pool.query(
    "SELECT count(*)::int AS count FROM background_job "
      + "WHERE type='move.cleanup' AND target_id=$1 "
      + "AND payload->>'reason'=$2",
    [commitImageId, "ingestion_commit_candidate_guard"]
  )).rows[0]?.count), 0, "不匹配的预存正式对象不得被 guard 接管");
  assert.deepEqual(
    await commitStorageAccess.driver.readBuffer(
      committedObjectPrefix,
      committedObjectKey
    ),
    preExistingConflictBody,
    "提交冲突不得删除本次从未创建或采用的正式对象"
  );
  await removeDriverObject(
    commitStorageAccess.driver,
    committedObjectPrefix,
    committedObjectKey
  );
  const guardRegistrationFailure = new Error(
    "injected ingestion candidate guard registration failure"
  );
  const restoreGuardQuery = interceptSqlQueries(database.pool, async (sql, _values, query) => {
    if (
      sql.includes("INSERT INTO background_job(")
      && sql.includes("jsonb_to_recordset")
    ) {
      throw guardRegistrationFailure;
    }
    return query();
  });
  try {
    await assert.rejects(
      ingestionCommitWorker.commitIngestionSessionSnapshot(
        ingestionRepository,
        realCommitCoordinator,
        frozenCommitSession,
        new AbortController().signal
      ),
      (error) => error === guardRegistrationFailure
    );
  } finally {
    restoreGuardQuery();
  }
  assert.equal(commitCopyCalls, 0, "候选 guard 未落库前不得开始正式复制");
  const conflictingCommitActor = "current-conflicting-actor-" + randomUUID();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, width, height, image_size, "
      + "thumbnail_size, image_time, title) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,1200,800,$5,$6,$7,$8)",
    [
      commitImageId,
      conflictingCommitActor,
      committedObjectKey,
      realPrepared.md5,
      commitImageBody.length,
      commitThumbnailBody.length,
      commitImageTime.iso,
      "conflicting owner"
    ]
  );
  let commitGuardJob;
  try {
    await assert.rejects(
      ingestionCommitWorker.commitIngestionSessionSnapshot(
        ingestionRepository,
        realCommitCoordinator,
        frozenCommitSession,
        new AbortController().signal
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_image_owner_conflict"
    );
    assert.equal(commitCopyCalls, 2, "guard 成功后 full/thumb 才能开始复制");
    assert.equal(
      (await database.pool.query(
        "SELECT created_by FROM metadata WHERE id=$1",
        [commitImageId]
      )).rows[0]?.created_by,
      conflictingCommitActor,
      "不同 owner 的既有正式图片不得被内容接入提交接管"
    );
    commitGuardJob = (await database.pool.query(
      "SELECT * FROM background_job WHERE type='move.cleanup' "
        + "AND target_id=$1 AND payload->>'reason'=$2",
      [commitImageId, "ingestion_commit_candidate_guard"]
    )).rows[0];
    assert.ok(commitGuardJob, "复制前必须已经持久化正式候选 guard");
    assert.match(commitGuardJob.payload.guard_token, /^[0-9a-f-]{36}$/i);
    const commitFullCandidateKey = committedObjectKey
      + ".candidate-" + commitGuardJob.payload.guard_token;
    const commitThumbnailCandidateKey = committedThumbnailKey
      + ".candidate-" + commitGuardJob.payload.guard_token;
    assert.deepEqual(
      commitGuardJob.payload.objects.map(({ prefix, key }: { prefix: string; key: string }) => ({ prefix, key })),
      [
        { prefix: committedObjectPrefix, key: committedObjectKey },
        { prefix: committedObjectPrefix, key: commitFullCandidateKey },
        { prefix: "thumbs", key: committedThumbnailKey },
        { prefix: "thumbs", key: commitThumbnailCandidateKey }
      ]
    );
    await database.pool.query(
      "DELETE FROM metadata WHERE id=$1",
      [commitImageId]
    );
    await commitStorageAccess.driver.writeBuffer(
      committedObjectPrefix,
      commitFullCandidateKey,
      Buffer.from("simulated-local-copy-crash"),
      "image/webp"
    );
    commitGuardJob = (await database.pool.query(
      "UPDATE background_job SET status='running', execution_token=$2 "
        + "WHERE id=$1 RETURNING *",
      [commitGuardJob.id, randomUUID()]
    )).rows[0];
    await cleanupJob.handleMoveCleanupJob(
      commitGuardJob,
      new AbortController().signal
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        committedObjectPrefix,
        committedObjectKey,
        "local"
      ),
      false,
      "PG 失败后 guard 必须删除未引用 full 候选"
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        "thumbs",
        committedThumbnailKey,
        "local"
      ),
      false,
      "PG 失败后 guard 必须删除未引用 thumbnail 候选"
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        committedObjectPrefix,
        commitFullCandidateKey,
        "local"
      ),
      false,
      "guard 必须清理 local 原子复制崩溃候选"
    );
    await assert.rejects(
      ingestionCommitWorker.commitIngestionSessionSnapshot(
        ingestionRepository,
        realCommitCoordinator,
        frozenCommitSession,
        new AbortController().signal
      ),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "storage_object_cleanup_pending"
    );
    assert.equal(
      commitCopyCalls,
      2,
      "旧 guard 未收口时不得旁路其删除租约"
    );
    await database.pool.query(
      "UPDATE background_job SET status='succeeded' WHERE id=$1",
      [commitGuardJob.id]
    );
    await ingestionCommitWorker.commitIngestionSessionSnapshot(
      ingestionRepository,
      realCommitCoordinator,
      frozenCommitSession,
      new AbortController().signal
    );
    assert.equal(commitCopyCalls, 4, "同一 guard 只能放行持锁的本次重试");
    let retriedCommitGuardJob = (await database.pool.query(
      "SELECT * FROM background_job WHERE type='move.cleanup' "
        + "AND target_id=$1 AND payload->>'reason'=$2 "
        + "AND status='pending' ORDER BY created_at DESC LIMIT 1",
      [commitImageId, "ingestion_commit_candidate_guard"]
    )).rows[0];
    assert.ok(retriedCommitGuardJob);
    assert.notEqual(
      retriedCommitGuardJob.payload.guard_token,
      commitGuardJob.payload.guard_token,
      "每次复制尝试必须只旁路本次新建 guard"
    );
    const retriedThumbnailCandidateKey = committedThumbnailKey
      + ".candidate-" + retriedCommitGuardJob.payload.guard_token;
    await commitStorageAccess.driver.writeBuffer(
      "thumbs",
      retriedThumbnailCandidateKey,
      Buffer.from("simulated-post-commit-local-candidate"),
      "image/webp"
    );
    retriedCommitGuardJob = (await database.pool.query(
      "UPDATE background_job SET status='running', execution_token=$2 "
        + "WHERE id=$1 RETURNING *",
      [retriedCommitGuardJob.id, randomUUID()]
    )).rows[0];
    await cleanupJob.handleMoveCleanupJob(
      retriedCommitGuardJob,
      new AbortController().signal
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        committedObjectPrefix,
        committedObjectKey,
        "local"
      ),
      true,
      "PG 引用建立后 guard 必须永久保留正式对象"
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        "thumbs",
        committedThumbnailKey,
        "local"
      ),
      true,
      "PG 引用建立后 guard 必须永久保留正式缩略图"
    );
    assert.equal(
      await objectAccess.storageObjectExists(
        "thumbs",
        retriedThumbnailCandidateKey,
        "local"
      ),
      false,
      "PG 正式引用不应保留 local 原子复制临时候选"
    );
    assert.equal(
      await jobs.markBackgroundJobSucceeded(retriedCommitGuardJob),
      true
    );
  } finally {
    commitStorageAccess.driver.copy = originalCommitCopy;
  }
  const committedActorRow = (await database.pool.query(
    "SELECT created_by, image_time, title, source, original FROM metadata WHERE id=$1",
    [commitImageId]
  )).rows[0];
  assert.deepEqual(committedActorRow, {
    created_by: commitActor,
    image_time: commitImageTime.date,
    title: "committed by frozen actor",
    source: "",
    original: ""
  });
  const completedCommitRetry = await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    commitActor,
    [realCommitRequest]
  );
  assert.equal(completedCommitRetry[0].status, "completed");
  assert.equal(completedCommitRetry[0].completed_item.id, commitImageId);
  assert.equal(
    await objectAccess.storageObjectExists(
      "_uploads",
      commitImageKey,
      "local"
    ),
    false,
    "PostgreSQL 提交后必须清理精确 staging 图片"
  );
  assert.equal(
    await objectAccess.storageObjectExists(
      "_uploads",
      commitThumbnailKey,
      "local"
    ),
    false,
    "PostgreSQL 提交后必须清理精确 staging 缩略图"
  );
  const completedCommitReceipt = completedSession(await ingestionRepository.readSession(
    commitActor,
    commitSessionId
  ));
  assert.equal(completedCommitReceipt.status, "completed");
  await ingestionRepository.deleteSession(
    completedCommitReceipt,
    completedCommitReceipt.version,
    Date.now()
  );
  const commitQueueKeys = ingestionSessionKeys.ingestionSessionKeys(
    commitActor,
    "import",
    commitSessionId
  );
  await redisClient.redis.del(
    commitQueueKeys.owner,
    commitQueueKeys.display,
    commitQueueKeys.metadata
  );
  await database.pool.query("DELETE FROM metadata WHERE id=$1", [commitImageId]);
  await database.pool.query(
    "DELETE FROM background_job WHERE type='move.cleanup' "
      + "AND target_id=$1 AND payload->>'reason'=$2",
    [commitImageId, "ingestion_commit_candidate_guard"]
  );
  objectAccess.assertStorageRemovalResults(
    await objectAccess.removeStorageObjectsAndConfirm([
      {
        prefix: committedObjectPrefix,
        key: committedObjectKey,
        storageSlug: "local"
      },
      {
        prefix: "thumbs",
        key: committedThumbnailKey,
        storageSlug: "local"
      }
    ])
  );
});
