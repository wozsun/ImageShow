import { activeSession, activeResult, discardedResult, discardedSession, committingSession, preparedSession, completedSession } from "./ingestion-scenario-fixture.mts";
import { repositoryWithOverrides } from "./ingestion-scenario-fixture.mts";
import assert from "node:assert/strict";
import type { IngestionSessionSnapshot } from "../../../../packages/server/src/images/ingestion/sessions/model.ts";
import type { IngestionSessionRepository } from "../../../../packages/server/src/images/ingestion/repository.ts";
import type { runIngestionQueueAction } from "../../../../packages/server/src/images/ingestion/queue/action.ts";
import { createHash, randomUUID } from "node:crypto";
import { createIngestionScenarioFixture } from "./ingestion-scenario-fixture.mts";
import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async (runtime) => {
const databasePools = runtime.databasePools;
const database = {
  ...databasePools,
  ...await import("../../../../packages/server/src/core/database/advisory-locks.ts")
};
const imagePaths = await import("../../../../packages/server/src/storage/objects/image-paths.ts");
const ingestionSessionRepository = await import(
  "../../../../packages/server/src/images/ingestion/repository.ts"
);
const ingestionSessionView = await import("../../../../packages/server/src/images/ingestion/queue/session-view.ts");
const ingestionSessionTransitions = await import(
  "../../../../packages/server/src/images/ingestion/sessions/transitions.ts"
);
const ingestionCommitIntent = await import("../../../../packages/server/src/images/ingestion/commit/intent.ts");
const ingestionCommitCompletion = await import(
  "../../../../packages/server/src/images/ingestion/commit/completion.ts"
);
const ingestionCommitConflictRecovery = await import(
  "../../../../packages/server/src/images/ingestion/commit/conflict-recovery.ts"
);
const apiError = await import("../../../../packages/server/src/core/api-error.ts");
const ingestionIrreversibleCoordinator = await import(
  "../../../../packages/server/src/images/ingestion/execution/irreversible-coordinator.ts"
);
const ingestionTokenService = await import("../../../../packages/server/src/images/ingestion/sessions/token-service.ts");
const ingestionActionScope = await import("../../../../packages/server/src/images/ingestion/queue/action-scope.ts");
const ingestionActionProtocol = await import("../../../../packages/server/src/images/ingestion/queue/action-protocol.ts");
const ingestionQueueSnapshot = await import("../../../../packages/server/src/images/ingestion/queue/snapshot.ts");
const ingestionQueueAction = await import("../../../../packages/server/src/images/ingestion/queue/action.ts");
const ingestionSessionUpdate = await import("../../../../packages/server/src/images/ingestion/queue/session-update.ts");
const ingestionSessionIdentity = await import("../../../../packages/server/src/images/ingestion/sessions/identity.ts");
const ingestionSessionProjection = await import(
  "../../../../packages/server/src/images/ingestion/sessions/projection.ts"
);
const ingestionStagingKeys = await import("../../../../packages/server/src/images/ingestion/staging-keys.ts");
const coreUuid = await import("../../../../packages/server/src/core/uuid.ts");
const imageTime = await import("../../../../packages/server/src/images/image-time.ts");
const { ingestionRepository, displayOrderKey, ingestionMetadata, importTemplate: importCanonicalWithoutHash,
  preparedTemplate: realPrepared, discardOrderProbe } = await createIngestionScenarioFixture(runtime);
  const actionOwner = "current-queue-action-" + randomUUID();
  const actionSession = { id: "queue-action-session", username: actionOwner };
  let actionPosition = 200;
  function createActionReadySession(label: string, makeReady?: true): Promise<ReturnType<typeof preparedSession>>;
  function createActionReadySession(label: string, makeReady: false): Promise<IngestionSessionSnapshot>;
  async function createActionReadySession(label: string, makeReady = true) {
    const sessionId = ingestionSessionIdentity.createIngestionSessionId(
      actionOwner,
      "import",
      label
    );
    const resolved = imageTime.parseImageTime(
      "2026-08-23T02:03:" + String(actionPosition % 60).padStart(2, "0") + ".456Z"
    );
    const imageId = imageTime.createImageId(resolved.date, actionPosition % 4096);
    const batchPosition = actionPosition % 4096;
    actionPosition += 1;
    const withoutHash = {
      ...importCanonicalWithoutHash,
      owner: actionOwner,
      session_id: sessionId,
      image_id: imageId,
      image_time: resolved.iso,
      request_hash: createHash("sha256").update(label).digest("hex"),
      import_download: { url: "https://example.com/action-" + label + ".webp" },
      metadata: { ...ingestionMetadata, title: label }
    };
    const acceptedAt = Date.now();
    const queued = activeSession((await ingestionRepository.acceptImportSession({
      ...withoutHash,
      semantic_hash: ingestionSessionProjection.ingestionSessionSemanticHash(
        withoutHash
      )
    }, displayOrderKey(
      sessionId,
      batchPosition,
      acceptedAt
    ), acceptedAt)).session);
    if (!makeReady) return queued;
    const generation = coreUuid.randomUuidV7();
    const executionToken = coreUuid.randomUuidV7();
    const prepared = {
      ...realPrepared,
      prepared_image_key: ingestionStagingKeys.ingestionStagingImageKey({
        session_id: sessionId,
        image_id: imageId,
        generation,
        execution_token: executionToken
      }),
      prepared_thumbnail_key: ingestionStagingKeys.ingestionStagingThumbnailKey({
        session_id: sessionId,
        image_id: imageId,
        generation,
        execution_token: executionToken
      }),
      md5: createHash("md5").update(label).digest("hex"),
      generation
    };
    return preparedSession((await ingestionRepository.mutateSemantic(
      queued,
      queued.version,
      ingestionSessionTransitions.semanticIngestionSession(queued, {
        status: "ready" as const,
        phase: "ready" as const,
        message: "ready",
        progress: 100,
        execution_token: "",
        prepared
      })
    )).session);
  }
  const actionTokens = new ingestionTokenService.IngestionTokenService({
    rootKey: new Uint8Array(32).fill(83)
  });
  const actionScope = ingestionActionScope.openIngestionActionScope(
    actionSession,
    "import",
    () => undefined
  );
  const actionFirst = await createActionReadySession("first");
  const actionSecond = await createActionReadySession("second");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      actionFirst.image_id,
      actionOwner,
      imagePaths.storageObjectKey(actionFirst.image_id, "webp"),
      actionFirst.prepared.md5
    ]
  );
  const activePgStatus = await ingestionSessionView.readIngestionStatuses(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionFirst.session_id,
      image_id: actionFirst.image_id
    }]
  );
  assert.equal(activePgStatus[0].status, "completed");
  assert.equal(activePgStatus[0].redis_status, "active");
  assert.equal(
    activePgStatus[0].redis_last_semantic_revision,
    actionFirst.last_semantic_revision
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [actionFirst.image_id]
  );
  const actionPage = await ingestionQueueSnapshot.readStableIngestionQueueSnapshot({
    repository: ingestionRepository,
    tokens: actionTokens,
    session: actionSession,
    actionScope: actionScope.id,
    queue: "import" as const,
    offset: 0,
    limit: 10
  });
  const ascendingActionAfterFrozenWatermark = await createActionReadySession(
    "after-frozen-watermark"
  );
  assert.ok(
    ascendingActionAfterFrozenWatermark.accepted_order
      > actionPage.last_accepted_order,
    "冻结水位后新增任务必须取得更大的 accepted_order"
  );
  const limitedActionRepository = repositoryWithOverrides(ingestionRepository, {
    scanAction: (owner, queue, maximumOrder, cursor) => (
      ingestionRepository.scanAction(owner, queue, maximumOrder, cursor, 1)
    ),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args)
  });
  const applyActionRequest = {
    queue: "import" as const,
    action_request_id: coreUuid.randomUuidV7(),
    action: "apply_metadata" as const,
    action_watermark: actionPage.action_watermark,
    metadata: { title: "bounded action" }
  };
  const runAction = (repository: Partial<IngestionSessionRepository>, request: Parameters<typeof runIngestionQueueAction>[0]["request"]) => ingestionQueueAction
    .runIngestionQueueAction({
      repository: repositoryWithOverrides(ingestionRepository, repository),
      coordinator: new (
        ingestionIrreversibleCoordinator.IngestionIrreversibleCoordinator
      )(),
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      request,
      abortActive: () => undefined
    });
  const firstActionBatch = await runAction(
    limitedActionRepository,
    applyActionRequest
  );
  assert.equal(firstActionBatch.processed, 1);
  assert.equal(
    firstActionBatch.changed,
    1,
    JSON.stringify(firstActionBatch)
  );
  assert.ok(firstActionBatch.continuation);
  assert.equal(firstActionBatch.items[0].session_id, actionFirst.session_id);
  const initialActionCursor = ingestionActionProtocol
    .resolveIngestionQueueActionCursor({
      request: applyActionRequest,
      actionScope: actionScope.id,
      session: actionSession,
      tokens: actionTokens
    });
  const continuedActionCursor = ingestionActionProtocol
    .resolveIngestionQueueActionCursor({
      request: {
        ...applyActionRequest,
        continuation: firstActionBatch.continuation
      },
      actionScope: actionScope.id,
      session: actionSession,
      tokens: actionTokens
    });
  assert.ok(continuedActionCursor.cursor > initialActionCursor.cursor);
  assert.ok(
    continuedActionCursor.cursor
      <= continuedActionCursor.watermark.max_accepted_order,
    "continuation 必须在冻结水位内单调向上推进"
  );
  const actionFirstAfterFirst = activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ));
  await assert.rejects(runAction(limitedActionRepository, {
    ...applyActionRequest,
    continuation: firstActionBatch.continuation,
    metadata: { title: "tampered action" }
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_action_continuation_invalid");
  const editAfterLostResponse = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionFirstAfterFirst.session_id,
      image_id: actionFirstAfterFirst.image_id,
      expected_version: actionFirstAfterFirst.version,
      metadata: {
        ...actionFirstAfterFirst.metadata,
        title: "newer edit after lost action response"
      }
    }]
  );
  assert.equal(editAfterLostResponse[0].status, "changed");
  const actionFirstAfterEdit = activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ));
  const actionRevisionAfterEdit = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata.revision;
  const retriedFirstActionBatch = await runAction(
    limitedActionRepository,
    applyActionRequest
  );
  assert.deepEqual(
    retriedFirstActionBatch,
    firstActionBatch,
    "首批响应丢失必须从进程内 action scope 逐字重放原批次结果"
  );
  assert.ok(retriedFirstActionBatch.continuation);
  assert.equal(
    (activeSession(await ingestionRepository.readSession(
      actionOwner,
      actionFirst.session_id
    ))).version,
    actionFirstAfterEdit.version,
    "首批响应丢失重试不得覆盖其后编辑或推进 version"
  );
  assert.equal(
    (activeSession(await ingestionRepository.readSession(
      actionOwner,
      actionFirst.session_id
    ))).metadata.title,
    "newer edit after lost action response"
  );
  assert.equal(
    (await ingestionRepository.snapshot(actionOwner, "import", 0, 0))
      .metadata.revision,
    actionRevisionAfterEdit,
    "首批响应丢失重试不得在后续编辑后推进 queue revision"
  );
  const secondActionBatch = await runAction(limitedActionRepository, {
    ...applyActionRequest,
    continuation: retriedFirstActionBatch.continuation
  });
  assert.equal(secondActionBatch.processed, 1);
  assert.equal(secondActionBatch.changed, 1);
  assert.equal(secondActionBatch.items[0].session_id, actionSecond.session_id);
  assert.equal(secondActionBatch.continuation, undefined);
  const ascendingActionAfterFrozenWatermarkResult =
    activeSession(await ingestionRepository.readSession(
    actionOwner,
    ascendingActionAfterFrozenWatermark.session_id
  ));
  assert.equal(
    ascendingActionAfterFrozenWatermarkResult.metadata.title,
    ascendingActionAfterFrozenWatermark.metadata.title,
    "accepted_order 超过冻结水位的新增任务不得进入本轮操作"
  );
  assert.equal(
    ascendingActionAfterFrozenWatermarkResult.version,
    ascendingActionAfterFrozenWatermark.version
  );
  await discardOrderProbe(
    ascendingActionAfterFrozenWatermarkResult,
    Date.now()
  );

  const noOpActionPage = await ingestionQueueSnapshot.readStableIngestionQueueSnapshot({
    repository: ingestionRepository,
    tokens: actionTokens,
    session: actionSession,
    actionScope: actionScope.id,
    queue: "import" as const,
    offset: 0,
    limit: 10
  });
  const noOpActionCurrent = activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ));
  const noOpVersionBefore = noOpActionCurrent.version;
  const noOpRevisionBefore = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata.revision;
  const noOpActionRequest = {
    ...applyActionRequest,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd90",
    action_watermark: noOpActionPage.action_watermark,
    metadata: { title: noOpActionCurrent.metadata.title }
  };
  const noOpActionResult = await runAction(
    limitedActionRepository,
    noOpActionRequest
  );
  assert.equal(noOpActionResult.items[0].status, "unchanged");
  assert.equal((activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ))).version, noOpVersionBefore);
  assert.equal((await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision, noOpRevisionBefore);

  const sameRevisionNewAction = {
    ...noOpActionRequest,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd91",
    metadata: { title: "new defaults at the same revision" }
  };
  const sameRevisionNewResult = await runAction(
    limitedActionRepository,
    sameRevisionNewAction
  );
  assert.equal(sameRevisionNewResult.items[0].status, "changed");
  const afterSameRevisionNewAction = activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ));
  assert.equal(
    afterSameRevisionNewAction.metadata.title,
    "new defaults at the same revision",
    "纯 no-op 不推进 revision，因此同水位后执行操作仍可生效"
  );
  const revisionAfterSameRevisionNewAction = (await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision;
  const retriedOlderNoOpAction = await runAction(
    limitedActionRepository,
    noOpActionRequest
  );
  assert.equal(retriedOlderNoOpAction.items[0].status, "changed");
  const afterRetriedOlderAction = activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ));
  assert.equal(
    afterRetriedOlderAction.metadata.title,
    noOpActionCurrent.metadata.title,
    "应用到全部只按执行顺序 CAS，不按旧点击水位后的语义修订筛选"
  );
  assert.ok((await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision > revisionAfterSameRevisionNewAction);

  const editAfterNoOpAction = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: afterRetriedOlderAction.session_id,
      image_id: afterRetriedOlderAction.image_id,
      expected_version: afterRetriedOlderAction.version,
      metadata: {
        ...afterRetriedOlderAction.metadata,
        title: "edit after newer action response loss"
      }
    }]
  );
  assert.equal(editAfterNoOpAction[0].status, "changed");
  const noOpAfterEdit = activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ));
  const noOpRevisionAfterEdit = (await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision;
  const retriedNoOpAction = await runAction(
    limitedActionRepository,
    sameRevisionNewAction
  );
  assert.equal(retriedNoOpAction.items[0].status, "changed");
  assert.equal((activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ))).metadata.title, "new defaults at the same revision");
  assert.ok((activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ))).version > noOpAfterEdit.version);
  assert.ok((await ingestionRepository.snapshot(
    actionOwner,
    "import",
    0,
    0
  )).metadata.revision > noOpRevisionAfterEdit);

  const atomicActionSession = await createActionReadySession("action-order");
  const atomicActionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import" as const,
      offset: 0,
      limit: 10
    });
  const atomicStaleSnapshot = activeSession(await ingestionRepository.readSession(
    actionOwner,
    atomicActionSession.session_id
  ));
  const staleActionRepository = repositoryWithOverrides(ingestionRepository, {
    scanAction: async () => ({
      items: [atomicStaleSnapshot],
      nextCursor: null
    }),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args)
  });
  const atomicNewerRequest = {
    queue: "import" as const,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd95",
    action: "apply_metadata" as const,
    action_watermark: atomicActionPage.action_watermark,
    metadata: { title: atomicStaleSnapshot.metadata.title }
  };
  const atomicNewerResult = await runAction(
    staleActionRepository,
    atomicNewerRequest
  );
  assert.equal(atomicNewerResult.items[0].status, "unchanged");

  const atomicOlderResult = await runAction(staleActionRepository, {
    ...atomicNewerRequest,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd94",
    metadata: { title: "later smaller-id action must apply" }
  });
  assert.equal(atomicOlderResult.items[0].status, "changed");
  let atomicCurrent = activeSession(await ingestionRepository.readSession(
    actionOwner,
    atomicActionSession.session_id
  ));
  assert.equal(
    atomicCurrent.metadata.title,
    "later smaller-id action must apply",
    "同水位内没有语义变化时，后执行操作不得按跨客户端 UUID 大小丢弃"
  );

  await assert.rejects(runAction(staleActionRepository, {
    ...atomicNewerRequest,
    metadata: { title: "same id with different payload must lose" }
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_action_request_conflict");
  atomicCurrent = activeSession(await ingestionRepository.readSession(
    actionOwner,
    atomicActionSession.session_id
  ));
  assert.equal(
    atomicCurrent.metadata.title,
    "later smaller-id action must apply"
  );

  const businessEditAfterAction = activeResult(await ingestionRepository.mutateSemantic(
    atomicCurrent,
    atomicCurrent.version,
    ingestionSessionTransitions.semanticIngestionSession(atomicCurrent, {
      metadata: {
        ...atomicCurrent.metadata,
        description: "ordinary edit after concurrent action"
      }
    })
  ));
  assert.equal(businessEditAfterAction.changed, true);
  assert.equal(
    businessEditAfterAction.session.metadata.description,
    "ordinary edit after concurrent action"
  );
  await assert.rejects(runAction(
    staleActionRepository,
    {
      ...atomicNewerRequest,
      metadata: { title: "same id after version advance must lose" }
    }
  ), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_action_request_conflict");
  const retiredAtomicAction = discardedResult(await ingestionRepository.mutateSemantic(
    businessEditAfterAction.session,
    businessEditAfterAction.session.version,
    ingestionSessionTransitions.discardedIngestionReceipt(
      businessEditAfterAction.session,
      Date.now()
    )
  ));
  await ingestionRepository.deleteSession(
    retiredAtomicAction.session,
    retiredAtomicAction.session.version
  );

  const orderedActionSession = await createActionReadySession(
    "ordered-action-cas"
  );
  const orderedActionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import" as const,
      offset: 0,
      limit: 10
    });
  const orderedStaleSnapshot = activeSession(await ingestionRepository.readSession(
    actionOwner,
    orderedActionSession.session_id
  ));
  const orderedStaleRepository = repositoryWithOverrides(ingestionRepository, {
    scanAction: async () => ({
      items: [orderedStaleSnapshot],
      nextCursor: null
    }),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args)
  });
  const orderedSmallerRequest = {
    queue: "import" as const,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd96",
    action: "apply_metadata" as const,
    action_watermark: orderedActionPage.action_watermark,
    metadata: { title: "smaller action landed first" }
  };
  const orderedSmallerResult = await runAction(
    orderedStaleRepository,
    orderedSmallerRequest
  );
  assert.equal(orderedSmallerResult.items[0].status, "changed");
  const orderedAfterSmaller = activeSession(await ingestionRepository.readSession(
    actionOwner,
    orderedActionSession.session_id
  ));
  const editBetweenOrderedActions = activeResult(await ingestionRepository.mutateSemantic(
    orderedAfterSmaller,
    orderedAfterSmaller.version,
    ingestionSessionTransitions.semanticIngestionSession(orderedAfterSmaller, {
      metadata: {
        ...orderedAfterSmaller.metadata,
        description: "ordinary edit between ordered actions"
      }
    })
  ));
  assert.equal(editBetweenOrderedActions.changed, true);
  const orderedLargerResult = await runAction(orderedStaleRepository, {
    ...orderedSmallerRequest,
    action_request_id: "019f8457-063a-7004-a580-7a432dc7fd97",
    metadata: { title: "larger action must win" }
  });
  assert.equal(orderedLargerResult.items[0].status, "changed");
  const orderedCurrent = activeSession(await ingestionRepository.readSession(
    actionOwner,
    orderedActionSession.session_id
  ));
  assert.equal(orderedCurrent.metadata.title, "larger action must win");
  assert.equal(
    orderedCurrent.metadata.description,
    "ordinary edit between ordered actions",
    "后执行全局操作应在最新 canonical 上合并，保留未被 patch 覆盖的字段"
  );
  const retiredOrderedAction = discardedResult(await ingestionRepository.mutateSemantic(
    orderedCurrent,
    orderedCurrent.version,
    ingestionSessionTransitions.discardedIngestionReceipt(
      orderedCurrent,
      Date.now()
    )
  ));
  await ingestionRepository.deleteSession(
    retiredOrderedAction.session,
    retiredOrderedAction.session.version
  );

  const actionFirstCurrent = activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionFirst.session_id
  ));
  const noOpUpdate = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionFirstCurrent.session_id,
      image_id: actionFirstCurrent.image_id,
      expected_version: 1,
      metadata: actionFirstCurrent.metadata
    }]
  );
  assert.equal(noOpUpdate[0].status, "unchanged");
  assert.equal(noOpUpdate[0].version, actionFirstCurrent.version);
  const changedUpdate = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionFirstCurrent.session_id,
      image_id: actionFirstCurrent.image_id,
      expected_version: actionFirstCurrent.version,
      metadata: { ...actionFirstCurrent.metadata, description: "saved draft" }
    }]
  );
  assert.equal(changedUpdate[0].status, "changed");

  const commitActionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import" as const,
      offset: 0,
      limit: 10
    });
  const actionSecondBeforeStale = activeSession(await ingestionRepository.readSession(
    actionOwner,
    actionSecond.session_id
  ));
  await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionSecondBeforeStale.session_id,
      image_id: actionSecondBeforeStale.image_id,
      expected_version: actionSecondBeforeStale.version,
      metadata: {
        ...actionSecondBeforeStale.metadata,
        description: "changed after watermark"
      }
    }]
  );
  const actionAfterWatermark = await createActionReadySession("after-watermark");
  const commitActionRequest = {
    queue: "import" as const,
    action_request_id: coreUuid.randomUuidV7(),
    action: "commit_ready" as const,
    action_watermark: commitActionPage.action_watermark
  };
  const commitActionResult = await runAction(
    ingestionRepository,
    commitActionRequest
  );
  assert.equal(commitActionResult.changed, 1);
  assert.equal(
    commitActionResult.items.filter((item) => (
      item.code === "ingestion_action_state_changed"
    )).length,
    1,
    "watermark 后发生语义变化的 ready 项必须跳过"
  );
  assert.equal(
    (activeSession(await ingestionRepository.readSession(
      actionOwner,
      actionAfterWatermark.session_id
    ))).status,
    "ready",
    "watermark 后新建的 canonical 不得进入旧全队列动作"
  );
  const actionRevisionAfterCommit = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata.revision;
  const retriedCommitAction = await runAction(
    ingestionRepository,
    commitActionRequest
  );
  assert.equal(retriedCommitAction.failed, 0);
  assert.equal(
    (await ingestionRepository.snapshot(actionOwner, "import", 0, 0))
      .metadata.revision,
    actionRevisionAfterCommit,
    "相同全队列提交 action ID 重试必须语义 no-op"
  );

  const duplicateRecoveryReady = await createActionReadySession(
    "duplicate-recovery"
  );
  const duplicateRecoveryRequest = {
    session_id: duplicateRecoveryReady.session_id,
    image_id: duplicateRecoveryReady.image_id,
    expected_version: duplicateRecoveryReady.version,
    expected_md5: duplicateRecoveryReady.prepared.md5,
    commit_request_id: coreUuid.randomUuidV7(),
    duplicate_decision: "upload" as const,
    metadata: duplicateRecoveryReady.metadata
  };
  assert.equal((await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    actionOwner,
    [duplicateRecoveryRequest]
  ))[0].status, "accepted");
  const duplicateRecoveryCommitting = committingSession(await ingestionRepository.readSession(
    actionOwner,
    duplicateRecoveryReady.session_id
  ));
  const duplicateRecoveryImageId = coreUuid.randomUuidV7();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      duplicateRecoveryImageId,
      actionOwner,
      imagePaths.storageObjectKey(duplicateRecoveryImageId, "webp"),
      duplicateRecoveryReady.prepared.md5
    ]
  );
  const duplicateRecoverySummaryBefore = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata;
  assert.equal(await ingestionCommitConflictRecovery
    .recoverIngestionCommitDuplicateConflict(
      ingestionRepository,
      duplicateRecoveryCommitting,
      new apiError.ApiError(
        409,
        "ingestion_duplicate_conflict",
        "duplicate appeared under the content lock"
      )
    ), true);
  const duplicateRecoveryCurrent = preparedSession(await ingestionRepository.readSession(
    actionOwner,
    duplicateRecoveryReady.session_id
  ));
  assert.equal(duplicateRecoveryCurrent.status, "ready");
  assert.equal(duplicateRecoveryCurrent.prepared.duplicate_count, 1);
  assert.equal(duplicateRecoveryCurrent.duplicate_decision, undefined);
  assert.equal(duplicateRecoveryCurrent.commit, undefined);
  assert.equal(duplicateRecoveryCurrent.error, undefined);
  assert.equal(
    duplicateRecoveryCurrent.version,
    duplicateRecoveryCommitting.version + 1
  );
  const duplicateRecoverySummaryAfter = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata;
  assert.equal(
    duplicateRecoverySummaryAfter.committing_resolving,
    duplicateRecoverySummaryBefore.committing_resolving - 1
  );
  assert.equal(
    duplicateRecoverySummaryAfter.duplicate_pending,
    duplicateRecoverySummaryBefore.duplicate_pending + 1,
    "内容锁后出现的重复项必须回到可确认状态而不是冻结为提交失败"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [duplicateRecoveryImageId]
  );

  const duplicateIntentReady = await createActionReadySession(
    "duplicate-before-intent"
  );
  const duplicateIntentImageId = coreUuid.randomUuidV7();
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      duplicateIntentImageId,
      actionOwner,
      imagePaths.storageObjectKey(duplicateIntentImageId, "webp"),
      duplicateIntentReady.prepared.md5
    ]
  );
  const [duplicateIntentResult] = await ingestionCommitIntent
    .acceptIngestionCommitIntents(ingestionRepository, actionOwner, [{
      session_id: duplicateIntentReady.session_id,
      image_id: duplicateIntentReady.image_id,
      expected_version: duplicateIntentReady.version,
      expected_md5: duplicateIntentReady.prepared.md5,
      commit_request_id: coreUuid.randomUuidV7(),
      duplicate_decision: "upload" as const,
      metadata: duplicateIntentReady.metadata
    }]);
  assert.equal(duplicateIntentResult.status, "failed");
  assert.equal(duplicateIntentResult.code, "ingestion_duplicate_conflict");
  assert.equal(duplicateIntentResult.duplicate_count, 1);
  assert.equal(duplicateIntentResult.version, duplicateIntentReady.version + 1);
  const duplicateIntentCurrent = preparedSession(await ingestionRepository.readSession(
    actionOwner,
    duplicateIntentReady.session_id
  ));
  assert.equal(duplicateIntentCurrent.status, "ready");
  assert.equal(duplicateIntentCurrent.prepared.duplicate_count, 1);
  assert.equal(duplicateIntentCurrent.duplicate_decision, undefined);
  assert.equal(duplicateIntentCurrent.commit, undefined);
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [duplicateIntentImageId]
  );
  const duplicateCountRefresh = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: duplicateIntentCurrent.session_id,
      image_id: duplicateIntentCurrent.image_id,
      expected_version: duplicateIntentCurrent.version,
      duplicate_decision: "upload" as const
    }]
  );
  assert.equal(duplicateCountRefresh[0].status, "changed");
  assert.equal(duplicateCountRefresh[0].duplicate_count, 0);
  assert.equal(duplicateCountRefresh[0].duplicate_decision, "upload");
  const duplicateCountCurrent = preparedSession(await ingestionRepository.readSession(
    actionOwner,
    duplicateIntentCurrent.session_id
  ));
  assert.equal(duplicateCountCurrent.prepared.duplicate_count, 0);
  assert.equal(duplicateCountCurrent.duplicate_decision, "upload");
  const actionQueued = await createActionReadySession(
    "apply-defaults-while-queued",
    false
  );
  const queuedDraftUpdate = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: actionQueued.session_id,
      image_id: actionQueued.image_id,
      expected_version: actionQueued.version,
      metadata: {
        ...actionQueued.metadata,
        title: "accepted 后补写的本地草稿"
      }
    }]
  );
  assert.equal(queuedDraftUpdate[0].status, "changed");
  assert.equal(queuedDraftUpdate[0].duplicate_count, 0);
  assert.equal(
    (activeSession(await ingestionRepository.readSession(
      actionOwner,
      actionQueued.session_id
    ))).metadata.title,
    "accepted 后补写的本地草稿",
    "页外 intent fence 必须能在 prepare 前写回 queued canonical"
  );
  const queuedActionPage = await ingestionQueueSnapshot.readStableIngestionQueueSnapshot({
    repository: ingestionRepository,
    tokens: actionTokens,
    session: actionSession,
    actionScope: actionScope.id,
    queue: "import" as const,
    offset: 0,
    limit: 10
  });
  const queuedActionResult = await runAction(ingestionRepository, {
    queue: "import" as const,
    action_request_id: coreUuid.randomUuidV7(),
    action: "apply_metadata" as const,
    action_watermark: queuedActionPage.action_watermark,
    metadata: { author: "queued-default-author" }
  });
  assert.equal(
    queuedActionResult.items.find((item) => (
      item.image_id === actionQueued.image_id
    ))?.status,
    "changed",
    "应用到全部必须覆盖点击水位内仍在 queued 的 canonical"
  );
  assert.equal(
    (activeSession(await ingestionRepository.readSession(
      actionOwner,
      actionQueued.session_id
    ))).metadata.author,
    "queued-default-author"
  );

  const updateRaceSession = await createActionReadySession("update-race");
  let injectedConcurrentUpdate = false;
  const racingUpdateRepository = repositoryWithOverrides(ingestionRepository, {
    readSessions: async (owner, pairs) => {
      const stale = await ingestionRepository.readSessions(owner, pairs);
      if (!injectedConcurrentUpdate) {
        injectedConcurrentUpdate = true;
        assert.ok(stale[0] && stale[0] !== ingestionSessionRepository.ingestionSessionIncarnationMismatch);
        const current = activeSession(stale[0]);
        await ingestionRepository.mutateSemantic(
          current,
          current.version,
          ingestionSessionTransitions.semanticIngestionSession(current, {
            metadata: {
              ...current.metadata,
              title: "concurrent authoritative draft"
            }
          })
        );
      }
      return stale;
    },
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args)
  });
  const staleNoOpResult = await ingestionSessionUpdate.updateIngestionSessions(
    racingUpdateRepository,
    actionOwner,
    [{
      session_id: updateRaceSession.session_id,
      image_id: updateRaceSession.image_id,
      expected_version: updateRaceSession.version,
      metadata: updateRaceSession.metadata
    }]
  );
  assert.equal(staleNoOpResult[0].status, "failed");
  assert.equal(staleNoOpResult[0].code, "ingestion_version_conflict");
  const updateRaceCurrent = activeSession(await ingestionRepository.readSession(
    actionOwner,
    updateRaceSession.session_id
  ));
  assert.equal(
    updateRaceCurrent.metadata.title,
    "concurrent authoritative draft",
    "旧快照的语义 no-op 不得吞掉并发草稿并报告成功"
  );
  const updateRaceSummaryBeforeReplay = (
    await ingestionRepository.snapshot(actionOwner, "import", 0, 0)
  ).metadata;
  const updateRaceDiscardAt = updateRaceCurrent.discard_at;
  const lostResponseReplay = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: updateRaceCurrent.session_id,
      image_id: updateRaceCurrent.image_id,
      expected_version: updateRaceSession.version,
      metadata: updateRaceCurrent.metadata
    }]
  );
  assert.equal(lostResponseReplay[0].status, "unchanged");
  assert.equal(lostResponseReplay[0].version, updateRaceCurrent.version);
  const updateRaceAfterReplay = activeSession(await ingestionRepository.readSession(
    actionOwner,
    updateRaceSession.session_id
  ));
  assert.equal(updateRaceAfterReplay.version, updateRaceCurrent.version);
  assert.equal(updateRaceAfterReplay.discard_at, updateRaceDiscardAt);
  const futureVersionNoOp = await ingestionSessionUpdate.updateIngestionSessions(
    ingestionRepository,
    actionOwner,
    [{
      session_id: updateRaceCurrent.session_id,
      image_id: updateRaceCurrent.image_id,
      expected_version: updateRaceCurrent.version + 1,
      metadata: updateRaceCurrent.metadata
    }]
  );
  assert.equal(futureVersionNoOp[0].status, "failed");
  assert.equal(futureVersionNoOp[0].code, "ingestion_version_conflict");
  assert.equal(
    (await ingestionRepository.snapshot(actionOwner, "import", 0, 0))
      .metadata.revision,
    updateRaceSummaryBeforeReplay.revision,
    "响应丢失后的同语义重试不得推进 version、TTL 或 queue revision"
  );

  const completedCommitActionReady = await createActionReadySession(
    "commit-action-completed-retry"
  );
  const completedCommitActionId = coreUuid.randomUuidV7();
  assert.equal((await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    actionOwner,
    [{
      session_id: completedCommitActionReady.session_id,
      image_id: completedCommitActionReady.image_id,
      expected_version: completedCommitActionReady.version,
      expected_md5: completedCommitActionReady.prepared.md5,
      commit_request_id: completedCommitActionId,
      duplicate_decision: "upload" as const,
      metadata: completedCommitActionReady.metadata
    }]
  ))[0].status, "accepted");
  const completedCommitActionCurrent = committingSession(await ingestionRepository.readSession(
    actionOwner,
    completedCommitActionReady.session_id
  ));
  assert.ok(completedCommitActionCurrent);
  assert.equal(completedCommitActionCurrent.status, "committing");
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      completedCommitActionReady.image_id,
      actionOwner,
      imagePaths.storageObjectKey(completedCommitActionReady.image_id, "webp"),
      completedCommitActionReady.prepared.md5
    ]
  );
  const completedCommitActionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import" as const,
      offset: 0,
      limit: 10
    });
  const completedCommitActionResult = await runAction({
    scanAction: async () => ({
      items: [completedCommitActionCurrent],
      nextCursor: null
    }),
    readSessions: (...args) => ingestionRepository.readSessions(...args)
  }, {
    queue: "import" as const,
    action_request_id: completedCommitActionId,
    action: "commit_ready" as const,
    action_watermark: completedCommitActionPage.action_watermark
  });
  assert.equal(completedCommitActionResult.items[0]?.status, "unchanged");
  assert.equal(
    completedCommitActionResult.items[0]?.completed_item?.id,
    completedCommitActionReady.image_id,
    "PG 已提交而 Redis 仍 committing 时必须把完成 DTO 带回整队提交重试"
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id=$1",
    [completedCommitActionReady.image_id]
  );

  const clearQueueVersionRace = await createActionReadySession(
    "clear-queue-version-race",
    false
  );
  const clearQueueVersionRacePage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import" as const,
      offset: 0,
      limit: 10
    });
  const clearQueueVersionRaceStale = activeSession(await ingestionRepository.readSession(
    actionOwner,
    clearQueueVersionRace.session_id
  ));
  let clearQueueVersionAdvanced = false;
  const clearQueueVersionRaceRepository = repositoryWithOverrides(ingestionRepository, {
    scanAction: async () => {
      if (!clearQueueVersionAdvanced) {
        clearQueueVersionAdvanced = true;
        await ingestionRepository.mutateSemantic(
          clearQueueVersionRaceStale,
          clearQueueVersionRaceStale.version,
          ingestionSessionTransitions.semanticIngestionSession(
            clearQueueVersionRaceStale,
            {
              metadata: {
                ...clearQueueVersionRaceStale.metadata,
                description: "worker advanced after action scan"
              }
            }
          )
        );
      }
      return { items: [clearQueueVersionRaceStale], nextCursor: null };
    },
    readSessions: (...args) => ingestionRepository.readSessions(...args),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args),
    deleteSession: (...args) => ingestionRepository.deleteSession(...args)
  });
  const clearQueueVersionRaceResult = await runAction(
    clearQueueVersionRaceRepository,
    {
      queue: "import" as const,
      action_request_id: coreUuid.randomUuidV7(),
      action: "clear_queue" as const,
      action_watermark: clearQueueVersionRacePage.action_watermark
    }
  );
  assert.equal(clearQueueVersionRaceResult.failed, 0);
  assert.equal(clearQueueVersionRaceResult.items[0]?.status, "changed");
  assert.equal((discardedSession(await ingestionRepository.readSession(
    actionOwner,
    clearQueueVersionRace.session_id
  )))?.status, "discarded");

  const filteredClearVersionRace = await createActionReadySession(
    "filtered-clear-version-race",
    false
  );
  const filteredClearVersionRacePage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import" as const,
      offset: 0,
      limit: 10
    });
  const filteredClearVersionRaceStale = activeSession(await ingestionRepository.readSession(
    actionOwner,
    filteredClearVersionRace.session_id
  ));
  let filteredClearVersionAdvanced = false;
  const filteredClearVersionRaceRepository = repositoryWithOverrides(ingestionRepository, {
    scanAction: async () => {
      if (!filteredClearVersionAdvanced) {
        filteredClearVersionAdvanced = true;
        await ingestionRepository.mutateSemantic(
          filteredClearVersionRaceStale,
          filteredClearVersionRaceStale.version,
          ingestionSessionTransitions.semanticIngestionSession(
            filteredClearVersionRaceStale,
            {
              metadata: {
                ...filteredClearVersionRaceStale.metadata,
                description: "semantic edit after filtered action scan"
              }
            }
          )
        );
      }
      return { items: [filteredClearVersionRaceStale], nextCursor: null };
    },
    readSessions: (...args) => ingestionRepository.readSessions(...args),
    readSession: (...args) => ingestionRepository.readSession(...args),
    mutateSemantic: (...args) => ingestionRepository.mutateSemantic(...args),
    deleteSession: (...args) => ingestionRepository.deleteSession(...args)
  });
  const filteredClearVersionRaceResult = await runAction(
    filteredClearVersionRaceRepository,
    {
      queue: "import" as const,
      action_request_id: coreUuid.randomUuidV7(),
      action: "clear_uncommitted" as const,
      action_watermark: filteredClearVersionRacePage.action_watermark
    }
  );
  assert.equal(filteredClearVersionRaceResult.failed, 0);
  assert.equal(
    filteredClearVersionRaceResult.items[0]?.code,
    "ingestion_action_state_changed",
    "筛选清理应在 scan/cancel 竞态后重读并按冻结 revision 跳过"
  );
  const filteredClearVersionRaceCurrent = activeSession(await ingestionRepository.readSession(
    actionOwner,
    filteredClearVersionRace.session_id
  ));
  assert.notEqual(filteredClearVersionRaceCurrent?.status, "discarded");
  const filteredClearVersionRaceDiscarded = discardedResult(await ingestionRepository
    .mutateSemantic(
      filteredClearVersionRaceCurrent,
      filteredClearVersionRaceCurrent.version,
      ingestionSessionTransitions.discardedIngestionReceipt(
        filteredClearVersionRaceCurrent,
        Date.now()
      )
    ));
  await ingestionRepository.deleteSession(
    filteredClearVersionRaceDiscarded.session,
    filteredClearVersionRaceDiscarded.session.version
  );

  const clearCompletedReady = await createActionReadySession(
    "clear-completed-hydration"
  );
  const clearCompletedRequest = {
    session_id: clearCompletedReady.session_id,
    image_id: clearCompletedReady.image_id,
    expected_version: clearCompletedReady.version,
    expected_md5: clearCompletedReady.prepared.md5,
    commit_request_id: coreUuid.randomUuidV7(),
    duplicate_decision: "upload" as const,
    metadata: clearCompletedReady.metadata
  };
  assert.equal((await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    actionOwner,
    [clearCompletedRequest]
  ))[0].status, "accepted");
  const clearCompletedCommitting = committingSession(await ingestionRepository.readSession(
    actionOwner,
    clearCompletedReady.session_id
  ));
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      clearCompletedReady.image_id,
      actionOwner,
      imagePaths.storageObjectKey(clearCompletedReady.image_id, "webp"),
      clearCompletedReady.prepared.md5
    ]
  );
  await ingestionCommitCompletion.publishCompletedReceipt(
    ingestionRepository,
    clearCompletedCommitting,
    Date.now()
  );
  const clearCompletedPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import" as const,
      offset: 0,
      limit: 10
    });
  const deferredCompletedReady = await createActionReadySession(
    "deferred-clear-completed-boundary"
  );
  const deferredCompletedRequest = {
    session_id: deferredCompletedReady.session_id,
    image_id: deferredCompletedReady.image_id,
    expected_version: deferredCompletedReady.version,
    expected_md5: deferredCompletedReady.prepared.md5,
    commit_request_id: coreUuid.randomUuidV7(),
    duplicate_decision: "upload" as const,
    metadata: deferredCompletedReady.metadata
  };
  assert.equal((await ingestionCommitIntent.acceptIngestionCommitIntents(
    ingestionRepository,
    actionOwner,
    [deferredCompletedRequest]
  ))[0].status, "accepted");
  const deferredCompletedCommitting = committingSession(await ingestionRepository.readSession(
    actionOwner,
    deferredCompletedReady.session_id
  ));
  await database.pool.query(
    "INSERT INTO metadata (id, created_by, storage_slug, object_key, device, "
      + "brightness, theme, ext, md5, status) VALUES "
      + "($1,$2,'local',$3,'pc','dark','none','webp',$4,'ready')",
    [
      deferredCompletedReady.image_id,
      actionOwner,
      imagePaths.storageObjectKey(deferredCompletedReady.image_id, "webp"),
      deferredCompletedReady.prepared.md5
    ]
  );
  await ingestionCommitCompletion.publishCompletedReceipt(
    ingestionRepository,
    deferredCompletedCommitting,
    Date.now()
  );
  const deferredCompletedExecutionPage = await ingestionQueueSnapshot
    .readStableIngestionQueueSnapshot({
      repository: ingestionRepository,
      tokens: actionTokens,
      session: actionSession,
      actionScope: actionScope.id,
      queue: "import" as const,
      offset: 0,
      limit: 10
    });
  const clearCompletedActionRequest = {
    queue: "import" as const,
    action_request_id: coreUuid.randomUuidV7(),
    action: "clear_completed" as const,
    action_watermark: deferredCompletedExecutionPage.action_watermark,
    max_semantic_revision: clearCompletedPage.revision
  };
  const clearCompletedResult = await runAction(
    ingestionRepository,
    clearCompletedActionRequest
  );
  const clearedCompletedItem = clearCompletedResult.items.find((item) => (
    item.session_id === clearCompletedReady.session_id
  ));
  assert.equal(clearedCompletedItem?.status, "changed");
  assert.equal(
    clearedCompletedItem?.completed_item?.id,
    clearCompletedReady.image_id,
    "页外 completed 回执必须在删除前把 PG 水合 DTO 带回动作响应"
  );
  assert.deepEqual(
    await runAction(ingestionRepository, clearCompletedActionRequest),
    clearCompletedResult,
    "completed 回执删除后的同批响应丢失重试必须重放原完成 DTO"
  );
  assert.equal(await ingestionRepository.readSession(
    actionOwner,
    clearCompletedReady.session_id
  ), null);
  const deferredCompletedResult = clearCompletedResult.items.find((item) => (
    item.session_id === deferredCompletedReady.session_id
  ));
  assert.equal(deferredCompletedResult?.status, "skipped");
  assert.equal(
    deferredCompletedResult?.code,
    "ingestion_action_state_changed",
    "重连后执行的关闭清理不得纳入旧 semantic revision 之后才完成的任务"
  );
  const retainedDeferredCompleted = completedSession(await ingestionRepository.readSession(
    actionOwner,
    deferredCompletedReady.session_id
  ));
  assert.ok(retainedDeferredCompleted);
  assert.equal(retainedDeferredCompleted?.status, "completed");
  await ingestionRepository.deleteSession(
    retainedDeferredCompleted,
    retainedDeferredCompleted.version
  );
  await database.pool.query(
    "DELETE FROM metadata WHERE id = ANY($1::uuid[])",
    [[clearCompletedReady.image_id, deferredCompletedReady.image_id]]
  );
  actionScope.close();

});
