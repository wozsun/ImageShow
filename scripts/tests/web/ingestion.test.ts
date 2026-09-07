import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  ingestionActionPath,
  ingestionActionScopeHeader,
  ingestionCancelPath,
  ingestionCommitPath,
  ingestionDuplicatesPath,
  ingestionSnapshotPath,
  ingestionStatusPath,
  ingestionUpdatePath,
  importAcceptPath,
  uploadCredentialHeader,
  uploadIntentPath,
  uploadRawPath,
  type IngestionQueueActionResultDto,
  type IngestionQueueSummaryDto,
  type IngestionVocabularyDto
} from "../../../packages/shared/src/browser.ts";
import type {
  IngestionJob
} from "../../../packages/web/src/lib/types.ts";
import {
  clearCsrfToken,
  setCsrfToken
} from "../../../packages/web/src/lib/api/client.ts";
import {
  invalidateDataAfterAuthorProfileSave,
  invalidateImageDataAfterIngestion,
  invalidateImageDataAfterMetadataSave
} from "../../../packages/web/src/lib/api/query-invalidation.ts";
import {
  queryKeys
} from "../../../packages/web/src/lib/api/query-keys.ts";
import {
  recordAdminImageListValidation
} from "../../../packages/web/src/lib/api/admin-image-list-validation.ts";
import {
  webIngestionBatchKey,
  webUuidV7
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-identity.ts";
import {
  BrowserUploadBatchSequencer,
  BrowserUploadLane
} from "../../../packages/web/src/pages/admin/ingestion/upload/browser-upload-lane.ts";
import {
  canApplyIngestionAttributeDefaults,
  ingestionAttributeDefaultsPatch,
  ingestionJobAttributesEditable
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-attribute-policy.ts";
import {
  browserDisplayPrefixJobs,
  combinedIngestionQueuePagePlan,
  createIngestionCommitIntent,
  ingestionJobCanBeCancelled,
  ingestionJobCanBeRemovedLocally,
  ingestionJobCanLeaveQueue,
  ingestionJobCanStartCommit,
  ingestionQueuePageCount,
  reduceIngestionQueue,
  summarizeIngestionJobs
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import {
  ingestionStatusEventPatch
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-state.ts";
import {
  commitSelectedIngestions
} from "../../../packages/web/src/pages/admin/ingestion/queue/ingestion-commit-batch.ts";
import {
  cancelServerIngestionJob,
  cancelServerIngestionJobs
} from "../../../packages/web/src/pages/admin/ingestion/queue/ingestion-cancel.ts";
import {
  acceptImports,
  createUploadIntents,
  getIngestionQueueSnapshot,
  getIngestionStatuses,
  uploadRaw
} from "../../../packages/web/src/pages/admin/ingestion/queue/ingestion-api.ts";
import {
  ingestionJobStatusDetail,
  ingestionJobStatusLabel
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-detail.ts";
import {
  baselineFromIngestionSnapshot,
  ingestionQueueBaselineCoversSelection,
  mergeIngestionQueueMutation
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-queue-state.ts";
import {
  emptyServerIngestionQueueView,
  parseServerIngestionQueueEvent
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-queue-view.ts";
import {
  draftSyncTarget,
  matchesDraftTarget
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/stored-ingestion-draft-model.ts";
import {
  completedIngestionOwnerPatch,
  completedIngestionReceiptOwnerPatch,
  ingestionJobFromServerItem,
  ingestionJobFromKnownCompletedStatus,
  ingestionJobAwaitsActionCoverage,
  ingestionJobHasServerAuthority,
  ingestionHandoffRetryDecision,
  serverIngestionJobsForCombinedPage
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-job.ts";
import {
  isUnconfirmedUploadRawAttempt,
  resetImportJobForPrepareRetry,
  resetJobForPrepareRetry
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job-retry.ts";
import {
  createUrlImportJobs
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/import-job-source.ts";
import {
  createManifestImportJobs
} from "../../../packages/web/src/pages/admin/ingestion/import/manifest-jobs.ts";
import {
  buildUploadIntentItemInput
} from "../../../packages/web/src/pages/admin/ingestion/upload/upload-jobs.ts";
import {
  cleanupActionType,
  preserveUnresolvedLocalOutcomes,
  retainUnresolvedLocalJobs
} from "../../../packages/web/src/pages/admin/ingestion/workflow/ingestion-workflow-action-model.ts";
import {
  ingestionJob,
  adminImageListItem,
  createConfigStreamHarness
} from "../support/web-test-context.ts";
import {
  dispatchDomEvent,
  inputText
} from "../support/dom-events.ts";
import {
  installControlledClock
} from "../support/controlled-clock.ts";

const selectedQueueScenario = process.env.IMAGESHOW_WEB_QUEUE_SCENARIO;
const queueScenarioIds = new Set([
  "strict-mode",
  "empty-reconnect",
  "reconnect-pagination",
  "handoff-completion"
]);
assert.ok(
  !selectedQueueScenario || queueScenarioIds.has(selectedQueueScenario),
  `未知 Web 队列场景：${selectedQueueScenario}`
);

test("[Web/内容接入] 内容接入模块保持 view、草稿、上传与清理纯边界", () => {
  assert.deepEqual(emptyServerIngestionQueueView("connecting", 3), {
    status: "connecting",
    connectionGeneration: 3,
    actionScope: "",
    revision: null,
    lastAcceptedOrder: null,
    summary: null,
    items: [],
    staleItems: [],
    actionWatermark: "",
    error: ""
  });
  assert.deepEqual(parseServerIngestionQueueEvent(JSON.stringify({
    type: "ready",
    queue: "upload",
    revision: 4,
    action_scope: "scope-four"
  }), "ready", "upload"), {
    type: "ready",
    queue: "upload",
    revision: 4,
    action_scope: "scope-four"
  });
  assert.throws(
    () => parseServerIngestionQueueEvent(
      JSON.stringify({ type: "ready", queue: "import" }),
      "ready",
      "upload"
    ),
    /内容接入队列事件格式无效/u
  );

  const imageId = "019f8457-063a-7001-a580-7a432dc7fd8e";
  const authoritative = ingestionJob({
    serverAccepted: true,
    sessionId: "session-one",
    imageId,
    serverVersion: 6,
    status: "ready"
  });
  const target = draftSyncTarget(authoritative);
  assert.ok(target);
  assert.equal(target.expectedVersion, 6);
  assert.equal(matchesDraftTarget({
    ...authoritative,
    imageId: imageId.toUpperCase()
  }, target), true);
  assert.equal(draftSyncTarget({
    ...authoritative,
    serverAccepted: false
  }), null);

  const localFile = new File(["raw"], "fixture.png", { type: "image/png" });
  const local = ingestionJob({
    kind: "upload",
    file: localFile,
    attemptKey: "attempt-local",
    batchPosition: 2,
    storageSlug: "local"
  });
  assert.deepEqual(buildUploadIntentItemInput(local, 4096), {
    ...local.draft,
    idempotency_key: "attempt-local",
    batch_key: local.batchKey,
    storage_slug: "local",
    batch_time: local.batchTime,
    batch_position: 2,
    expected_size: localFile.size,
    max_long_edge: 4096
  });

  const importedUrl = "https://example.com/image.jpg";
  const importDefaults = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: "",
    author: "",
    tags: []
  };
  assert.equal(
    createUrlImportJobs([importedUrl], importDefaults, false, "local")[0]?.draft.original,
    ""
  );
  assert.equal(
    createUrlImportJobs([importedUrl], importDefaults, true, "local")[0]?.draft.original,
    importedUrl
  );
  const manifestItem = {
    line: 1,
    batch_position: 0,
    original: importedUrl
  };
  const hiddenManifestLink = createManifestImportJobs(
    [manifestItem],
    importDefaults,
    "local",
    "jsonl",
    false
  )[0];
  const retainedManifestLink = createManifestImportJobs(
    [manifestItem],
    importDefaults,
    "local",
    "jsonl",
    true
  )[0];
  assert.equal(hiddenManifestLink?.downloadUrl, importedUrl);
  assert.equal(hiddenManifestLink?.draft.original, "");
  assert.equal(retainedManifestLink?.draft.original, importedUrl);

  const nextAttempt = ingestionJob({ id: "job-2", attemptKey: "attempt-2" });
  assert.deepEqual(retainUnresolvedLocalJobs([local, nextAttempt], {
    unresolved: [{ id: nextAttempt.id, attemptKey: nextAttempt.attemptKey }]
  }), [nextAttempt]);
  assert.deepEqual(preserveUnresolvedLocalOutcomes({
    unresolved: [{ id: nextAttempt.id, attemptKey: nextAttempt.attemptKey }]
  }, {
    unresolved: [{
      id: nextAttempt.id,
      attemptKey: nextAttempt.attemptKey,
      outcome: { succeeded: false }
    }]
  }).unresolved[0]?.outcome, { succeeded: false });
  assert.equal(cleanupActionType("duplicates"), "clear_duplicate_pending");
  assert.equal(cleanupActionType("uncommitted"), "clear_uncommitted");
  assert.equal(cleanupActionType("completed"), "clear_completed");
});
test("[Web/内容接入] 内容接入队列以 pair、version 与 progress_seq 单调合并服务端状态", () => {
  assert.deepEqual(summarizeIngestionJobs([
    ingestionJob({ id: "waiting-download", status: "queued" }),
    ingestionJob({ id: "waiting-prepare", status: "received" }),
    ingestionJob({ id: "active-download", status: "downloading" }),
    ingestionJob({ id: "active-prepare", status: "processing" })
  ]), {
    readyCount: 0,
    unfinishedCount: 4,
    duplicateJobs: 0,
    waitingJobs: 2,
    runningJobs: 2,
    commitQueuedJobs: 0,
    committingJobs: 0,
    finalizedJobs: 0,
    doneJobs: 0,
    failedJobs: 0
  }, "等待 worker 准入的任务不得计入处理中");

  const sessionId = "A".repeat(43);
  const imageId = "019f8457-063a-7002-a580-7a432dc7fd8e";
  const attemptKey = "019f8457-063a-7003-a580-7a432dc7fd8e";
  const base = ingestionJob({
    attemptKey,
    sessionId,
    imageId,
    status: "processing",
    serverVersion: 2,
    serverProgressSeq: 2
  });
  const prepareWaitingItem = {
    session_id: sessionId,
    image_id: imageId,
    queue: "import" as const,
    source_type: "url" as const,
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing" as const,
    phase: "prepare-waiting",
    message: "等待图片处理许可",
    progress: undefined,
    version: 3,
    progress_seq: 0,
    last_semantic_revision: 3,
    accepted_at: 1,
    accepted_order: 1,
    metadata: base.draft,
    storage_slug: "local"
  };
  const waitingForNormalization = ingestionJobFromServerItem(
    prepareWaitingItem,
    base
  );
  assert.equal(waitingForNormalization.status, "received");
  assert.equal(ingestionJobStatusLabel(waitingForNormalization), "待处理");
  assert.equal(
    ingestionJobStatusDetail(waitingForNormalization),
    "原图素材已接收，等待处理"
  );
  assert.equal(
    summarizeIngestionJobs([waitingForNormalization]).waitingJobs,
    1,
    "取得 Normalize 许可前必须计入等待数量"
  );
  const normalizationStarted = ingestionJobFromServerItem({
    ...prepareWaitingItem,
    phase: "normalizing",
    message: "校验格式、压缩原图并生成缩略图",
    progress_seq: 1
  }, waitingForNormalization);
  assert.equal(normalizationStarted.status, "processing");
  assert.equal(ingestionJobStatusLabel(normalizationStarted), "处理中");
  assert.equal(summarizeIngestionJobs([normalizationStarted]).runningJobs, 1);

  const progress = ingestionStatusEventPatch(base, {
    session_id: sessionId,
    image_id: imageId,
    status: "present",
    item: {
      session_id: sessionId,
      image_id: imageId,
      queue: "import",
      source_type: "url",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "preparing",
      phase: "thumbnail",
      message: "processing",
      progress: 80,
      version: 2,
      progress_seq: 9,
      last_semantic_revision: 2,
      accepted_at: 1,
      accepted_order: 1,
      metadata: base.draft,
      storage_slug: "local"
    }
  });
  assert.ok(progress);
  const advanced = reduceIngestionQueue({ jobs: [base], page: 1 }, {
    type: "patch",
    id: base.id,
    patch: progress
  });
  assert.equal(advanced.jobs[0]?.serverProgressSeq, 9);
  assert.equal(advanced.jobs[0]?.serverProgress, 80);

  const resolving = ingestionStatusEventPatch(base, {
    session_id: sessionId,
    image_id: imageId,
    status: "present",
    item: {
      session_id: sessionId,
      image_id: imageId,
      queue: "import",
      source_type: "url",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "resolving",
      phase: "commit-result",
      message: "核对提交结果",
      version: 3,
      progress_seq: 0,
      last_semantic_revision: 3,
      accepted_at: 1,
      accepted_order: 1,
      metadata: base.draft,
      storage_slug: "local"
    }
  });
  assert.equal(resolving?.status, "finalized");

  const stale = ingestionStatusEventPatch(advanced.jobs[0]!, {
    session_id: sessionId,
    image_id: imageId,
    status: "present",
    item: {
      session_id: sessionId,
      image_id: imageId,
      queue: "import",
      source_type: "url",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "preparing",
      phase: "thumbnail",
      message: "stale",
      progress: 20,
      version: 2,
      progress_seq: 3,
      last_semantic_revision: 2,
      accepted_at: 1,
      accepted_order: 1,
      metadata: base.draft,
      storage_slug: "local"
    }
  });
  assert.ok(stale);
  assert.equal(reduceIngestionQueue(advanced, {
    type: "patch",
    id: base.id,
    patch: stale
  }), advanced);
  assert.equal(ingestionStatusEventPatch(base, {
    session_id: "B".repeat(43),
    image_id: imageId,
    status: "missing"
  }), null);
  const accepted = ingestionJob({
    ...base,
    objectUrl: "blob:retained-missing-card",
    serverAccepted: true,
    serverHandoffPending: true,
    serverDraftPending: true,
    serverHandoffRevision: 12,
    serverAcceptedOrder: 4
  });
  const missingPatch = ingestionStatusEventPatch(accepted, {
    session_id: sessionId,
    image_id: imageId,
    status: "missing"
  });
  assert.ok(missingPatch);
  const missingCard = { ...accepted, ...missingPatch };
  assert.equal(missingCard.status, "failed");
  assert.equal(missingCard.serverAccepted, false);
  assert.equal(missingCard.serverHandoffPending, false);
  assert.equal(missingCard.serverDraftPending, false);
  assert.equal(missingCard.serverHandoffRevision, undefined);
  assert.equal(missingCard.serverAcceptedOrder, undefined);
  assert.equal(missingCard.objectUrl, "blob:retained-missing-card");
  assert.equal(missingCard.message, "未完成内容接入已过期或被服务器丢弃");
  assert.equal(isUnconfirmedUploadRawAttempt(ingestionJob({
    kind: "upload",
    sessionId,
    imageId,
    status: "failed",
    failureStage: "prepare",
    serverStatus: "missing"
  })), true, "canonical 缺失的 raw 失败必须复用原幂等身份重传");
  assert.equal(isUnconfirmedUploadRawAttempt(ingestionJob({
    kind: "upload",
    sessionId,
    imageId,
    status: "failed",
    failureStage: "prepare",
    serverVersion: 1
  })), false, "已由 canonical 接管的失败不得走 raw 意图重放");
  const frozenUploadInput = {
    ...base.draft,
    idempotency_key: attemptKey,
    batch_key: "frozen-upload-batch",
    storage_slug: "local",
    batch_time: "2026-08-23T01:02:03.456Z",
    batch_position: 0,
    expected_size: 1,
    max_long_edge: 4096
  };
  const frozenUploadJob = ingestionJob({
    kind: "upload",
    attemptKey,
    sessionId,
    imageId,
    status: "failed",
    failureStage: "prepare",
    uploadIntentItemInput: frozenUploadInput
  });
  assert.equal(
    ingestionJobAttributesEditable(frozenUploadJob),
    false,
    "接管请求开始后必须冻结会进入 request hash 的草稿"
  );
  assert.equal(
    resetJobForPrepareRetry(frozenUploadJob).uploadIntentItemInput,
    undefined,
    "新尝试不得继承旧 upload intent 正文"
  );
  const retriedServerJob = resetJobForPrepareRetry(ingestionJob({
    ...frozenUploadJob,
    serverAccepted: true,
    serverSemanticRevision: 11,
    serverAcceptedOrder: 19
  }));
  assert.equal(retriedServerJob.serverAccepted, undefined);
  assert.equal(retriedServerJob.serverSemanticRevision, undefined);
  assert.equal(retriedServerJob.serverAcceptedOrder, undefined);
  const frozenImportInput = {
    ...base.draft,
    idempotency_key: attemptKey,
    batch_key: "frozen-import-batch",
    batch_position: 0,
    source_type: "url" as const,
    download_url: "https://example.com/frozen.webp",
    storage_slug: "local"
  };
  assert.equal(
    resetImportJobForPrepareRetry(ingestionJob({
      attemptKey,
      status: "failed",
      failureStage: "create",
      importAcceptItemInput: frozenImportInput
    })).importAcceptItemInput,
    frozenImportInput,
    "Import 响应未知重放必须保留原幂等正文"
  );
  const inFlightPlaceholder = ingestionJob({
    id: "in-flight-defaults",
    attemptKey,
    status: "queued",
    importAcceptItemInput: frozenImportInput,
    serverAccepted: false
  });
  const inFlightDefaults = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: "",
    author: "clicked-while-accepting",
    tags: []
  };
  assert.equal(
    ingestionAttributeDefaultsPatch(inFlightPlaceholder, inFlightDefaults).author,
    "clicked-while-accepting",
    "已发出 accept 的 placeholder 仍属于应用到全部捕获的本地前缀"
  );
  assert.equal(
    canApplyIngestionAttributeDefaults(inFlightPlaceholder, inFlightDefaults),
    true,
    "只有在途 placeholder 时也必须启用应用到全部"
  );
  const defaultsAppliedInFlight = reduceIngestionQueue({
    jobs: [inFlightPlaceholder],
    page: 1
  }, {
    type: "apply-defaults",
    defaults: inFlightDefaults,
    attempts: new Map([[inFlightPlaceholder.id, attemptKey]])
  }).jobs[0]!;
  assert.equal(defaultsAppliedInFlight.draft.author, "clicked-while-accepting");
  assert.equal(defaultsAppliedInFlight.serverDraftPending, true);
  assert.equal(
    defaultsAppliedInFlight.importAcceptItemInput,
    frozenImportInput,
    "已冻结的 accept 正文不得随本地前缀草稿一起改写"
  );

  const ready = ingestionJob({
    attemptKey,
    sessionId,
    imageId,
    status: "ready",
    serverVersion: 3
  });
  assert.equal(ingestionJobCanStartCommit(ready, "new"), true);
  assert.equal(ingestionJobCanBeCancelled(ready), true);
  assert.equal(ingestionJobCanLeaveQueue(ready), true);
  assert.equal(ingestionJobCanBeRemovedLocally(ingestionJob({
    ...ready,
    status: "done",
    serverAccepted: true,
    serverStatus: "completed"
  })), false, "Server completed 回执只能通过清空已完成持久删除");
  assert.equal(ingestionJobCanBeRemovedLocally(ingestionJob({
    ...ready,
    status: "done",
    serverAccepted: false
  })), true, "PG 已接管且 Redis 回执缺失的本地完成卡仍可移除");
  assert.equal(ingestionQueuePageCount(51, 20), 3);
  const intent = createIngestionCommitIntent(
    ready,
    "019f8457-063a-7004-a580-7a432dc7fd8e"
  );
  assert.equal(intent.attemptId[14], "7");
  assert.deepEqual(intent.metadata.tags, ["existing-tag"]);
  const failedFrozenCommit = ingestionJob({
    ...ready,
    status: "failed",
    failureStage: "commit",
    serverStatus: "failed",
    commitIntent: intent
  });
  assert.equal(ingestionJobCanStartCommit(failedFrozenCommit, "resume"), true);
  assert.equal(
    ingestionJobCanBeCancelled(failedFrozenCommit),
    true,
    "服务端确认提交失败后必须允许显式取消冻结意图"
  );
  assert.equal(ingestionJobCanLeaveQueue(failedFrozenCommit), true);
  assert.equal(ingestionJobCanBeCancelled(ingestionJob({
    ...failedFrozenCommit,
    serverStatus: undefined
  })), false, "结果未知的本地提交失败不得被当成可安全移除");

  const completedStatus = {
    session_id: sessionId,
    image_id: imageId,
    status: "completed" as const,
    completed_item: adminImageListItem({ id: imageId }),
    redis_status: "completed" as const,
    redis_version: 4,
    redis_last_semantic_revision: 4
  };
  assert.equal(
    ingestionJobFromKnownCompletedStatus(base, completedStatus),
    null,
    "Redis 回执仍在分页队列时不得追加第二张本地完成卡"
  );
  assert.equal(
    ingestionJobFromKnownCompletedStatus(base, {
      ...completedStatus,
      redis_status: "missing" as const,
      redis_version: undefined,
      redis_last_semantic_revision: undefined
    })?.status,
    "done",
    "只有 Redis 回执缺失时才由已知 PG 结果接管本地卡片"
  );

  const localPlaceholder = ingestionJob({
    id: "local-placeholder",
    kind: "upload",
    sessionId,
    imageId,
    serverAccepted: false,
    status: "received",
    file: { name: "handoff.webp" } as File
  });
  const acceptedBeforeChannel = ingestionJob({
    ...localPlaceholder,
    serverAccepted: true,
    serverSemanticRevision: 10,
    serverHandoffPending: true,
    serverHandoffRevision: 10
  });
  assert.equal(
    ingestionJobAwaitsActionCoverage(acceptedBeforeChannel, 9),
    true,
    "HTTP accept 后必须等状态通道水位覆盖 canonical 才能执行全队列动作"
  );
  assert.equal(ingestionJobAwaitsActionCoverage(acceptedBeforeChannel, 10), false);
  assert.equal(ingestionJobAwaitsActionCoverage({
    ...acceptedBeforeChannel,
    serverAcceptedOrder: 1
  }, 9), true, "旧 DTO 的 accepted_order 不得越过更新的 HTTP 接管围栏");
  const canonical = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "upload",
    source_type: "upload",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing",
    phase: "thumbnail",
    message: "processing",
    progress: 50,
    version: 2,
    progress_seq: 1,
    last_semantic_revision: 8,
    accepted_at: 1,
    accepted_order: 1,
    metadata: localPlaceholder.draft,
    storage_slug: "local"
  }, localPlaceholder);
  const handedOff = reduceIngestionQueue({
    jobs: [localPlaceholder],
    page: 1
  }, {
    type: "replace-server-page",
    jobs: [canonical]
  });
  assert.equal(handedOff.jobs.length, 1);
  assert.equal(handedOff.jobs[0]?.id, localPlaceholder.id);
  assert.equal(handedOff.jobs[0]?.serverAccepted, true);
  assert.equal(handedOff.jobs[0]?.file, localPlaceholder.file);

  const unboundLocal = ingestionJob({
    id: "late-http-placeholder",
    kind: "import",
    sessionId: undefined,
    imageId: undefined,
    serverAccepted: false,
    serverDraftPending: true,
    status: "queued",
    draft: {
      ...ingestionJob().draft,
      title: "点击时冻结的新草稿"
    },
    file: { name: "late-handoff.webp" } as File
  });
  const earlyCanonical = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "import",
    source_type: "url",
    download_url: "https://example.com/late.webp",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing",
    phase: "thumbnail",
    message: "processing",
    progress: 60,
    version: 3,
    progress_seq: 2,
    last_semantic_revision: 9,
    accepted_at: 1,
    accepted_order: 2,
    metadata: {
      ...unboundLocal.draft,
      title: "accept 请求里的旧草稿"
    },
    storage_slug: "local"
  });
  const lateBinding = reduceIngestionQueue({
    jobs: [unboundLocal, earlyCanonical],
    page: 1
  }, {
    type: "bind-server",
    id: unboundLocal.id,
    binding: {
      sessionId,
      imageId,
      imageTime: "2026-08-23T01:02:03.456Z",
      serverVersion: 4,
      serverSemanticRevision: 10,
      serverHandoffPending: true,
      serverHandoffRevision: 10,
      serverHandoffDisplayPage: 1,
      serverHandoffProvisionalTotal: true,
      status: "queued",
      message: "等待服务器下载"
    }
  });
  assert.equal(lateBinding.jobs.length, 1);
  assert.equal(lateBinding.jobs[0]?.id, unboundLocal.id);
  assert.equal(lateBinding.jobs[0]?.file, unboundLocal.file);
  assert.equal(lateBinding.jobs[0]?.serverAccepted, true);
  assert.equal(lateBinding.jobs[0]?.status, "processing");
  assert.equal(lateBinding.jobs[0]?.serverVersion, 4);
  assert.equal(lateBinding.jobs[0]?.serverSemanticRevision, 10);
  assert.equal(lateBinding.jobs[0]?.serverAcceptedOrder, 2);
  assert.equal(lateBinding.jobs[0]?.serverHandoffRevision, 10);
  assert.equal(lateBinding.jobs[0]?.serverDraftPending, true);
  assert.equal(lateBinding.jobs[0]?.draft.title, "点击时冻结的新草稿");
  assert.equal(lateBinding.jobs[0]?.serverHandoffDisplayPage, 1);
  assert.equal(lateBinding.jobs[0]?.serverHandoffProvisionalTotal, true);
  assert.equal(
    ingestionJobAwaitsActionCoverage(lateBinding.jobs[0]!, 9),
    true,
    "HTTP R+1 响应先于 SSE 时必须保留独立围栏"
  );
  assert.equal(ingestionJobAwaitsActionCoverage(lateBinding.jobs[0]!, 10), false);

  const oldIncarnationImageId =
    "019f8457-063a-7008-a580-7a432dc7fd8e";
  const newIncarnationPlaceholder = ingestionJob({
    id: "new-incarnation-placeholder",
    attemptKey: "new-incarnation-attempt",
    batchKey: "new-incarnation-batch",
    kind: "import",
    status: "queued",
    preview: "new-incarnation-preview"
  });
  const oldIncarnation = ingestionJob({
    id: "server:old-incarnation",
    attemptKey: "old-incarnation-attempt",
    batchKey: "old-incarnation-batch",
    kind: "import",
    sessionId,
    imageId: oldIncarnationImageId,
    serverAccepted: true,
    serverVersion: 99,
    serverStatus: "failed",
    serverError: "old incarnation error",
    preview: "old-incarnation-preview",
    status: "failed"
  });
  const replacedIncarnation = reduceIngestionQueue({
    jobs: [newIncarnationPlaceholder, oldIncarnation],
    page: 1
  }, {
    type: "bind-server",
    id: newIncarnationPlaceholder.id,
    binding: {
      sessionId,
      imageId,
      serverVersion: 1,
      serverSemanticRevision: 12,
      serverHandoffPending: true,
      serverHandoffRevision: 12,
      serverHandoffDisplayPage: 1,
      status: "received",
      message: "服务器已接管新 incarnation"
    }
  });
  assert.equal(replacedIncarnation.jobs.length, 1);
  assert.equal(replacedIncarnation.jobs[0]?.id, newIncarnationPlaceholder.id);
  assert.equal(replacedIncarnation.jobs[0]?.imageId, imageId);
  assert.equal(replacedIncarnation.jobs[0]?.serverVersion, 1);
  assert.equal(
    replacedIncarnation.jobs[0]?.preview,
    "new-incarnation-preview",
    "同 session 新 incarnation 不得继承旧 canonical preview"
  );
  assert.equal(replacedIncarnation.jobs[0]?.serverStatus, undefined);
  assert.equal(replacedIncarnation.jobs[0]?.serverError, undefined);

  const staleSnapshotDuringDraftFence = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "import",
    source_type: "url",
    download_url: "https://example.com/late.webp",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing",
    phase: "thumbnail",
    message: "processing",
    progress: 70,
    version: 4,
    progress_seq: 3,
    last_semantic_revision: 10,
    accepted_at: 1,
    accepted_order: 2,
    metadata: {
      ...unboundLocal.draft,
      title: "旧快照中的草稿"
    },
    storage_slug: "local"
  }, {
    ...lateBinding.jobs[0]!,
    serverVersion: 5,
    serverSemanticRevision: 11,
    serverDraftPending: true,
    draft: {
      ...unboundLocal.draft,
      title: "HTTP 已确认的新草稿"
    }
  }, 10);
  assert.equal(staleSnapshotDuringDraftFence.serverVersion, 5);
  assert.equal(staleSnapshotDuringDraftFence.serverSemanticRevision, 11);
  assert.equal(staleSnapshotDuringDraftFence.serverDraftPending, true);
  assert.equal(
    staleSnapshotDuringDraftFence.draft.title,
    "HTTP 已确认的新草稿",
    "草稿围栏解除前，旧快照不得回退版本或覆盖新草稿"
  );

  const completedReplayBeforeSnapshot = reduceIngestionQueue({
    jobs: [localPlaceholder],
    page: 1
  }, {
    type: "bind-server",
    id: localPlaceholder.id,
    binding: {
      sessionId,
      imageId,
      serverAccepted: true,
      serverHandoffPending: true,
      serverHandoffRevision: undefined,
      status: "finalized",
      resultState: "recovering",
      message: "图片已写入图库，正在读取结果"
    }
  }).jobs[0]!;
  assert.equal(
    ingestionJobAwaitsActionCoverage(completedReplayBeforeSnapshot, 999),
    true,
    "未知 Redis 水位的 completed 重放必须等待一次新权威快照"
  );
  const completedReplayDuringActiveSnapshot = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "upload",
    source_type: "upload",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing",
    phase: "thumbnail",
    message: "processing",
    progress: 50,
    version: 5,
    progress_seq: 1,
    last_semantic_revision: 11,
    accepted_at: 1,
    accepted_order: 1,
    metadata: localPlaceholder.draft,
    storage_slug: "local"
  }, completedReplayBeforeSnapshot, 11);
  assert.equal(completedReplayDuringActiveSnapshot.serverHandoffPending, true);
  assert.equal(
    ingestionJobAwaitsActionCoverage(completedReplayDuringActiveSnapshot, 11),
    true,
    "active 快照不能冒充尚未形成的 Redis completed transition"
  );
  const completionDisplaySource = {
    ...completedReplayDuringActiveSnapshot,
    originalWidth: 6002,
    originalHeight: 9000,
    originalSize: 12_345_678,
    manifestSource: "weibo" as const,
    batchPosition: 4
  };
  const completedReplayAfterSnapshot = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "upload",
    status: "completed",
    version: 6,
    progress_seq: 0,
    last_semantic_revision: 12,
    accepted_at: 1,
    accepted_order: 1,
    completed_at: 2,
    completed_item: adminImageListItem({ id: imageId })
  }, completionDisplaySource, 12);
  assert.equal(completedReplayAfterSnapshot.serverHandoffPending, false);
  assert.equal(completedReplayAfterSnapshot.finalSize, 1);
  assert.equal(completedReplayAfterSnapshot.draft.source, "");
  assert.equal(completedReplayAfterSnapshot.width, 1600);
  assert.equal(completedReplayAfterSnapshot.height, 900);
  assert.equal(completedReplayAfterSnapshot.originalWidth, 6002);
  assert.equal(completedReplayAfterSnapshot.originalHeight, 9000);
  assert.equal(completedReplayAfterSnapshot.originalSize, 12_345_678);
  assert.equal(completedReplayAfterSnapshot.manifestSource, "weibo");
  assert.equal(completedReplayAfterSnapshot.batchPosition, 4);
  assert.equal(
    ingestionJobAwaitsActionCoverage(completedReplayAfterSnapshot, 12),
    false
  );

  const recoveredCompleted = ingestionJobFromServerItem({
    session_id: sessionId,
    image_id: imageId,
    queue: "import",
    status: "completed",
    version: 6,
    progress_seq: 0,
    last_semantic_revision: 12,
    accepted_at: 1,
    accepted_order: 1,
    completed_at: 2,
    display: {
      source_type: "weibo",
      batch_position: 6,
      original_width: 6002,
      original_height: 9000,
      original_size: 12_345_678,
      quality: 80,
      transcoded: true
    },
    completed_item: adminImageListItem({
      id: imageId,
      width: 3001,
      height: 4500,
      image_size: 456_789
    })
  }, ingestionJob({
    batchPosition: 6,
    browserDisplayReleased: true
  }));
  assert.equal(recoveredCompleted.width, 3001);
  assert.equal(recoveredCompleted.height, 4500);
  assert.equal(recoveredCompleted.finalSize, 456_789);
  assert.equal(recoveredCompleted.originalWidth, 6002);
  assert.equal(recoveredCompleted.originalHeight, 9000);
  assert.equal(recoveredCompleted.originalSize, 12_345_678);
  assert.equal(recoveredCompleted.quality, 80);
  assert.equal(recoveredCompleted.transcoded, true);
  assert.equal(recoveredCompleted.manifestSource, "weibo");
  assert.equal(recoveredCompleted.batchPosition, 6);
  assert.equal(
    recoveredCompleted.browserDisplayReleased,
    true,
    "完成回执重映射不得反复夺回已释放的浏览器排序所有权"
  );
  const restoredActive = ingestionJobFromServerItem({
    session_id: "A".repeat(43),
    image_id: "019f8457-063a-7091-a580-7a432dc7fd8e",
    queue: "import",
    source_type: "weibo",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "queued",
    phase: "queued",
    message: "queued",
    version: 1,
    progress_seq: 0,
    last_semantic_revision: 1,
    accepted_at: 1,
    accepted_order: 2,
    metadata: localPlaceholder.draft,
    storage_slug: "local",
    batch_position: 2
  });
  assert.equal(
    restoredActive.browserDisplayReleased,
    true,
    "无本地 owner 的恢复卡片必须立即使用 Server 稳定顺序"
  );
  assert.equal(
    completedReplayDuringActiveSnapshot.browserDisplayReleased,
    undefined,
    "已有浏览器占位的接管卡片必须保留同批展示所有权"
  );
  const restoredCompletedWithoutOwner = ingestionJobFromServerItem({
    session_id: "B".repeat(43),
    image_id: "019f8457-063a-7092-a580-7a432dc7fd8e",
    queue: "import",
    status: "completed",
    version: 2,
    progress_seq: 0,
    last_semantic_revision: 2,
    accepted_at: 1,
    accepted_order: 3,
    completed_at: 2,
    completed_item: adminImageListItem({
      id: "019f8457-063a-7092-a580-7a432dc7fd8e"
    })
  });
  assert.equal(
    restoredCompletedWithoutOwner.browserDisplayReleased,
    true,
    "窗口重开水合的完成卡片不得再经历一次浏览器批次释放"
  );

  const acceptedWithoutSnapshot = reduceIngestionQueue({
    jobs: [localPlaceholder],
    page: 1
  }, {
    type: "bind-server",
    id: localPlaceholder.id,
    binding: {
      sessionId,
      imageId,
      status: "received",
      message: "服务器已接管"
    }
  }).jobs[0]!;
  assert.equal(
    ingestionJobHasServerAuthority(acceptedWithoutSnapshot),
    true,
    "accept 成功必须立即转交业务权威，不能等待 accepted_order"
  );
  assert.equal(acceptedWithoutSnapshot.serverAcceptedOrder, undefined);

  const handoffBatchKey = webUuidV7();
  const sourceOrderedBatch = Array.from({ length: 5 }, (_, position) => (
    ingestionJob({
      id: `source-order-${position}`,
      attemptKey: `source-order-attempt-${position}`,
      batchKey: handoffBatchKey,
      batchPosition: position,
      serverAccepted: false,
      status: "uploading"
    })
  ));
  let partiallyAccepted = {
    jobs: sourceOrderedBatch,
    page: 1
  };
  for (const position of [4, 1]) {
    partiallyAccepted = reduceIngestionQueue(partiallyAccepted, {
      type: "bind-server",
      id: `source-order-${position}`,
      binding: {
        sessionId: String(position).padStart(43, "S"),
        imageId: `019f8457-063a-7${String(position).padStart(3, "0")}-a580-7a432dc7fd8e`,
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: position + 1,
        serverHandoffDisplayPage: 1,
        status: "received"
      }
    });
  }
  const acceptedBySnapshotOrder = [1, 4].map((position) => (
    partiallyAccepted.jobs.find((job) => (
      job.id === `source-order-${position}`
    ))!
  ));
  partiallyAccepted = reduceIngestionQueue(partiallyAccepted, {
    type: "replace-server-page",
    jobs: acceptedBySnapshotOrder
  });
  assert.deepEqual(
    browserDisplayPrefixJobs(partiallyAccepted.jobs).map((job) => (
      job.batchPosition
    )),
    [0, 1, 2, 3, 4],
    "同批 raw 乱序接管时，浏览器展示所有权必须保留来源顺序"
  );
  assert.equal(
    partiallyAccepted.jobs.length,
    5,
    "Server 快照不得从当前文档展示所有权中拆走已接管卡片"
  );
  partiallyAccepted = reduceIngestionQueue(partiallyAccepted, {
    type: "replace-server-page",
    jobs: []
  });
  assert.deepEqual(
    browserDisplayPrefixJobs(partiallyAccepted.jobs).map((job) => (
      job.batchPosition
    )),
    [0, 1, 2, 3, 4],
    "后续页未覆盖 pair 时也不得丢失当前文档的已接管展示项"
  );
  const partialPagePlan = combinedIngestionQueuePagePlan(
    partiallyAccepted.jobs,
    1,
    20,
    100
  );
  assert.equal(partialPagePlan.serverOffset, 0);
  assert.equal(partialPagePlan.serverLimit, 20);
  assert.equal(partialPagePlan.serverDisplayLimit, 15);
  assert.equal(partialPagePlan.acceptedDisplayPairs.size, 2);
  assert.equal(partialPagePlan.excludedServerItems.length, 2);
  assert.equal(partialPagePlan.includedServerItems.length, 2);
  assert.deepEqual(
    partialPagePlan.visibleDisplayPrefixJobs.map((job) => job.batchPosition),
    [0, 1, 2, 3, 4],
    "逐项接管只能扩大覆盖读取，不得改变当前页卡片位置"
  );

  const fullyAcceptedBatch = sourceOrderedBatch.map((job, position) => ({
    ...job,
    sessionId: String(position).padStart(43, "F"),
    imageId: `019f8457-063a-71${String(position).padStart(2, "0")}-a580-7a432dc7fd8e`,
    serverAccepted: true,
    serverHandoffPending: false,
    status: "received" as const
  }));
  const fullyAcceptedPlan = combinedIngestionQueuePagePlan(
    fullyAcceptedBatch,
    1,
    20,
    100
  );
  assert.deepEqual(
    fullyAcceptedPlan.visibleDisplayPrefixJobs.map((job) => job.batchPosition),
    [0, 1, 2, 3, 4],
    "整批接管后当前文档仍须保留原卡片位置"
  );
  assert.equal(fullyAcceptedPlan.excludedServerItems.length, 5);
  assert.equal(fullyAcceptedPlan.includedServerItems.length, 5);
  assert.equal(fullyAcceptedPlan.serverLimit, 20);
  const retainedBatch = reduceIngestionQueue({
    jobs: fullyAcceptedBatch,
    page: 1
  }, {
    type: "replace-server-page",
    jobs: [...fullyAcceptedBatch]
  });
  assert.deepEqual(
    browserDisplayPrefixJobs(retainedBatch.jobs).map((job) => job.batchPosition),
    [0, 1, 2, 3, 4],
    "当前文档必须在完整接管后继续保序，避免快照参数扩张尾请求"
  );
  assert.ok(retainedBatch.jobs.every((job) => (
    job.browserDisplayReleased !== true && job.batchPosition !== undefined
  )), "只有窗口重开后的 Server-only 任务才应释放浏览器展示顺序");

  const paginationBatchKey = webUuidV7();
  const paginationJobs = Array.from({ length: 23 }, (_, position) => {
    const positionHex = position.toString(16).padStart(3, "0");
    return ingestionJob({
      id: `pagination-owner-${position}`,
      attemptKey: `pagination-attempt-${position}`,
      batchKey: paginationBatchKey,
      batchPosition: position,
      sessionId: `pagination-session-${position}`,
      imageId: `019f8457-063a-7${positionHex}-a580-7a432dc7fd8e`,
      serverAccepted: true,
      status: "committing",
      serverStatus: "committing",
      serverPhase: "committing",
      serverVersion: 5,
      serverProgressSeq: 0,
      serverSemanticRevision: 5
    });
  });
  const compactCompletionOwner = {
    ...paginationJobs[22]!,
    preview: "blob:compact-completion-preview",
    objectUrl: "blob:compact-completion-preview"
  };
  const compactCompletionPatch = completedIngestionReceiptOwnerPatch(
    compactCompletionOwner,
    {
      session_id: compactCompletionOwner.sessionId!,
      image_id: compactCompletionOwner.imageId!,
      status: "completed",
      version: 6,
      progress_seq: 0,
      last_semantic_revision: 6,
      accepted_at: 1,
      accepted_order: 23
    }
  );
  assert.ok(compactCompletionPatch);
  assert.equal(compactCompletionPatch.status, "done");
  assert.equal(compactCompletionPatch.resultState, "recovering");
  assert.equal(
    compactCompletionPatch.objectUrl,
    undefined,
    "compact 回执不得在 PostgreSQL DTO 水合前覆盖或提前回收本地预览"
  );
  const compactCompletedJob = {
    ...compactCompletionOwner,
    ...compactCompletionPatch
  };
  assert.equal(
    compactCompletedJob.objectUrl,
    "blob:compact-completion-preview",
    "compact 终态围栏必须把 Blob 保留到完整 DTO 水合"
  );
  assert.equal(
    ingestionJobFromServerItem({
      session_id: compactCompletionOwner.sessionId!,
      image_id: compactCompletionOwner.imageId!,
      queue: "upload",
      source_type: "upload",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "resolving",
      phase: "resolving",
      message: "迟到的提交响应",
      progress: undefined,
      version: 5,
      progress_seq: 0,
      last_semantic_revision: 5,
      accepted_at: 1,
      accepted_order: 23,
      metadata: compactCompletionOwner.draft,
      storage_slug: "local"
    }, compactCompletedJob),
    compactCompletedJob,
    "compact completed 必须立即建立不可回退的逐项终态围栏"
  );
  const completedPatchFor = (job: IngestionJob, version = 6) => {
    const patch = completedIngestionOwnerPatch(job, {
      pair: {
        session_id: job.sessionId!,
        image_id: job.imageId!
      },
      item: adminImageListItem({
        id: job.imageId!,
        title: `completed-${job.batchPosition}`
      }),
      serverVersion: version,
      serverSemanticRevision: version
    });
    assert.ok(patch);
    return patch;
  };
  const allCompletionPatches = new Map(paginationJobs.map((job) => (
    [job.id, completedPatchFor(job)] as const
  )));
  allCompletionPatches.set(
    paginationJobs[22]!.id,
    compactCompletionPatch
  );
  let completedPaginationState = reduceIngestionQueue({
    jobs: paginationJobs,
    page: 1
  }, {
    type: "patch-many",
    patches: allCompletionPatches
  });
  assert.equal(completedPaginationState.jobs.length, 23);
  assert.ok(completedPaginationState.jobs.every((job) => job.status === "done"));
  completedPaginationState = reduceIngestionQueue(completedPaginationState, {
    type: "set-page",
    page: 2,
    pageSize: 20,
    totalItems: 23
  });
  const completedSecondPageFirstRender = combinedIngestionQueuePagePlan(
    completedPaginationState.jobs,
    completedPaginationState.page,
    20,
    100
  ).visibleDisplayPrefixJobs;
  assert.deepEqual(
    completedSecondPageFirstRender.map((job) => job.batchPosition),
    [20, 21, 22]
  );
  assert.deepEqual(
    completedSecondPageFirstRender.map((job) => job.status),
    ["done", "done", "done"],
    "23 项在第一页停留期间完成后，第二页首次渲染必须直接使用逐项最终状态"
  );

  const partialCompletionPatches = new Map<string, Partial<IngestionJob>>();
  for (const position of [20, 22]) {
    const job = paginationJobs[position]!;
    partialCompletionPatches.set(job.id, completedPatchFor(job));
  }
  const failedSecondPageOwner = paginationJobs[21]!;
  partialCompletionPatches.set(
    failedSecondPageOwner.id,
    ingestionJobFromServerItem({
      session_id: failedSecondPageOwner.sessionId!,
      image_id: failedSecondPageOwner.imageId!,
      queue: "import",
      source_type: "url",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "failed",
      phase: "commit-failed",
      message: "逐项提交失败",
      error: { code: "commit_failed", message: "逐项提交失败" },
      version: 6,
      progress_seq: 0,
      last_semantic_revision: 6,
      accepted_at: 1,
      accepted_order: 22,
      metadata: failedSecondPageOwner.draft,
      storage_slug: "local"
    }, failedSecondPageOwner)
  );
  let partialPaginationState = reduceIngestionQueue({
    jobs: paginationJobs,
    page: 1
  }, {
    type: "patch-many",
    patches: partialCompletionPatches
  });
  assert.ok(
    partialPaginationState.jobs.slice(0, 20)
      .every((job) => job.status === "committing"),
    "顶部汇总不得被用来批量猜测未收到逐项事实的卡片"
  );
  partialPaginationState = reduceIngestionQueue(partialPaginationState, {
    type: "set-page",
    page: 2,
    pageSize: 20,
    totalItems: 23
  });
  assert.deepEqual(
    combinedIngestionQueuePagePlan(
      partialPaginationState.jobs,
      partialPaginationState.page,
      20,
      100
    ).visibleDisplayPrefixJobs.map((job) => job.status),
    ["done", "failed", "done"],
    "离页逐项成功与失败必须保持各自权威结果"
  );

  const completedOwner = completedPaginationState.jobs[20]!;
  const staleSnapshotOwner = ingestionJobFromServerItem({
    session_id: completedOwner.sessionId!,
    image_id: completedOwner.imageId!,
    queue: "import",
    source_type: "url",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "resolving",
    phase: "commit-result",
    message: "旧分页快照",
    version: 5,
    progress_seq: 0,
    last_semantic_revision: 5,
    accepted_at: 1,
    accepted_order: 21,
    metadata: completedOwner.draft,
    storage_slug: "local"
  }, completedOwner);
  assert.equal(
    staleSnapshotOwner,
    completedOwner,
    "完成事件先于分页 snapshot 时，旧 active DTO 必须被单调围栏"
  );
  const racedSnapshotState = reduceIngestionQueue(
    completedPaginationState,
    { type: "replace-server-page", jobs: [staleSnapshotOwner] }
  );
  assert.equal(racedSnapshotState.jobs.length, 23);
  assert.equal(
    racedSnapshotState.jobs.find((job) => job.id === completedOwner.id)?.status,
    "done"
  );
  assert.equal(
    new Set(racedSnapshotState.jobs.map((job) => job.id)).size,
    23,
    "分页 snapshot 与完成事件交叉不得重复挂载卡片"
  );

  const responseRaceOwner = paginationJobs[0]!;
  const finalizedResponsePatch: Partial<IngestionJob> = {
    serverAttemptKey: responseRaceOwner.attemptKey,
    serverSessionId: responseRaceOwner.sessionId,
    serverImageId: responseRaceOwner.imageId,
    serverVersion: 7,
    serverProgressSeq: 0,
    serverStatus: "resolving",
    serverPhase: "commit-result",
    status: "finalized" as const,
    resultState: "pending" as const,
    message: "等待完成结果"
  };
  const finalizedBeforeEvent = reduceIngestionQueue({
    jobs: [responseRaceOwner],
    page: 1
  }, {
    type: "patch",
    id: responseRaceOwner.id,
    patch: finalizedResponsePatch
  });
  const eventAfterResponse = reduceIngestionQueue(finalizedBeforeEvent, {
    type: "patch",
    id: responseRaceOwner.id,
    patch: completedPatchFor(finalizedBeforeEvent.jobs[0]!, 6)
  });
  assert.equal(eventAfterResponse.jobs[0]?.status, "done");
  assert.equal(eventAfterResponse.jobs[0]?.serverVersion, 7);
  const progressedResponseOwner = {
    ...finalizedBeforeEvent.jobs[0]!,
    serverProgressSeq: 4
  };
  const eventAfterProgressedResponse = reduceIngestionQueue({
    jobs: [progressedResponseOwner],
    page: 1
  }, {
    type: "patch",
    id: progressedResponseOwner.id,
    patch: completedPatchFor(progressedResponseOwner, 6)
  });
  assert.equal(eventAfterProgressedResponse.jobs[0]?.status, "done");
  assert.equal(eventAfterProgressedResponse.jobs[0]?.serverVersion, 7);
  assert.equal(
    eventAfterProgressedResponse.jobs[0]?.serverProgressSeq,
    4,
    "较旧完成事实必须取胜，但不能倒退浏览器已观察到的 Redis 时钟"
  );
  const completedSnapshotAfterNewerActive = ingestionJobFromServerItem({
    session_id: responseRaceOwner.sessionId!,
    image_id: responseRaceOwner.imageId!,
    queue: "import",
    status: "completed",
    version: 6,
    progress_seq: 0,
    last_semantic_revision: 6,
    accepted_at: 1,
    accepted_order: 1,
    completed_at: 2,
    completed_item: adminImageListItem({ id: responseRaceOwner.imageId! })
  }, progressedResponseOwner);
  assert.equal(completedSnapshotAfterNewerActive.status, "done");
  assert.equal(completedSnapshotAfterNewerActive.serverVersion, 7);
  assert.equal(completedSnapshotAfterNewerActive.serverProgressSeq, 4);
  const eventBeforeResponse = reduceIngestionQueue({
    jobs: [responseRaceOwner],
    page: 1
  }, {
    type: "patch",
    id: responseRaceOwner.id,
    patch: completedPatchFor(responseRaceOwner, 6)
  });
  assert.equal(reduceIngestionQueue(eventBeforeResponse, {
    type: "patch",
    id: responseRaceOwner.id,
    patch: finalizedResponsePatch
  }), eventBeforeResponse, "迟到的提交 HTTP 状态不得把 completed 卡片回退为 finalized");

  const displayOldIncarnation = fullyAcceptedBatch[0]!;
  const replacementIncarnation = ingestionJob({
    ...displayOldIncarnation,
    id: displayOldIncarnation.id,
    imageId: "019f8457-063a-7200-a580-7a432dc7fd8e",
    batchPosition: undefined,
    browserDisplayReleased: true
  });
  const staleReplaced = reduceIngestionQueue({
    jobs: [displayOldIncarnation, sourceOrderedBatch[1]!],
    page: 1
  }, {
    type: "replace-server-page",
    jobs: [replacementIncarnation],
    stalePairKeys: new Set([
      `${displayOldIncarnation.sessionId}\0${displayOldIncarnation.imageId!.toLowerCase()}`
    ])
  });
  assert.equal(staleReplaced.jobs.length, 2);
  assert.equal(staleReplaced.jobs[0]?.id, sourceOrderedBatch[1]!.id);
  assert.equal(staleReplaced.jobs[1]?.imageId, replacementIncarnation.imageId);
  assert.equal(staleReplaced.jobs[1]?.batchPosition, undefined);

  const fullPageAcceptedPositions = new Set([0, 3, 19, 21, 25, 39]);
  const fullPageBatch = Array.from({ length: 40 }, (_, position) => ingestionJob({
    id: `full-page-${position}`,
    attemptKey: `full-page-attempt-${position}`,
    batchKey: handoffBatchKey,
    batchPosition: position,
    sessionId: fullPageAcceptedPositions.has(position)
      ? `full-page-session-${position}`
      : undefined,
    imageId: fullPageAcceptedPositions.has(position)
      ? `full-page-image-${position}`
      : undefined,
    serverAccepted: fullPageAcceptedPositions.has(position),
    status: fullPageAcceptedPositions.has(position) ? "received" : "uploading"
  }));
  const firstFullPagePlan = combinedIngestionQueuePagePlan(
    fullPageBatch,
    1,
    20,
    100
  );
  assert.equal(firstFullPagePlan.serverOffset, 0);
  assert.equal(
    firstFullPagePlan.serverLimit,
    20,
    "浏览器前缀占满整页时仍应保留一页 Server 替补，避免 handoff 重读"
  );
  assert.deepEqual(firstFullPagePlan.includedServerItems, [
    {
      session_id: "full-page-session-0",
      image_id: "full-page-image-0"
    },
    {
      session_id: "full-page-session-3",
      image_id: "full-page-image-3"
    },
    {
      session_id: "full-page-session-19",
      image_id: "full-page-image-19"
    }
  ]);
  const secondFullPagePlan = combinedIngestionQueuePagePlan(
    fullPageBatch,
    2,
    20,
    100
  );
  assert.equal(
    secondFullPagePlan.serverOffset,
    0,
    "跨页展示前缀仍从排除当前文档后的 Server 候选首页开始"
  );
  assert.equal(secondFullPagePlan.serverLimit, 20);
  assert.equal(secondFullPagePlan.includedServerItems.length, 3);

  const partialSecondPagePlan = combinedIngestionQueuePagePlan(
    fullPageBatch.slice(0, 25),
    2,
    20,
    100
  );
  assert.equal(partialSecondPagePlan.serverOffset, 0);
  assert.equal(
    partialSecondPagePlan.serverLimit,
    20,
    "末页读取须同时覆盖已接管卡片与一页稳定 Server 替补"
  );
  assert.equal(partialSecondPagePlan.serverDisplayLimit, 15);
  assert.equal(partialSecondPagePlan.includedServerItems.length, 1);

  const takeoverJobs = Array.from({ length: 30 }, (_, index) => ingestionJob({
    id: `takeover-${index}`,
    sessionId: `session-${index}`,
    imageId: `image-${index}`,
    serverAccepted: true,
    status: "received"
  }));
  assert.deepEqual(
    serverIngestionJobsForCombinedPage(takeoverJobs, [], 0),
    [],
    "本地前缀填满页面时，逐项 takeover 不得把 Server 占位追加到当前页"
  );
  assert.deepEqual(
    serverIngestionJobsForCombinedPage(
      takeoverJobs,
      [],
      1,
      new Set(["session-0\0image-0"])
    ).map((job) => job.id),
    ["takeover-0"],
    "响应先于 snapshot 时须在现有 Server 槽位保留原占位卡"
  );
  assert.deepEqual(
    serverIngestionJobsForCombinedPage(takeoverJobs, [
      { session_id: "session-8", image_id: "image-8" },
      { session_id: "session-3", image_id: "image-3" }
    ], 1).map((job) => job.id),
    ["takeover-8"],
    "canonical 接管后的展示顺序必须服从当前有界快照"
  );
});
test("[Web/内容接入] 逐项 active 事件在 bounded snapshot 前保留来源无关 handoff 汇总", () => {
  const sourceCases = [
    { queue: "upload", sourceType: "upload" },
    { queue: "import", sourceType: "url" },
    { queue: "import", sourceType: "jsonl" },
    { queue: "import", sourceType: "weibo" }
  ] as const;
  const provisionalOwners = Array.from({ length: 25 }, (_, index) => {
    const source = sourceCases[index % sourceCases.length]!;
    return ingestionJob({
      id: `provisional-owner-${index}`,
      attemptKey: `provisional-attempt-${index}`,
      batchKey: "provisional-batch",
      batchPosition: index,
      kind: source.queue,
      sessionId: String(index).padStart(43, "P"),
      imageId: `019f8457-063a-7${index.toString(16).padStart(3, "0")}`
        + "-a580-7a432dc7fd8e",
      status: "queued",
      serverAccepted: true,
      serverVersion: 1,
      serverProgressSeq: 0,
      serverSemanticRevision: 25,
      serverHandoffPending: true,
      serverHandoffRevision: 25,
      serverHandoffDisplayPage: 1,
      serverHandoffProvisionalTotal: true,
      serverAcceptedOrder: index + 1
    });
  });
  const activeEventFor = (job: IngestionJob, index: number) => {
    const source = sourceCases[index % sourceCases.length]!;
    return {
      session_id: job.sessionId!,
      image_id: job.imageId!,
      queue: source.queue,
      source_type: source.sourceType,
      resolved_image_time: "2026-09-04T00:00:00.000Z",
      status: "preparing" as const,
      phase: "normalizing",
      message: "校验格式、压缩原图并生成缩略图",
      progress: undefined,
      version: 2,
      progress_seq: 0,
      last_semantic_revision: 25,
      accepted_at: 1,
      accepted_order: index + 1,
      metadata: job.draft,
      storage_slug: "local"
    };
  };
  const projectedOwners = provisionalOwners.map((job, index) => (
    index < 18
      ? ingestionJobFromServerItem(activeEventFor(job, index), job)
      : job
  ));
  const retainedProvisionalOwners = projectedOwners.filter((job) => (
    job.serverHandoffPending === true
    && job.serverHandoffProvisionalTotal === true
  ));
  assert.equal(
    retainedProvisionalOwners.length,
    25,
    "bounded snapshot 接管汇总前，任意来源的逐项事件不得逐张撤掉临时总数"
  );
  assert.ok(projectedOwners.every((job) => (
    job.serverHandoffDisplayPage === 1
  )), "逐项事件也不得撤掉尚未被 snapshot 覆盖的展示页租约");
  assert.deepEqual(summarizeIngestionJobs(retainedProvisionalOwners), {
    readyCount: 0,
    unfinishedCount: 25,
    duplicateJobs: 0,
    waitingJobs: 7,
    runningJobs: 18,
    commitQueuedJobs: 0,
    committingJobs: 0,
    finalizedJobs: 0,
    doneJobs: 0,
    failedJobs: 0
  }, "处理阶段只应在等待与处理中之间逐项迁移，总数必须保持 25");
  assert.deepEqual(
    combinedIngestionQueuePagePlan(
      projectedOwners,
      1,
      20,
      100
    ).visibleDisplayPrefixJobs.map((job) => job.batchPosition),
    Array.from({ length: 20 }, (_, index) => index),
    "pageSize=20 时首个 bounded page 的当前文档顺序必须保持稳定"
  );

  const snapshotCoveredOwner = ingestionJobFromServerItem(
    activeEventFor(projectedOwners[0]!, 0),
    projectedOwners[0],
    25
  );
  assert.equal(snapshotCoveredOwner.serverHandoffPending, false);
  assert.equal(snapshotCoveredOwner.serverHandoffDisplayPage, undefined);
  assert.equal(snapshotCoveredOwner.serverHandoffProvisionalTotal, undefined);
});
test("[Web/内容接入] completed status 与 SSE revision 交叉时立即补查且不轮询", () => {
  assert.deepEqual(ingestionHandoffRetryDecision(100, 100, 100), {
    retryAfterRevision: 100,
    retryImmediately: false
  });
  assert.deepEqual(ingestionHandoffRetryDecision(100, 101, 100), {
    retryAfterRevision: 100,
    retryImmediately: true
  });
  assert.deepEqual(ingestionHandoffRetryDecision(100, 101, 101), {
    retryAfterRevision: 101,
    retryImmediately: false
  });
});
test("[Web/内容接入] Server 内容接入队列 Hook 在重连与任意分页时只保留一个 SSE 和当前页基线", async (t) => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=strict-root></div>"
      + "<div id=empty-root></div><div id=root></div>"
      + "<div id=owner-root></div></body></html>"
  );
  const clock = installControlledClock(t, window as unknown as Window, {
    minimumControlledDelayMs: 100,
    includeGlobalTimers: true,
    includeDateNow: false
  });
  const React = await import("react");
  const revokedObjectUrls: string[] = [];
  const NativeURL = globalThis.URL;
  class TrackingURL extends NativeURL {
    static override revokeObjectURL(url: string) {
      revokedObjectUrls.push(url);
    }
  }
  class ControlledEventSource {
    static all: ControlledEventSource[] = [];
    static active = new Set<ControlledEventSource>();
    readonly url: string;
    readonly listeners = new Map<
      string,
      Set<EventListenerOrEventListenerObject>
    >();
    closed = false;

    constructor(url: string) {
      this.url = url;
      ControlledEventSource.all.push(this);
      ControlledEventSource.active.add(this);
    }

    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject
    ) {
      const listeners = this.listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject
    ) {
      this.listeners.get(type)?.delete(listener);
    }

    emit(type: string, payload: unknown) {
      const event = {
        type,
        data: JSON.stringify(payload)
      } as unknown as Event;
      for (const listener of this.listeners.get(type) ?? []) {
        if (typeof listener === "function") {
          listener.call(this, event);
        } else {
          listener.handleEvent(event);
        }
      }
    }

    close() {
      this.closed = true;
      ControlledEventSource.active.delete(this);
    }
  }
  type PendingSnapshot = {
    url: string;
    init: RequestInit;
    aborted: boolean;
    resolved: boolean;
    resolve: (response: Response) => void;
  };
  const requests: PendingSnapshot[] = [];
  const fetchStub = (input: RequestInfo | URL, init: RequestInit = {}) => (
    new Promise<Response>((resolve, reject) => {
      let settled = false;
      const request: PendingSnapshot = {
        url: String(input),
        init,
        aborted: false,
        resolved: false,
        resolve(response) {
          if (settled) return;
          settled = true;
          request.resolved = true;
          resolve(response);
        }
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        request.aborted = true;
        reject(new Error("snapshot aborted"));
      };
      if (init.signal?.aborted) abort();
      else init.signal?.addEventListener("abort", abort, { once: true });
      requests.push(request);
    })
  );
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    fetch: fetchStub,
    EventSource: ControlledEventSource,
    URL: TrackingURL,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { useServerIngestionQueue } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useServerIngestionQueue.ts"
    );
    const { useIngestionQueue } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueue.ts"
    );
    const sessionId = "S".repeat(43);
    const imageId = "019f8457-063a-7009-a580-7a432dc7fd8e";
    const summary = {
      total: 60,
      unfinished: 59,
      waiting: 1,
      running: 0,
      ready: 0,
      duplicate_pending: 0,
      committing: 2,
      resolving: 3,
      completed: 1,
      failed: 0
    };
    const serverItem = (
      status: "queued" | "preparing" | "ready",
      version: number,
      acceptedOrder: number,
      itemImageId = imageId
    ) => ({
      session_id: sessionId,
      image_id: itemImageId,
      queue: "upload" as const,
      source_type: "upload" as const,
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status,
      phase: status,
      message: status,
      ...(status === "preparing" ? { progress: 55 } : {}),
      version,
      progress_seq: 0,
      last_semantic_revision: version + 6,
      accepted_at: 1,
      accepted_order: acceptedOrder,
      metadata: ingestionJob().draft,
      storage_slug: "local"
    });
    let refreshProbe: (() => void) | undefined;
    let recoverAuthorityProbe: (() => Promise<void>) | undefined;
    let recoverAfterSuccessfulActionProbe: (() => Promise<void>) | undefined;
    let ensureRevisionProbe: ((
      revision?: number,
      connectionGeneration?: number
    ) => void) | undefined;
    const probeCompletedObservations: string[] = [];
    const probeServerItemObservations: Array<{
      imageId: string;
      status: string;
      version: number;
    }> = [];
    function Probe(props: Readonly<{
      enabled: boolean;
      displayed?: boolean;
      offset: number;
      limit?: number;
      selectionPair?: { session_id: string; image_id: string };
    }>) {
      const selection = props.selectionPair ? [props.selectionPair] : [];
      const view = useServerIngestionQueue({
        enabled: props.enabled,
        displayed: props.displayed ?? true,
        queue: "upload",
        offset: props.offset,
        limit: props.limit ?? 20,
        requiredItems: props.limit ?? 20,
        excludeItems: selection,
        includeItems: selection,
        onCompletedIngestions: (entries) => {
          probeCompletedObservations.push(...entries.map(
            ({ pair }) => pair.image_id
          ));
        },
        onServerIngestionItem: (item) => {
          probeServerItemObservations.push({
            imageId: item.image_id,
            status: item.status,
            version: item.version
          });
        }
      });
      refreshProbe = view.refresh;
      recoverAuthorityProbe = view.recoverAuthority;
      recoverAfterSuccessfulActionProbe = view.recoverAfterSuccessfulAction;
      ensureRevisionProbe = view.ensureRevision;
      return React.createElement("output", null, JSON.stringify({
        status: view.status,
        generation: view.connectionGeneration,
        actionScope: view.actionScope,
        revision: view.revision,
        total: view.summary?.total ?? null,
        items: view.items.map((item) => ({
          id: item.image_id,
          status: item.status,
          version: item.version
        })),
        watermark: view.actionWatermark,
        error: view.error
      }));
    }
    let setOwnerPage: ((page: number) => void) | undefined;
    let refreshOwner: (() => void) | undefined;
    let recoverOwnerAfterSuccessfulAction: ((
      result: IngestionQueueActionResultDto
    ) => Promise<void>) | undefined;
    let projectOwnerCompletedCleanupBatch: ((
      result: IngestionQueueActionResultDto
    ) => number) | undefined;
    let markOwnerCompletedBrowserOwned: ((imageId: string) => void) | undefined;
    let bindOwnerHandoff: ((revision: number) => void) | undefined;
    let prepareUnknownCompletedHandoff: (() => void) | undefined;
    let bindUnknownCompletedHandoff: (() => void) | undefined;
    let bindCoveredCompletedHandoff: (() => void) | undefined;
    let bindCrossGenerationCompletedCoverage: (() => void) | undefined;
    let bindCrossGenerationPresent: (() => void) | undefined;
    let bindCrossGenerationAccepted: (() => void) | undefined;
    let releaseCrossGenerationHydrated: (() => void) | undefined;
    let bindReleaseRaceHandoff: (() => void) | undefined;
    let releaseRaceHandoff: (() => void) | undefined;
    let releaseMountedFinalized: (() => void) | undefined;
    let bindIncarnationReplacement: (() => void) | undefined;
    let releaseIncarnationReplacement: (() => void) | undefined;
    let bindReconnectAcceptedOwners: (() => void) | undefined;
    let bindLoadingAcceptedOwner: ((requestGeneration: number) => void)
      | undefined;
    let prepareVisibleReadyRelease: (() => void) | undefined;
    let releaseVisibleReady: ((
      imageId?: string,
      release?: Readonly<{
        revision: number;
        summary: IngestionQueueSummaryDto;
      }>
    ) => void) | undefined;
    let visibleReadyReleaseBeforeIds: string[] = [];
    let visibleReadyReleaseAfterIds: string[] = [];
    let observeOwnerCompleted: ((
      pair: { session_id: string; image_id: string },
      item: ReturnType<typeof adminImageListItem>
    ) => void) | undefined;
    let prepareOffPageCompletionBatch: (() => void) | undefined;
    let releaseRaceReleased = false;
    const handoffSessionId = "H".repeat(43);
    const handoffImageId = "019f8457-063a-7011-a580-7a432dc7fd8e";
    const unknownSessionId = "U".repeat(43);
    const unknownImageId = "019f8457-063a-7013-a580-7a432dc7fd8e";
    const unknownPlaceholderId = "owner-unknown-completed-placeholder-0";
    const coveredSessionId = "V".repeat(43);
    const coveredImageId = "019f8457-063a-7014-a580-7a432dc7fd8e";
    const crossGenerationCompletedSessionId = "Q".repeat(43);
    const crossGenerationCompletedImageId =
      "019f8457-063a-7019-a580-7a432dc7fd8e";
    const crossGenerationPresentSessionId = "P".repeat(43);
    const crossGenerationPresentImageId =
      "019f8457-063a-7018-a580-7a432dc7fd8e";
    const crossGenerationSessionId = "W".repeat(43);
    const crossGenerationImageId = "019f8457-063a-7015-a580-7a432dc7fd8e";
    const releaseRaceSessionId = "X".repeat(43);
    const releaseRaceImageId = "019f8457-063a-7016-a580-7a432dc7fd8e";
    const releaseRacePlaceholderId = "owner-release-race-placeholder";
    const releaseRaceAttemptKey = "owner-release-race-attempt";
    const mountedReleaseSessionId = "Y".repeat(43);
    const mountedReleaseImageId = "019f8457-063a-7017-a580-7a432dc7fd8e";
    const incarnationSessionId = "I".repeat(43);
    const oldIncarnationImageId = "019f8457-063a-7028-a580-7a432dc7fd8e";
    const nextIncarnationImageId = "019f8457-063a-7029-a580-7a432dc7fd8e";
    const nextIncarnationPlaceholderId = "owner-next-incarnation-placeholder";
    const nextIncarnationAttemptKey = "owner-next-incarnation-attempt";
    const reconnectVisibleSessionId = "J".repeat(43);
    const reconnectVisibleImageId = "019f8457-063a-7038-a580-7a432dc7fd8e";
    const reconnectOffPageSessionId = "K".repeat(43);
    const reconnectOffPageImageId = "019f8457-063a-7039-a580-7a432dc7fd8e";
    const loadingAcceptedSessionId = "L".repeat(43);
    const visibleReadyReleaseImageIds = [
      "019f8457-063a-703f-a580-7a432dc7fd8e",
      "019f8457-063a-7040-a580-7a432dc7fd8e",
      "019f8457-063a-7041-a580-7a432dc7fd8e",
      "019f8457-063a-7042-a580-7a432dc7fd8e",
      "019f8457-063a-7043-a580-7a432dc7fd8e",
      "019f8457-063a-7044-a580-7a432dc7fd8e",
      "019f8457-063a-7045-a580-7a432dc7fd8e"
    ] as const;
    const loadingAcceptedImageId = visibleReadyReleaseImageIds[0];
    const visibleReadyReleaseTargetImageId = visibleReadyReleaseImageIds[4];
    const visibleReadyReleaseSessionIds = visibleReadyReleaseImageIds.map(
      (_imageId, index) => index === 0
        ? loadingAcceptedSessionId
        : String(index).repeat(43)
    );
    const readyReleaseSummary: IngestionQueueSummaryDto = {
      total: 1,
      unfinished: 1,
      waiting: 0,
      running: 0,
      ready: 1,
      duplicate_pending: 0,
      committing: 0,
      resolving: 0,
      completed: 0,
      failed: 0
    };
    const offPageCompletionSessionIds = Array.from(
      { length: 23 },
      (_, index) => String(index).padStart(43, "C")
    );
    const offPageCompletionImageIds = Array.from(
      { length: 23 },
      (_, index) => (
        `019f8457-063a-7${index.toString(16).padStart(3, "0")}`
          + "-b580-7a432dc7fd8e"
      )
    );
    const compactChunkFailureSessionIds = Array.from(
      { length: 102 },
      (_, index) => index.toString(36).padStart(43, "Z")
    );
    const compactChunkFailureImageIds = Array.from(
      { length: 102 },
      (_, index) => (
        `019f8457-063a-7${index.toString(16).padStart(3, "0")}`
          + "-c580-7a432dc7fd8e"
      )
    );
    function OwnerProbe(props: Readonly<{ displayed: boolean }>) {
      const queue = useIngestionQueue(20, "upload", props.displayed);
      refreshOwner = queue.server.refresh;
      recoverOwnerAfterSuccessfulAction = queue.recoverAfterSuccessfulAction;
      projectOwnerCompletedCleanupBatch = queue.projectCompletedCleanupBatch;
      markOwnerCompletedBrowserOwned = (imageId) => {
        const job = queue.jobsRef.current.find((item) => (
          item.imageId === imageId
        ));
        assert.ok(job);
        queue.updateJob(job.id, {
          serverAccepted: false,
          batchKey: "owner-completed-browser-batch",
          batchPosition: 0,
          browserDisplayReleased: false
        });
      };
      observeOwnerCompleted = (pair, item) => {
        queue.observeCompletedIngestions([{ pair, item }]);
      };
      prepareOffPageCompletionBatch = () => {
        queue.appendJobs(offPageCompletionImageIds.map((imageId, index) => (
          ingestionJob({
            id: `owner-off-page-completion-${index}`,
            attemptKey: `owner-off-page-completion-attempt-${index}`,
            batchKey: "owner-off-page-completion-batch",
            batchPosition: index,
            kind: "upload",
            sessionId: offPageCompletionSessionIds[index],
            imageId,
            serverAccepted: true,
            serverAcceptedOrder: 20 + index,
            serverVersion: 5,
            serverProgressSeq: 0,
            serverSemanticRevision: 8,
            serverStatus: "committing",
            serverPhase: "committing",
            status: "committing",
            ...(index === 22 ? {
              preview: "blob:off-page-completion-preview",
              objectUrl: "blob:off-page-completion-preview"
            } : {})
          })
        )));
      };
      setOwnerPage = (page) => queue.setPage(page);
      bindOwnerHandoff = (revision) => {
        const placeholder = ingestionJob({
          id: "owner-handoff-placeholder",
          attemptKey: "owner-handoff-attempt",
          batchKey: "owner-handoff-batch",
          kind: "upload",
          status: "received",
          sessionId: undefined,
          imageId: undefined,
          serverAccepted: false
        });
        queue.appendJobs([placeholder]);
        queue.bindServerJob(placeholder.id, {
          sessionId: handoffSessionId,
          imageId: handoffImageId,
          serverAccepted: true,
          serverVersion: 2,
          serverSemanticRevision: revision,
          serverHandoffPending: true,
          serverHandoffRevision: revision,
          status: "received",
          message: "服务器已接管上传任务"
        }, queue.server.connectionGeneration, 61);
      };
      prepareUnknownCompletedHandoff = () => {
        queue.appendJobs(Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: `owner-unknown-completed-placeholder-${index}`,
          attemptKey: `owner-unknown-completed-attempt-${index}`,
          batchKey: "owner-unknown-completed-batch",
          kind: "upload",
          status: "received",
          sessionId: undefined,
          imageId: undefined,
          serverAccepted: false
        })));
      };
      bindUnknownCompletedHandoff = () => {
        const placeholder = queue.jobsRef.current.find(
          (job) => job.id === unknownPlaceholderId
        );
        assert.ok(placeholder);
        queue.bindServerJob(placeholder.id, {
          sessionId: unknownSessionId,
          imageId: unknownImageId,
          serverAccepted: true,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, queue.server.connectionGeneration, 62);
      };
      bindCoveredCompletedHandoff = () => {
        const placeholder = ingestionJob({
          id: "owner-covered-completed-placeholder",
          attemptKey: "owner-covered-completed-attempt",
          batchKey: "owner-covered-completed-batch",
          kind: "upload",
          status: "received"
        });
        queue.appendJobs([placeholder]);
        queue.setPage(3);
        queue.bindServerJob(placeholder.id, {
          sessionId: coveredSessionId,
          imageId: coveredImageId,
          serverAccepted: true,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, queue.server.connectionGeneration, 1);
      };
      bindCrossGenerationCompletedCoverage = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: index === 40
            ? "owner-cross-generation-completed-placeholder"
            : `owner-cross-generation-completed-fill-${index}`,
          attemptKey: index === 40
            ? "owner-cross-generation-completed-attempt"
            : `owner-cross-generation-completed-fill-attempt-${index}`,
          batchKey: "owner-cross-generation-completed-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.setPage(3);
        queue.bindServerJob("owner-cross-generation-completed-placeholder", {
          sessionId: crossGenerationCompletedSessionId,
          imageId: crossGenerationCompletedImageId,
          serverAccepted: true,
          serverVersion: 2,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, null, 4);
      };
      bindCrossGenerationPresent = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: index === 40
            ? "owner-cross-generation-present-placeholder"
            : `owner-cross-generation-present-fill-${index}`,
          attemptKey: index === 40
            ? "owner-cross-generation-present-attempt"
            : `owner-cross-generation-present-fill-attempt-${index}`,
          batchKey: "owner-cross-generation-present-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.setPage(3);
        queue.bindServerJob("owner-cross-generation-present-placeholder", {
          sessionId: crossGenerationPresentSessionId,
          imageId: crossGenerationPresentImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 1,
          serverHandoffPending: true,
          serverHandoffRevision: 1,
          status: "received",
          message: "服务器已接管上传任务"
        }, null, 5);
      };
      bindCrossGenerationAccepted = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: index === 40
            ? "owner-cross-generation-placeholder"
            : `owner-cross-generation-fill-${index}`,
          attemptKey: index === 40
            ? "owner-cross-generation-attempt"
            : `owner-cross-generation-fill-attempt-${index}`,
          batchKey: "owner-cross-generation-batch",
          kind: "upload",
          status: "received",
          ...(index === 40 ? {
            preview: "blob:cross-generation-visible",
            objectUrl: "blob:cross-generation-visible"
          } : {})
        }));
        queue.appendJobs(placeholders);
        queue.setPage(3);
        queue.bindServerJob("owner-cross-generation-placeholder", {
          sessionId: crossGenerationSessionId,
          imageId: crossGenerationImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 1,
          serverHandoffPending: true,
          serverHandoffRevision: 1,
          status: "received",
          message: "服务器已接管上传任务"
        }, null, 2);
      };
      releaseCrossGenerationHydrated = () => {
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: "owner-cross-generation-placeholder",
          attemptKey: "owner-cross-generation-attempt",
          pair: {
            session_id: crossGenerationSessionId,
            image_id: crossGenerationImageId
          }
        }]).has("owner-cross-generation-placeholder");
      };
      bindReleaseRaceHandoff = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 21 }, (_, index) => ingestionJob({
          id: index === 20
            ? releaseRacePlaceholderId
            : `owner-release-race-fill-${index}`,
          attemptKey: index === 20
            ? releaseRaceAttemptKey
            : `owner-release-race-fill-attempt-${index}`,
          batchKey: "owner-release-race-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.bindServerJob(releaseRacePlaceholderId, {
          sessionId: releaseRaceSessionId,
          imageId: releaseRaceImageId,
          serverAccepted: true,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, queue.server.connectionGeneration, 3);
      };
      releaseRaceHandoff = () => {
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: releaseRacePlaceholderId,
          attemptKey: releaseRaceAttemptKey,
          pair: {
            session_id: releaseRaceSessionId,
            image_id: releaseRaceImageId
          }
        }]).has(releaseRacePlaceholderId);
      };
      releaseMountedFinalized = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholder = ingestionJob({
          id: "owner-mounted-release-placeholder",
          attemptKey: "owner-mounted-release-attempt",
          batchKey: "owner-mounted-release-batch",
          kind: "upload",
          status: "received"
        });
        queue.appendJobs([placeholder]);
        queue.bindServerJob(placeholder.id, {
          sessionId: mountedReleaseSessionId,
          imageId: mountedReleaseImageId,
          serverAccepted: true,
          serverHandoffPending: true,
          serverHandoffRevision: undefined,
          status: "finalized",
          resultState: "recovering",
          message: "图片已写入图库，正在读取结果"
        }, queue.server.connectionGeneration, 4);
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: placeholder.id,
          attemptKey: placeholder.attemptKey,
          pair: {
            session_id: mountedReleaseSessionId,
            image_id: mountedReleaseImageId
          }
        }]).has(placeholder.id);
      };
      bindIncarnationReplacement = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const oldPlaceholder = ingestionJob({
          id: "owner-old-incarnation-placeholder",
          attemptKey: "owner-old-incarnation-attempt",
          batchKey: "owner-incarnation-batch",
          kind: "upload",
          status: "received",
          preview: "blob:old-incarnation-owner",
          objectUrl: "blob:old-incarnation-owner",
          serverDraftPending: true
        });
        const nextPlaceholder = ingestionJob({
          id: nextIncarnationPlaceholderId,
          attemptKey: nextIncarnationAttemptKey,
          batchKey: "owner-incarnation-batch",
          kind: "upload",
          status: "received"
        });
        queue.appendJobs([oldPlaceholder, nextPlaceholder]);
        queue.bindServerJob(oldPlaceholder.id, {
          sessionId: incarnationSessionId,
          imageId: oldIncarnationImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 111,
          serverHandoffPending: true,
          serverHandoffRevision: 111,
          status: "received",
          message: "服务器已接管旧 incarnation"
        }, queue.server.connectionGeneration, 6);
        queue.bindServerJob(nextPlaceholder.id, {
          sessionId: incarnationSessionId,
          imageId: nextIncarnationImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 112,
          serverHandoffPending: true,
          serverHandoffRevision: 112,
          status: "received",
          message: "服务器已接管新 incarnation"
        }, queue.server.connectionGeneration, 7);
      };
      releaseIncarnationReplacement = () => {
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: nextIncarnationPlaceholderId,
          attemptKey: nextIncarnationAttemptKey,
          pair: {
            session_id: incarnationSessionId,
            image_id: nextIncarnationImageId
          }
        }]).has(nextIncarnationPlaceholderId);
      };
      bindReconnectAcceptedOwners = () => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 21 }, (_, index) => ingestionJob({
          id: index === 0
            ? "owner-reconnect-visible-placeholder"
            : index === 20
              ? "owner-reconnect-off-page-placeholder"
              : `owner-reconnect-fill-${index}`,
          attemptKey: index === 0
            ? "owner-reconnect-visible-attempt"
            : index === 20
              ? "owner-reconnect-off-page-attempt"
              : `owner-reconnect-fill-attempt-${index}`,
          batchKey: "owner-reconnect-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.setPage(1);
        queue.bindServerJob("owner-reconnect-off-page-placeholder", {
          sessionId: reconnectOffPageSessionId,
          imageId: reconnectOffPageImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 113,
          serverHandoffPending: true,
          serverHandoffRevision: 113,
          status: "received",
          message: "服务器已接管离页任务"
        }, queue.server.connectionGeneration, 8);
        queue.bindServerJob("owner-reconnect-visible-placeholder", {
          sessionId: reconnectVisibleSessionId,
          imageId: reconnectVisibleImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 114,
          serverHandoffPending: true,
          serverHandoffRevision: 114,
          status: "received",
          message: "服务器已接管可见任务"
        }, queue.server.connectionGeneration, 9);
      };
      bindLoadingAcceptedOwner = (requestGeneration) => {
        queue.clearJobIds(new Set(queue.localJobs.map((job) => job.id)));
        const placeholders = Array.from({ length: 61 }, (_, index) => ingestionJob({
          id: index === 40
            ? "owner-loading-accepted-placeholder"
            : `owner-loading-accepted-fill-${index}`,
          attemptKey: index === 40
            ? "owner-loading-accepted-attempt"
            : `owner-loading-accepted-fill-attempt-${index}`,
          batchKey: "owner-loading-accepted-batch",
          kind: "upload",
          status: "received"
        }));
        queue.appendJobs(placeholders);
        queue.setPage(3);
        queue.bindServerJob("owner-loading-accepted-placeholder", {
          sessionId: loadingAcceptedSessionId,
          imageId: loadingAcceptedImageId,
          serverAccepted: true,
          serverVersion: 1,
          serverSemanticRevision: 115,
          serverHandoffPending: true,
          serverHandoffRevision: 115,
          status: "received",
          message: "服务器在新连接加载期间接管任务"
        }, requestGeneration, 10);
      };
      prepareVisibleReadyRelease = () => {
        queue.clearJobIds(new Set(queue.jobsRef.current.map((job) => job.id)));
        const placeholders = visibleReadyReleaseImageIds.map((_imageId, index) => (
          ingestionJob({
            id: `owner-visible-ready-release-placeholder-${index}`,
            attemptKey: `owner-visible-ready-release-attempt-${index}`,
            batchKey: "owner-visible-ready-release-batch",
            kind: "upload",
            status: "received"
          })
        ));
        queue.appendJobs(placeholders);
        visibleReadyReleaseImageIds.forEach((imageId, index) => {
          const placeholder = placeholders[index];
          queue.bindServerJob(placeholder.id, {
            sessionId: visibleReadyReleaseSessionIds[index],
            imageId,
            serverAccepted: true,
            serverVersion: 2,
            serverSemanticRevision: 2,
            serverHandoffPending: false,
            status: "ready",
            message: "等待提交"
          }, queue.server.connectionGeneration, 10 + index);
        });
        visibleReadyReleaseBeforeIds = queue.jobsRef.current.flatMap((job) => (
          job.imageId && visibleReadyReleaseImageIds.includes(job.imageId as (
            typeof visibleReadyReleaseImageIds
          )[number])
            ? [job.imageId]
            : []
        ));
      };
      releaseVisibleReady = (
        imageId = visibleReadyReleaseTargetImageId,
        release
      ) => {
        const visibleIndex = visibleReadyReleaseImageIds.indexOf(imageId as (
          typeof visibleReadyReleaseImageIds
        )[number]);
        assert.notEqual(visibleIndex, -1);
        const current = queue.jobsRef.current.find((job) => (
          job.imageId === imageId
        ));
        const targetId = current?.id
          ?? `owner-visible-ready-release-placeholder-${visibleIndex}`;
        const targetAttemptKey = current?.attemptKey
          ?? `owner-visible-ready-release-attempt-${visibleIndex}`;
        const targetSessionId = current?.sessionId
          ?? visibleReadyReleaseSessionIds[visibleIndex]!;
        if (current) {
          queue.updateJob(current.id, {
            status: "cancelled",
            message: "已取消"
          });
        }
        releaseRaceReleased = queue.releaseResolvedServerJobs([{
          id: targetId,
          attemptKey: targetAttemptKey,
          pair: {
            session_id: targetSessionId,
            image_id: imageId
          },
          ...(release ? {
            releasedRevision: release.revision,
            releasedSummary: release.summary
          } : {})
        }]).has(targetId);
        visibleReadyReleaseAfterIds = queue.jobsRef.current.flatMap((job) => (
          job.imageId && visibleReadyReleaseImageIds.includes(job.imageId as (
            typeof visibleReadyReleaseImageIds
          )[number])
            ? [job.imageId]
            : []
        ));
      };
      return React.createElement("output", null, JSON.stringify({
        status: queue.server.status,
        generation: queue.server.connectionGeneration,
        revision: queue.server.revision,
        page: queue.page,
        total: queue.totalItems,
        totalPages: queue.totalPages,
        waiting: queue.summary.waitingJobs
          + queue.summary.commitQueuedJobs
          + queue.summary.finalizedJobs,
        ready: queue.summary.readyCount,
        submitting: queue.summary.committingJobs,
        pendingHandoff: queue.pendingAuthorityHandoff,
        pendingDraft: queue.hasPendingDraftUpdates(),
        reconnectDone: queue.jobsRef.current.filter((job) => (
          job.status === "done"
          && (
            job.sessionId === reconnectVisibleSessionId
            || job.sessionId === reconnectOffPageSessionId
          )
        )).length,
        offPageCompletionOwners: queue.jobsRef.current.filter((job) => (
          job.imageId && offPageCompletionImageIds.includes(job.imageId)
        )).length,
        offPageCompletionDone: queue.jobsRef.current.filter((job) => (
          job.status === "done"
          && job.imageId
          && offPageCompletionImageIds.includes(job.imageId)
        )).length,
        compactChunkHydrated: queue.jobsRef.current.filter((job) => (
          job.resultState === "hydrated"
          && job.imageId
          && compactChunkFailureImageIds.includes(job.imageId)
        )).length,
        jobCount: queue.jobsRef.current.length,
        serverNotice: queue.serverNotice,
        visible: queue.visibleJobs.map((job) => ({
          id: job.imageId,
          status: job.status
        }))
      }));
    }
    const container = document.getElementById("root");
    const ownerContainer = document.getElementById("owner-root");
    const strictContainer = document.getElementById("strict-root");
    const emptyContainer = document.getElementById("empty-root");
    assert.ok(container);
    assert.ok(ownerContainer);
    assert.ok(strictContainer);
    assert.ok(emptyContainer);
    const root = createRoot(container);
    const ownerRoot = createRoot(ownerContainer);
    const strictRoot = createRoot(strictContainer);
    const emptyRoot = createRoot(emptyContainer);
    let strictRootUnmounted = false;
    let emptyRootUnmounted = false;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    queryClient.setQueryData(queryKeys.adminImages, { cached: true });
    let adminImageInvalidations = 0;
    const unsubscribeQueryEvents = queryClient.getQueryCache().subscribe(
      (event) => {
        if (
          event.type === "updated"
          && event.action.type === "invalidate"
          && JSON.stringify(event.query.queryKey)
            === JSON.stringify(queryKeys.adminImages)
        ) adminImageInvalidations += 1;
      }
    );
    const withQueryClient = (child: React.ReactNode) => React.createElement(
      QueryClientProvider,
      { client: queryClient },
      child
    );
    const view = () => JSON.parse(container.textContent || "{}") as {
      status: string;
      generation: number;
      actionScope: string;
      revision: number | null;
      total: number | null;
      items: Array<{ id: string; status: string; version: number }>;
      watermark: string;
      error: string;
    };
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail(
        `Server Ingestion queue Hook did not settle: ${container.textContent}; `
        + `pending=${requests.filter((request) => (
          !request.aborted && !request.resolved
        )).map((request) => new URL(
          request.url,
          "https://imageshow.test"
        ).pathname).join(",")}; recent=${requests.slice(-8).map((request) => {
          const url = new URL(request.url, "https://imageshow.test");
          return `${url.pathname}?${url.searchParams.toString()}`
            + `:${request.aborted ? "aborted" : request.resolved ? "resolved" : "pending"}`;
        }).join(",")}`
      );
    };
    const respond = (
      request: PendingSnapshot,
      payload: Record<string, unknown>
    ) => {
      request.resolve(new Response(JSON.stringify({ ok: true, ...payload }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    };
    const pendingRequest = (path: string, from = 0) => (
      [...requests.slice(from)].reverse().find((request) => (
        !request.aborted
        && !request.resolved
        && new URL(request.url, "https://imageshow.test").pathname === path
      ))
    );
    const runQueueScenario = (
      id: string,
      name: string,
      work: () => Promise<void>
    ) => t.test(name, {
      skip: Boolean(selectedQueueScenario && selectedQueueScenario !== id)
    }, work);

    try {
      await runQueueScenario(
        "strict-mode",
        "Strict Mode 重挂只保留一个 SSE 并在卸载时释放",
        async () => {
      try {
        await React.act(async () => {
          strictRoot.render(withQueryClient(React.createElement(
            React.StrictMode,
            null,
            React.createElement(Probe, { enabled: true, offset: 0 })
          )));
          await Promise.resolve();
        });
        await settleUntil(() => ControlledEventSource.active.size === 1);
        assert.equal(
          ControlledEventSource.all.filter((candidate) => !candidate.closed).length,
          1,
          "StrictMode 重挂期间只能保留一个当前 SSE owner"
        );
        assert.equal(
          requests.length,
          0,
          "未收到 ready 的 StrictMode 探针不得提前读取 snapshot"
        );
      } finally {
        await React.act(async () => strictRoot.unmount());
        strictRootUnmounted = true;
      }
      assert.equal(ControlledEventSource.active.size, 0);
      ControlledEventSource.all.length = 0;
      requests.length = 0;
        }
      );

      await runQueueScenario(
        "empty-reconnect",
        "空队列重连重置 generation 且忽略旧 revision",
        async () => {
      const emptyView = () => JSON.parse(emptyContainer.textContent || "{}") as {
        status: string;
        generation: number;
        revision: number | null;
        total: number | null;
      };
      const emptySnapshot = (revision: number, watermark: string) => ({
        queue: "upload",
        revision,
        last_accepted_order: 0,
        offset: 0,
        limit: 20,
        total: 0,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0,
        items: [],
        action_watermark: watermark
      });
      try {
        await React.act(async () => {
          emptyRoot.render(withQueryClient(
            React.createElement(Probe, { enabled: true, offset: 0 })
          ));
          await Promise.resolve();
        });
        await settleUntil(() => ControlledEventSource.all.length === 1);
        const emptySource = ControlledEventSource.all[0]!;
        await React.act(async () => {
          emptySource.emit("ready", {
            type: "ready",
            queue: "upload",
            revision: 100,
            action_scope: "scope-empty-old-generation"
          });
          await Promise.resolve();
        });
        await settleUntil(() => requests.length === 1);
        await React.act(async () => {
          respond(requests[0]!, emptySnapshot(100, "watermark-empty-old"));
          await Promise.resolve();
        });
        await settleUntil(() => (
          emptyView().status === "ready" && emptyView().total === 0
        ));
        assert.equal(requests.length, 1, "稳定空队列首次打开只能读取一次 snapshot");
        assert.equal(ControlledEventSource.active.size, 1);
        const oldGeneration = emptyView().generation;

        await React.act(async () => {
          emptySource.emit("error", {});
          await Promise.resolve();
        });
        assert.equal(ControlledEventSource.all.length, 1);
        assert.equal(ControlledEventSource.active.size, 1);
        const reopenedSource = emptySource;
        await React.act(async () => {
          reopenedSource.emit("ready", {
            type: "ready",
            queue: "upload",
            revision: 1,
            action_scope: "scope-empty-new-generation"
          });
          await Promise.resolve();
        });
        await settleUntil(() => requests.length === 2);
        await React.act(async () => {
          respond(requests[1]!, emptySnapshot(1, "watermark-empty-new"));
          await Promise.resolve();
        });
        await settleUntil(() => (
          emptyView().status === "ready"
          && emptyView().revision === 1
          && emptyView().generation !== oldGeneration
        ));
        assert.equal(requests.length, 2, "稳定空队列重连后也只能读取一次 snapshot");
        await React.act(async () => {
          ensureRevisionProbe?.(100, oldGeneration);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        assert.equal(
          requests.length,
          2,
          "旧连接迟到的高 revision 不得污染 revision 已重置的新连接"
        );
      } finally {
        await React.act(async () => emptyRoot.unmount());
        emptyRootUnmounted = true;
      }
      assert.equal(ControlledEventSource.active.size, 0);
      ControlledEventSource.all.length = 0;
      requests.length = 0;
        }
      );

      await runQueueScenario(
        "reconnect-pagination",
        "重连、任意分页与迟到响应保持单一当前页基线",
        async () => {
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: true, offset: 40 })
        ));
        await Promise.resolve();
      });
      assert.equal(ControlledEventSource.all.length, 1);
      assert.equal(ControlledEventSource.active.size, 1);
      const source = ControlledEventSource.all[0]!;
      assert.match(source.url, /queue=upload/u);

      await React.act(async () => {
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 7,
          action_scope: "scope-one"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === 1);
      const firstUrl = new URL(requests[0]!.url, "https://imageshow.test");
      assert.equal(firstUrl.searchParams.get("offset"), "40");
      assert.equal(firstUrl.searchParams.get("limit"), "20");
      assert.equal(
        new Headers(requests[0]!.init.headers).get(ingestionActionScopeHeader),
        "scope-one"
      );
      assert.deepEqual(view().items, []);
      assert.equal(view().watermark, "");

      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 8,
          last_accepted_order: 60,
          summary,
          session: serverItem("preparing", 2, 20),
          action_watermark: "watermark-eight"
        });
        respond(requests[0]!, {
          queue: "upload",
          revision: 7,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [serverItem("queued", 1, 20)],
          action_watermark: "watermark-seven"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().revision, 8);
      assert.equal(view().total, 60);
      assert.deepEqual(view().items, [{
        id: imageId,
        status: "preparing",
        version: 2
      }]);
      assert.deepEqual(probeServerItemObservations, [{
        imageId,
        status: "preparing",
        version: 2
      }], "SSE active mutation 必须逐项交给浏览器卡片 owner");
      assert.equal(view().watermark, "watermark-eight");
      const coveredRevisionStart = requests.length;
      await React.act(async () => {
        ensureRevisionProbe?.(8);
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        coveredRevisionStart,
        "稳定页已覆盖 handoff revision 时不得刷新"
      );

      const authorityRecoveryStart = requests.length;
      let firstAuthorityRecovery!: Promise<void>;
      let coalescedAuthorityRecovery!: Promise<void>;
      await React.act(async () => {
        firstAuthorityRecovery = recoverAuthorityProbe!();
        coalescedAuthorityRecovery = recoverAuthorityProbe!();
        await Promise.resolve();
      });
      assert.equal(
        firstAuthorityRecovery,
        coalescedAuthorityRecovery,
        "同一 owner 的并发凭证恢复必须共用一个权威 snapshot 链"
      );
      await settleUntil(() => requests.length === authorityRecoveryStart + 1);
      await React.act(async () => {
        requests[authorityRecoveryStart]!.resolve(new Response(
          "snapshot response lost",
          { status: 502 }
        ));
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === authorityRecoveryStart + 2);
      await React.act(async () => {
        respond(requests[authorityRecoveryStart + 1]!, {
          queue: "upload",
          revision: 8,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [serverItem("preparing", 2, 20)],
          action_watermark: "watermark-authority-recovered"
        });
        await Promise.all([
          firstAuthorityRecovery,
          coalescedAuthorityRecovery
        ]);
      });
      assert.equal(view().watermark, "watermark-authority-recovered");
      assert.equal(
        requests.length,
        authorityRecoveryStart + 2,
        "响应丢失只允许重读 snapshot，不得并发创建第二条恢复链"
      );
      requests.splice(authorityRecoveryStart, 2);

      const completedBaselineStart = requests.length;
      const completedServerItem = {
        session_id: sessionId,
        image_id: imageId,
        queue: "upload" as const,
        status: "completed" as const,
        version: 3,
        progress_seq: 0,
        last_semantic_revision: 8,
        accepted_at: 1,
        accepted_order: 20,
        completed_at: 2,
        completed_item: adminImageListItem({ id: imageId })
      };
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === completedBaselineStart + 1);
      await React.act(async () => {
        respond(requests[completedBaselineStart]!, {
          queue: "upload",
          revision: 8,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [completedServerItem],
          action_watermark: "watermark-completed-before-cleanup"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-completed-before-cleanup"
      ));
      assert.equal(view().items[0]?.status, "completed");
      requests.splice(completedBaselineStart, 1);

      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            displayed: false,
            offset: 40
          })
        ));
        await Promise.resolve();
      });
      const cleanupRecoveryStart = requests.length;
      let cleanupRecovery!: Promise<void>;
      let concurrentCleanupRecovery!: Promise<void>;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === cleanupRecoveryStart + 1);
      const preActionSnapshot = requests[cleanupRecoveryStart]!;
      await React.act(async () => {
        cleanupRecovery = recoverAfterSuccessfulActionProbe!();
        concurrentCleanupRecovery = recoverAuthorityProbe!();
        void cleanupRecovery.catch(() => undefined);
        await Promise.resolve();
      });
      assert.equal(
        cleanupRecovery,
        concurrentCleanupRecovery,
        "清理成功后的并发 recoverAuthority 必须复用 owner single-flight"
      );
      assert.equal(
        preActionSnapshot.aborted,
        true,
        "清理成功前启动的 snapshot 不得证明清理结果"
      );
      assert.equal(view().status, "loading");
      assert.deepEqual(
        view().items.map((item) => item.id),
        [completedServerItem.image_id],
        "raw owner 应保留有界基线，由组合 owner 精确投影动作成功项"
      );
      assert.equal(
        view().watermark,
        "watermark-completed-before-cleanup"
      );
      await settleUntil(() => requests.length === cleanupRecoveryStart + 2);
      const lateCompletedSessionId = "T".repeat(43);
      const lateCompletedImageId =
        "019f8457-063a-7092-a580-7a432dc7fd8e";
      const latePreparingItem = {
        ...serverItem("preparing", 2, 20, lateCompletedImageId),
        session_id: lateCompletedSessionId
      };
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 9,
          last_accepted_order: 60,
          summary: { ...summary, unfinished: 58, completed: 2 },
          session: {
            session_id: lateCompletedSessionId,
            image_id: lateCompletedImageId,
            queue: "upload",
            status: "completed",
            version: 3,
            progress_seq: 0,
            last_semantic_revision: 9,
            accepted_at: 1,
            accepted_order: 20,
            completed_at: 2,
            completed_item: adminImageListItem({ id: lateCompletedImageId })
          },
          action_watermark: "watermark-late-completion"
        });
        await Promise.resolve();
      });
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            displayed: true,
            offset: 40
          })
        ));
        await Promise.resolve();
      });
      assert.deepEqual(
        view().items.map((item) => item.id),
        [completedServerItem.image_id],
        "raw owner 快速重开仍保留有界基线，组合 owner 负责隐藏已清理卡片"
      );
      await React.act(async () => {
        respond(requests[cleanupRecoveryStart + 1]!, {
          queue: "upload",
          revision: 8,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [latePreparingItem],
          action_watermark: "watermark-after-completed-cleanup"
        });
        await Promise.all([cleanupRecovery, concurrentCleanupRecovery]);
      });
      assert.equal(
        requests.length,
        cleanupRecoveryStart + 2,
        "快速重开、普通 refresh 与并发恢复只能共用一个 post-action snapshot"
      );
      assert.deepEqual(view().items, [{
        id: lateCompletedImageId,
        status: "completed",
        version: 3
      }], "关闭后才完成的任务必须合并进动作后权威快照");
      assert.equal(view().watermark, "watermark-late-completion");
      assert.deepEqual(probeCompletedObservations, [lateCompletedImageId]);
      probeCompletedObservations.length = 0;
      requests.splice(cleanupRecoveryStart, 2);

      const postCleanupRefreshStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === postCleanupRefreshStart + 1);
      await React.act(async () => {
        respond(requests[postCleanupRefreshStart]!, {
          queue: "upload",
          revision: 9,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [serverItem("preparing", 2, 20)],
          action_watermark: "watermark-post-cleanup-stable"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-post-cleanup-stable"
      ));
      requests.splice(postCleanupRefreshStart, 1);

      const offPageCompletedImageId =
        "019f8457-063a-7093-a580-7a432dc7fd8e";
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 10,
          last_accepted_order: 60,
          summary: { ...summary, completed: 2 },
          session: {
            session_id: "O".repeat(43),
            image_id: offPageCompletedImageId,
            queue: "upload",
            status: "completed",
            version: 2,
            progress_seq: 0,
            last_semantic_revision: 10,
            accepted_at: 1,
            accepted_order: 1,
            completed_at: 2,
            completed_item: adminImageListItem({
              id: offPageCompletedImageId
            })
          },
          action_watermark: "watermark-ten"
        });
        await Promise.resolve();
      });
      assert.deepEqual(probeCompletedObservations, [offPageCompletedImageId]);
      assert.equal(
        requests.length,
        1,
        "跨页完成失效不应为了当前页额外读取 snapshot"
      );
      assert.equal(view().revision, 10);

      await React.act(async () => {
        source.emit("error", {});
        await Promise.resolve();
      });
      assert.equal(view().status, "disconnected");
      assert.equal(view().total, 60);
      assert.deepEqual(view().items, [{
        id: imageId,
        status: "preparing",
        version: 2
      }]);
      assert.equal(view().watermark, "watermark-ten");

      await React.act(async () => {
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 20,
          action_scope: "scope-two"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === 2);
      assert.equal(view().status, "loading");
      assert.deepEqual(view().items, [{
        id: imageId,
        status: "preparing",
        version: 2
      }]);
      assert.equal(view().actionScope, "scope-two");

      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: true, offset: 20 })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === 3);
      assert.equal(requests[1]!.aborted, true);
      assert.equal(ControlledEventSource.all.length, 1);
      const thirdUrl = new URL(requests[2]!.url, "https://imageshow.test");
      assert.equal(thirdUrl.searchParams.get("offset"), "20");
      assert.equal(thirdUrl.searchParams.get("limit"), "20");
      await React.act(async () => {
        respond(requests[2]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-page-two"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().total, 60);
      assert.equal(view().revision, 20);
      assert.equal(view().items[0]?.status, "ready");
      assert.equal(view().watermark, "watermark-page-two");

      const coveredLimitStart = requests.length;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 12
          })
        ));
        await Promise.resolve();
      });
      assert.equal(view().status, "ready");
      assert.equal(view().watermark, "watermark-page-two");
      assert.equal(
        requests.length,
        coveredLimitStart,
        "同筛选同 offset 的 limit 收缩必须复用已有稳定页"
      );
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 20
          })
        ));
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        coveredLimitStart,
        "恢复到仍被原稳定页覆盖的 limit 也不得追加快照"
      );

      const coalescedRefreshStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        refreshProbe?.();
        refreshProbe?.();
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === coalescedRefreshStart + 1);
      assert.equal(requests[coalescedRefreshStart]!.aborted, false);
      await React.act(async () => {
        respond(requests[coalescedRefreshStart]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-coalesced-first"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-coalesced-first"
      ));
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(requests[coalescedRefreshStart]!.aborted, false);
      assert.equal(
        requests.length,
        coalescedRefreshStart + 1,
        "同页四次普通 refresh 必须由同一成功响应完全覆盖"
      );
      requests.splice(coalescedRefreshStart, 1);

      const failedRefreshStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        refreshProbe?.();
        refreshProbe?.();
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === failedRefreshStart + 1);
      await React.act(async () => {
        requests[failedRefreshStart]!.resolve(new Response(
          "coalesced ordinary refresh failed",
          { status: 503 }
        ));
        await clock.advanceBy(99);
      });
      assert.equal(
        requests.length,
        failedRefreshStart + 1,
        "重复普通 refresh 失败后不得绕过首档有界退避"
      );
      await React.act(async () => {
        await clock.advanceBy(1);
      });
      await settleUntil(() => requests.length === failedRefreshStart + 2);
      await React.act(async () => {
        respond(requests[failedRefreshStart + 1]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-coalesced-retry"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().watermark === "watermark-coalesced-retry");
      assert.equal(
        requests.length,
        failedRefreshStart + 2,
        "四次普通 refresh 失败后只能形成原请求与一次退避重试"
      );
      requests.splice(failedRefreshStart, 2);

      const unknownCoverageStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === unknownCoverageStart + 1);
      await React.act(async () => {
        ensureRevisionProbe?.();
        respond(requests[unknownCoverageStart]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-before-unknown-coverage"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === unknownCoverageStart + 2);
      assert.equal(
        requests[unknownCoverageStart]!.aborted,
        false,
        "未知 coverage 不得中止触发前已在途的同页请求"
      );
      await React.act(async () => {
        respond(requests[unknownCoverageStart + 1]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-after-unknown-coverage"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-after-unknown-coverage"
      ));
      requests.splice(unknownCoverageStart, 2);

      const repeatedRecoveryStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === repeatedRecoveryStart + 1);
      let firstRecovery!: Promise<void>;
      await React.act(async () => {
        firstRecovery = recoverAuthorityProbe!();
        respond(requests[repeatedRecoveryStart]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-before-first-recovery"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === repeatedRecoveryStart + 2);
      let laterRecovery!: Promise<void>;
      await React.act(async () => {
        laterRecovery = recoverAuthorityProbe!();
        assert.equal(
          laterRecovery,
          firstRecovery,
          "恢复链在途期间的新未知结果必须共用 owner promise"
        );
        respond(requests[repeatedRecoveryStart + 1]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-before-later-recovery"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === repeatedRecoveryStart + 3);
      await React.act(async () => {
        respond(requests[repeatedRecoveryStart + 2]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-after-later-recovery"
        });
        await Promise.all([firstRecovery, laterRecovery]);
      });
      assert.equal(
        view().watermark,
        "watermark-after-later-recovery",
        "在途恢复开始后的未知结果必须由更晚快照证明"
      );
      requests.splice(repeatedRecoveryStart, 3);

      const capturedMutationStart = requests.length;
      const capturedSessionId = "N".repeat(43);
      const capturedImageId = "019f8457-063a-7042-a580-7a432dc7fd8e";
      const capturedItem = {
        ...serverItem("queued", 1, 61, capturedImageId),
        session_id: capturedSessionId,
        last_semantic_revision: 21
      };
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === capturedMutationStart + 1);
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 21,
          last_accepted_order: 61,
          summary: { ...summary, total: 61, waiting: 2 },
          session: capturedItem,
          action_watermark: "watermark-captured-mutation"
        });
        ensureRevisionProbe?.(21);
        respond(requests[capturedMutationStart]!, {
          queue: "upload",
          revision: 21,
          last_accepted_order: 61,
          offset: 20,
          limit: 20,
          ...summary,
          total: 61,
          waiting: 2,
          items: [serverItem("ready", 3, 40), capturedItem],
          action_watermark: "watermark-captured-mutation"
        });
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        capturedMutationStart + 1,
        "在途 snapshot 已捕获新会话时不得预排重复 reload"
      );
      assert.equal(view().watermark, "watermark-captured-mutation");
      requests.splice(capturedMutationStart, 1);

      const revertedLimitStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === revertedLimitStart + 1);
      const limitBaselineRequest = requests[revertedLimitStart]!;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 21
          })
        ));
        await Promise.resolve();
      });
      assert.equal(requests.length, revertedLimitStart + 1);
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 20
          })
        ));
        await Promise.resolve();
        respond(limitBaselineRequest, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-reverted-limit"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        revertedLimitStart + 1,
        "limit 扩容后恢复原值时不得保留已无意义的 parameters 尾随快照"
      );
      assert.equal(limitBaselineRequest.aborted, false);
      requests.splice(revertedLimitStart, 1);

      const revertedFailureStart = requests.length;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 21
          })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === revertedFailureStart + 1);
      const obsoleteExpandedRequest = requests[revertedFailureStart]!;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            limit: 20
          })
        ));
        await Promise.resolve();
      });
      assert.equal(requests.length, revertedFailureStart + 1);
      await React.act(async () => {
        obsoleteExpandedRequest.resolve(new Response(
          "obsolete expanded snapshot failed",
          { status: 503 }
        ));
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === revertedFailureStart + 2);
      assert.equal(
        obsoleteExpandedRequest.aborted,
        false,
        "参数恢复不得中止同页扩大请求"
      );
      assert.equal(
        new URL(
          requests[revertedFailureStart + 1]!.url,
          "http://localhost"
        ).searchParams.get("limit"),
        "20",
        "已撤销的参数请求失败后仍须按当前选择完成有界权威恢复"
      );
      await React.act(async () => {
        respond(requests[revertedFailureStart + 1]!, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-reverted-failure-recovered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-reverted-failure-recovered"
      ));
      requests.splice(revertedFailureStart, 2);

      const selectionPair = {
        session_id: "F".repeat(43),
        image_id: "019f8457-063a-7044-a580-7a432dc7fd8e"
      };
      const filterChangeStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === filterChangeStart + 1);
      const supersededFilterRequest = requests[filterChangeStart]!;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            offset: 20,
            selectionPair
          })
        ));
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        filterChangeStart + 1,
        "同页排除集合变化必须排队尾随读取，不能中止当前 fetch"
      );
      await React.act(async () => {
        respond(supersededFilterRequest, {
          queue: "upload",
          revision: 20,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 3, 40)],
          action_watermark: "watermark-superseded-filter"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === filterChangeStart + 2);
      assert.equal(supersededFilterRequest.aborted, false);
      assert.equal(
        view().watermark,
        "watermark-reverted-failure-recovered",
        "旧排除集合的响应不得替换当前稳定页面"
      );
      const filteredRequest = requests[filterChangeStart + 1]!;
      assert.deepEqual(JSON.parse(String(filteredRequest.init.body)), {
        exclude_items: [selectionPair],
        include_items: [selectionPair]
      });
      await React.act(async () => {
        respond(filteredRequest, {
          queue: "upload",
          revision: 21,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 4, 40)],
          action_watermark: "watermark-current-filter"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        view().watermark === "watermark-current-filter"
      ));
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: true, offset: 20 })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === filterChangeStart + 3);
      await React.act(async () => {
        respond(requests[filterChangeStart + 2]!, {
          queue: "upload",
          revision: 21,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 4, 40)],
          action_watermark: "watermark-filter-reset"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().watermark === "watermark-filter-reset");
      requests.splice(filterChangeStart, 3);

      const semanticReloadStart = requests.length;
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 22,
          last_accepted_order: 60,
          summary,
          session: {
            ...serverItem("ready", 4, 40),
            last_semantic_revision: 22
          },
          action_watermark: "watermark-semantic-gap"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === semanticReloadStart + 1);
      assert.equal(
        view().status,
        "ready",
        "同 scope 语义跳变应保留旧水位，避免按钮在后台重读期间失效"
      );
      assert.equal(
        view().watermark,
        "watermark-filter-reset",
        "保留水位必须止于跳变前 accepted-order，不能纳入触发重读的新任务"
      );
      assert.equal(
        view().items[0]?.status,
        "ready",
        "撤销旧快照权威时仍须保留稳定卡片展示"
      );
      await React.act(async () => {
        respond(requests[semanticReloadStart]!, {
          queue: "upload",
          revision: 22,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 4, 40)],
          action_watermark: "watermark-semantic-gap-refreshed"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      requests.splice(semanticReloadStart, 1);

      const queuedSemanticReloadStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === queuedSemanticReloadStart + 1);
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 24,
          last_accepted_order: 60,
          summary,
          session: {
            ...serverItem("ready", 5, 40),
            last_semantic_revision: 24
          },
          action_watermark: "watermark-queued-semantic-gap"
        });
        await Promise.resolve();
      });
      assert.equal(
        view().status,
        "ready",
        "在途同页刷新发现语义跳变时也应保留有界旧操作权威"
      );
      assert.equal(requests.length, queuedSemanticReloadStart + 1);
      await React.act(async () => {
        respond(requests[queuedSemanticReloadStart]!, {
          queue: "upload",
          revision: 22,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 4, 40)],
          action_watermark: "watermark-before-queued-gap"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === queuedSemanticReloadStart + 2);
      assert.equal(
        view().status,
        "ready",
        "尾随读取前旧签名水位仍可稳定服务点击且不会扩大范围"
      );
      assert.equal(
        view().watermark,
        "watermark-semantic-gap-refreshed"
      );
      assert.equal(requests[queuedSemanticReloadStart]!.aborted, false);
      await React.act(async () => {
        respond(requests[queuedSemanticReloadStart + 1]!, {
          queue: "upload",
          revision: 24,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 5, 40)],
          action_watermark: "watermark-after-queued-gap"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().watermark, "watermark-after-queued-gap");
      requests.splice(queuedSemanticReloadStart, 2);

      const samePageReconnectStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === samePageReconnectStart + 1);
      const staleSamePageRequest = requests[samePageReconnectStart]!;
      await React.act(async () => {
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 24,
          action_scope: "scope-three"
        });
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 25,
          action_scope: "scope-four"
        });
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 26,
          action_scope: "scope-five"
        });
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        samePageReconnectStart + 2,
        "连续同页重连只能取消旧 scope 请求并启动最后一代快照"
      );
      assert.equal(
        staleSamePageRequest.aborted,
        true,
        "新 scope 必须释放旧请求的单飞队首，不能等待悬挂响应"
      );
      const trailingReconnectRequest = requests[samePageReconnectStart + 1]!;
      assert.equal(
        new Headers(trailingReconnectRequest.init.headers).get(
          ingestionActionScopeHeader
        ),
        "scope-five",
        "尾随快照必须使用最后一次 ready 的作用域"
      );
      assert.equal(view().status, "loading");
      await React.act(async () => {
        respond(trailingReconnectRequest, {
          queue: "upload",
          revision: 26,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 6, 40)],
          action_watermark: "watermark-same-page-reconnect"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().watermark, "watermark-same-page-reconnect");
      assert.equal(staleSamePageRequest.aborted, true);
      assert.equal(trailingReconnectRequest.aborted, false);
      requests.splice(samePageReconnectStart, 2);

      const automaticRecoveryStart = requests.length;
      await React.act(async () => {
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 27,
          action_scope: "scope-six"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === automaticRecoveryStart + 1);
      await React.act(async () => {
        requests[automaticRecoveryStart]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled retained recovery failure",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(view().status, "disconnected");
      assert.equal(view().watermark, "watermark-same-page-reconnect");
      await React.act(async () => {
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === automaticRecoveryStart + 2);
      await React.act(async () => {
        respond(requests[automaticRecoveryStart + 1]!, {
          queue: "upload",
          revision: 27,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 7, 40)],
          action_watermark: "watermark-automatic-recovery"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      assert.equal(view().watermark, "watermark-automatic-recovery");
      requests.splice(automaticRecoveryStart, 2);

      const mutationRecoveryStart = requests.length;
      await React.act(async () => {
        source.emit("error", {});
        source.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 28,
          action_scope: "scope-seven"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === mutationRecoveryStart + 1);
      await React.act(async () => {
        requests[mutationRecoveryStart]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled mutation recovery failure",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 29,
          last_accepted_order: 60,
          summary,
          session: serverItem("ready", 8, 40),
          action_watermark: "watermark-mutation-recovery"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === mutationRecoveryStart + 2);
      await React.act(async () => {
        respond(requests[mutationRecoveryStart + 1]!, {
          queue: "upload",
          revision: 29,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 8, 40)],
          action_watermark: "watermark-mutation-recovered"
        });
        await clock.advanceBy(100);
      });
      assert.equal(
        requests.length,
        mutationRecoveryStart + 2,
        "mutation 主动恢复后必须消费旧 retry timer，不得追加重复快照"
      );
      assert.equal(view().watermark, "watermark-mutation-recovered");
      requests.splice(mutationRecoveryStart, 2);

      const malformedRecoveryStart = requests.length;
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "import"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === malformedRecoveryStart + 1);
      assert.equal(ControlledEventSource.all.length, 1);
      assert.equal(view().actionScope, "scope-seven");
      await React.act(async () => {
        respond(requests[malformedRecoveryStart]!, {
          queue: "upload",
          revision: 29,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 8, 40)],
          action_watermark: "watermark-malformed-recovered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      requests.splice(malformedRecoveryStart, 1);

      const boundedFailureStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === boundedFailureStart + 1);
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 31,
          last_accepted_order: 60,
          summary,
          session: {
            ...serverItem("ready", 9, 40),
            last_semantic_revision: 31
          },
          action_watermark: "watermark-bounded-failure-one"
        });
        requests[boundedFailureStart]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled queued reload failure one",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        boundedFailureStart + 1,
        "失败请求期间排入的 mutation reload 不得绕过首次退避"
      );
      assert.equal(
        view().status,
        "disconnected",
        "失败后保留卡片但必须撤销旧 action watermark 的执行权威"
      );
      await React.act(async () => {
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === boundedFailureStart + 2);
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 32,
          last_accepted_order: 60,
          summary,
          session: {
            ...serverItem("ready", 10, 40),
            last_semantic_revision: 32
          },
          action_watermark: "watermark-bounded-failure-two"
        });
        requests[boundedFailureStart + 1]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled queued reload failure two",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        boundedFailureStart + 2,
        "连续 mutation 与 5xx 仍必须进入递增退避而非立即连发"
      );
      await React.act(async () => {
        await clock.advanceBy(499);
        assert.equal(
          requests.length,
          boundedFailureStart + 2,
          "第二档恢复期限前不得提前追加快照"
        );
        await clock.advanceBy(1);
      });
      await settleUntil(() => requests.length === boundedFailureStart + 3);
      await React.act(async () => {
        respond(requests[boundedFailureStart + 2]!, {
          queue: "upload",
          revision: 32,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 10, 40)],
          action_watermark: "watermark-bounded-failure-recovered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      requests.splice(boundedFailureStart, 3);

      const retainedRefreshStart = requests.length;
      await React.act(async () => {
        refreshProbe?.();
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === retainedRefreshStart + 1);
      assert.equal(view().status, "ready");
      assert.equal(view().items[0]?.status, "ready");
      await React.act(async () => {
        requests[retainedRefreshStart]!.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled background refresh failure",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        view().status,
        "disconnected",
        "同 scope 快照失败应保留卡片但撤销旧水位执行权威"
      );
      assert.equal(view().items[0]?.status, "ready");
      assert.equal(view().error, "");
      await React.act(async () => {
        await clock.advanceBy(100);
      });
      await settleUntil(() => requests.length === retainedRefreshStart + 2);
      await React.act(async () => {
        respond(requests[retainedRefreshStart + 1]!, {
          queue: "upload",
          revision: 32,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          items: [serverItem("ready", 10, 40)],
          action_watermark: "watermark-background-recovered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "ready");
      requests.splice(retainedRefreshStart, 2);

      const hiddenMutationStart = requests.length;
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            displayed: false,
            offset: 20
          })
        ));
        await Promise.resolve();
      });
      await React.act(async () => {
        source.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "removed",
          revision: 33,
          last_accepted_order: 60,
          summary: { ...summary, total: 59, completed: 0 },
          session: {
            session_id: sessionId,
            image_id: imageId,
            status: "discarded",
            version: 11,
            progress_seq: 0,
            last_semantic_revision: 33,
            accepted_at: 1,
            accepted_order: 40
          },
          action_watermark: "watermark-hidden-removal"
        });
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        hiddenMutationStart,
        "关闭后保留 action scope 时不得为 removed 事件启动即将取消的快照"
      );
      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, {
            enabled: true,
            displayed: true,
            offset: 20
          })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === hiddenMutationStart + 1);
      await React.act(async () => {
        respond(requests[hiddenMutationStart]!, {
          queue: "upload",
          revision: 33,
          last_accepted_order: 60,
          offset: 20,
          limit: 20,
          ...summary,
          total: 59,
          completed: 0,
          items: [],
          action_watermark: "watermark-hidden-reopened"
        });
        await Promise.resolve();
      });
      await settleUntil(() => view().watermark === "watermark-hidden-reopened");
      requests.splice(hiddenMutationStart, 1);

      await React.act(async () => {
        source.emit("error", {});
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: true, offset: 40 })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => view().items.length === 0);
      assert.equal(view().status, "disconnected");
      assert.equal(view().total, null);

      await React.act(async () => {
        root.render(withQueryClient(
          React.createElement(Probe, { enabled: false, offset: 40 })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => view().status === "idle");
      assert.equal(source.closed, true);
      assert.equal(ControlledEventSource.active.size, 0);
        }
      );

      await runQueueScenario(
        "handoff-completion",
        "接管、完成失效与动作清理保持 owner 单调权威",
        async () => {
      const ownerSourceStart = ControlledEventSource.all.length;
      const ownerRequestStart = requests.length;
      await React.act(async () => {
        ownerRoot.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: true })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => (
        ControlledEventSource.all.length === ownerSourceStart + 1
      ));
      const ownerSource = ControlledEventSource.all[ownerSourceStart]!;
      await React.act(async () => {
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 30,
          action_scope: "scope-owner"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === ownerRequestStart + 1);
      await React.act(async () => {
        respond(requests[ownerRequestStart]!, {
          queue: "upload",
          revision: 30,
          last_accepted_order: 60,
          offset: 0,
          limit: 20,
          ...summary,
          items: [serverItem("queued", 1, 60)],
          action_watermark: "watermark-owner"
        });
        await Promise.resolve();
      });
      const ownerView = () => JSON.parse(ownerContainer.textContent || "{}") as {
        status: string;
        generation: number;
        revision: number | null;
        page: number;
        total: number;
        totalPages: number;
        waiting: number;
        ready: number;
        submitting: number;
        pendingHandoff: boolean;
        pendingDraft: boolean;
        reconnectDone: number;
        offPageCompletionOwners: number;
        offPageCompletionDone: number;
        compactChunkHydrated: number;
        jobCount: number;
        serverNotice: string;
        visible: Array<{ id: string; status: string }>;
      };
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(ownerView().total, 60);
      assert.equal(ownerView().waiting, 4);
      assert.equal(ownerView().submitting, 2);
      assert.ok(setOwnerPage);
      await React.act(async () => {
        setOwnerPage!(3);
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === ownerRequestStart + 2);
      assert.equal(
        new URL(requests[ownerRequestStart + 1]!.url, "https://imageshow.test")
          .searchParams.get("offset"),
        "40"
      );
      await React.act(async () => {
        respond(requests[ownerRequestStart + 1]!, {
          queue: "upload",
          revision: 30,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...summary,
          items: [serverItem("queued", 1, 20)],
          action_watermark: "watermark-owner-page-three"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready" && ownerView().page === 3
      ));

      const reducedSummary = {
        total: 5,
        unfinished: 5,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0
      };
      const handoffSummary = {
        ...reducedSummary,
        total: 6,
        unfinished: 6
      };
      await React.act(async () => {
        ownerSource.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "removed",
          revision: 31,
          last_accepted_order: 60,
          summary: reducedSummary,
          session: {
            session_id: sessionId,
            image_id: imageId,
            status: "discarded",
            version: 2,
            progress_seq: 0,
            last_semantic_revision: 31,
            accepted_at: 1,
            accepted_order: 20
          },
          action_watermark: "watermark-reduced"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === ownerRequestStart + 3);
      await React.act(async () => {
        respond(requests[ownerRequestStart + 2]!, {
          queue: "upload",
          revision: 31,
          last_accepted_order: 60,
          offset: 40,
          limit: 20,
          ...reducedSummary,
          items: [],
          action_watermark: "watermark-reduced"
        });
        await Promise.resolve();
      });
      await settleUntil(() => requests.length === ownerRequestStart + 4);
      assert.equal(ownerView().page, 1);
      assert.equal(
        new URL(requests[ownerRequestStart + 3]!.url, "https://imageshow.test")
          .searchParams.get("offset"),
        "0"
      );
      const remainingImageId = "019f8457-063a-7010-a580-7a432dc7fd8e";
      await React.act(async () => {
        respond(requests[ownerRequestStart + 3]!, {
          queue: "upload",
          revision: 31,
          last_accepted_order: 60,
          offset: 0,
          limit: 20,
          ...reducedSummary,
          items: [serverItem("queued", 1, 5, remainingImageId)],
          action_watermark: "watermark-reduced-page-one"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(ownerView().page, 1);
      assert.equal(ownerView().totalPages, 1);
      assert.equal(ownerView().visible[0]?.id, remainingImageId);
      assert.equal(ControlledEventSource.all.length, ownerSourceStart + 1);
      assert.equal(ControlledEventSource.active.size, 1);

      assert.ok(bindOwnerHandoff);
      await React.act(async () => {
        bindOwnerHandoff!(33);
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().pendingHandoff
          && requests.length === ownerRequestStart + 5
      ));
      assert.equal(
        ownerView().total,
        6,
        "有界重取期间必须保留稳定 metadata 与未覆盖交接任务的完整计数"
      );
      assert.equal(
        ownerView().visible.filter((job) => job.id === handoffImageId).length,
        1,
        "HTTP accepted 先到时原占位必须原子转成交接卡且只出现一次"
      );
      await React.act(async () => {
        ownerSource.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 32,
          last_accepted_order: 60,
          summary: reducedSummary,
          session: {
            ...serverItem(
              "preparing",
              2,
              6,
              "019f8457-063a-7012-a580-7a432dc7fd8e"
            ),
            session_id: "O".repeat(43),
            last_semantic_revision: 32
          },
          action_watermark: "watermark-unrelated-32"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().pendingHandoff);
      assert.equal(
        ownerView().pendingHandoff,
        true,
        "离开当前页的 pair 仍须由 owner fence 等待其 HTTP revision"
      );
      assert.equal(
        ownerView().total,
        6,
        "loading 中的不相关事件不得丢掉稳定 Server total"
      );
      assert.equal(
        ownerView().visible.filter((job) => job.id === handoffImageId).length,
        1,
        "不相关的较低 revision 不得让可见交接卡消失"
      );
      await React.act(async () => {
        ownerSource.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: 33,
          last_accepted_order: 61,
          summary: handoffSummary,
          session: {
            ...serverItem("preparing", 2, 61, handoffImageId),
            session_id: handoffSessionId,
            last_semantic_revision: 33
          },
          action_watermark: "watermark-handoff-33"
        });
        await Promise.resolve();
      });
      await React.act(async () => {
        respond(requests[ownerRequestStart + 4]!, {
          queue: "upload",
          revision: 33,
          last_accepted_order: 61,
          offset: 0,
          limit: 20,
          ...handoffSummary,
          items: [{
            ...serverItem("preparing", 2, 61, handoffImageId),
            session_id: handoffSessionId,
            last_semantic_revision: 33
          }],
          action_watermark: "watermark-handoff-33"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready" && !ownerView().pendingHandoff
      ));
      assert.equal(ownerView().total, 6);
      assert.equal(
        ownerView().visible.filter((job) => job.id === handoffImageId).length,
        1,
        "权威 snapshot 接管后同一 pair 仍只能挂载一张卡"
      );

      assert.ok(prepareUnknownCompletedHandoff);
      assert.ok(bindUnknownCompletedHandoff);
      const coveredShrinkStart = requests.length;
      await React.act(async () => {
        prepareUnknownCompletedHandoff!();
        await Promise.resolve();
      });
      assert.equal(ownerView().status, "ready");
      assert.equal(
        requests.length,
        coveredShrinkStart,
        "浏览器前缀覆盖整页时必须复用现有 Server 基线"
      );
      await React.act(async () => {
        setOwnerPage!(3);
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().page === 3);
      const unknownRequestStart = requests.length;
      await React.act(async () => {
        bindUnknownCompletedHandoff!();
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && Boolean(pendingRequest(ingestionSnapshotPath, unknownRequestStart))
      ));
      assert.equal(
        ownerView().total,
        67,
        "离页 completed 回放必须以稳定 Server total 加 detached 摘要补位"
      );
      assert.equal(
        ownerView().visible.filter((job) => (
          job.id === unknownImageId
        )).length,
        0,
        "离页交接只补摘要，不得把 canonical 强行挂到当前组合页"
      );

      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, unknownRequestStart)!, {
          queue: "upload",
          revision: 100,
          last_accepted_order: 62,
          offset: 0,
          limit: 20,
          total: 7,
          unfinished: 6,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [],
          action_watermark: "watermark-completed-active"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, unknownRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, unknownRequestStart)!, {
          items: [{
            session_id: unknownSessionId,
            image_id: unknownImageId,
            status: "completed",
            completed_item: adminImageListItem({ id: unknownImageId }),
            redis_status: "active",
            redis_version: 2,
            redis_last_semantic_revision: 100
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().pendingHandoff);
      assert.equal(
        adminImageInvalidations,
        1,
        "PG completed 即使 Redis canonical 尚为 active 也必须失效图片数据"
      );
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before completed reconnect"
      });
      const oldGenerationStatusCount = requests.slice(unknownRequestStart)
        .filter((request) => (
          !request.aborted
          &&
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length;
      assert.equal(oldGenerationStatusCount, 1);

      const coldRequestStart = requests.length;
      const visibleBeforeColdReconnect = ownerView().visible;
      const totalBeforeColdReconnect = ownerView().total;
      await React.act(async () => {
        ownerSource.emit("error", {});
        await Promise.resolve();
      });
      assert.equal(ownerView().status, "disconnected");
      assert.equal(
        ownerView().total,
        totalBeforeColdReconnect,
        "短暂断线不得把已展示的队列总数归零"
      );
      assert.deepEqual(
        ownerView().visible,
        visibleBeforeColdReconnect,
        "短暂断线不得清空或重排已展示的卡片"
      );
      await React.act(async () => {
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 0,
          action_scope: "scope-owner-cold"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, coldRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, coldRequestStart)!, {
          queue: "upload",
          revision: 0,
          last_accepted_order: 0,
          offset: 0,
          limit: 20,
          total: 0,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-owner-cold"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, coldRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, coldRequestStart)!, {
          items: [{
            session_id: unknownSessionId,
            image_id: unknownImageId,
            status: "completed",
            completed_item: adminImageListItem({ id: unknownImageId }),
            redis_status: "missing"
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(
        adminImageInvalidations,
        1,
        "同一 completed pair 跨重连 status 水合不得重复失效图片数据"
      );
      assert.equal(
        requests.slice(coldRequestStart).filter((request) => (
          !request.aborted
          &&
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "新连接空基线必须重新核对，且收敛后不得继续轮询"
      );

      const coverageBaselineStart = requests.length;
      await React.act(async () => {
        ownerSource.emit("error", {});
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 101,
          action_scope: "scope-owner-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, coverageBaselineStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, coverageBaselineStart)!, {
          queue: "upload",
          revision: 101,
          last_accepted_order: 0,
          offset: 0,
          limit: 20,
          total: 0,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-owner-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");

      assert.ok(bindCoveredCompletedHandoff);
      const coveredRequestStart = requests.length;
      await React.act(async () => {
        bindCoveredCompletedHandoff!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, coveredRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, coveredRequestStart)!, {
          queue: "upload",
          revision: 101,
          last_accepted_order: 1,
          offset: 0,
          limit: 20,
          total: 1,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [],
          action_watermark: "watermark-owner-covered-one"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, coveredRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, coveredRequestStart)!, {
          items: [{
            session_id: coveredSessionId,
            image_id: coveredImageId,
            status: "completed",
            completed_item: adminImageListItem({ id: coveredImageId }),
            redis_status: "completed",
            redis_version: 2,
            redis_last_semantic_revision: 100
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(
        requests.slice(coveredRequestStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "已被稳定 baseline 覆盖的离页 receipt 必须当场收敛"
      );

      assert.ok(bindCrossGenerationAccepted);
      const crossGenerationRequestStart = requests.length;
      await React.act(async () => {
        bindCrossGenerationAccepted!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, crossGenerationRequestStart)
      ));
      assert.equal(
        requests.slice(crossGenerationRequestStart).some((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )),
        false,
        "当前代基线已覆盖旧代 HTTP revision 时应直接批量核对 pair"
      );
      await React.act(async () => {
        respond(
          pendingRequest(ingestionStatusPath, crossGenerationRequestStart)!,
          {
            items: [{
              session_id: crossGenerationSessionId,
              image_id: crossGenerationImageId,
              status: "completed",
              completed_item: adminImageListItem({ id: crossGenerationImageId }),
              redis_status: "missing"
            }]
          }
        );
        await Promise.resolve();
      });
      await settleUntil(() => (
        !ownerView().pendingHandoff
        && ownerView().visible.some((job) => (
          job.id === crossGenerationImageId && job.status === "done"
        ))
      ));
      assert.ok(
        revokedObjectUrls.includes("blob:cross-generation-visible"),
        "满 local 页移除跨代 handoff 卡时必须释放浏览器 Blob URL"
      );
      assert.ok(releaseCrossGenerationHydrated);
      const crossGenerationReleaseStart = requests.length;
      await React.act(async () => {
        releaseRaceReleased = false;
        releaseCrossGenerationHydrated!();
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      assert.equal(
        ownerView().visible.some((job) => job.id === crossGenerationImageId),
        false,
        "status 先水合的同 attempt done 卡仍须被后到 clear 结果释放"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, crossGenerationReleaseStart)
      ));
      const crossGenerationReleaseSnapshot = pendingRequest(
        ingestionSnapshotPath,
        crossGenerationReleaseStart
      )!;
      const crossGenerationReleaseUrl = new URL(
        crossGenerationReleaseSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(crossGenerationReleaseSnapshot, {
          queue: "upload",
          revision: 101,
          last_accepted_order: 1,
          offset: Number(crossGenerationReleaseUrl.searchParams.get("offset")),
          limit: Number(crossGenerationReleaseUrl.searchParams.get("limit")),
          total: 1,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [],
          action_watermark: "watermark-after-cross-generation-release"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");

      assert.ok(bindReleaseRaceHandoff);
      assert.ok(releaseRaceHandoff);
      const releaseRaceRequestStart = requests.length;
      await React.act(async () => {
        bindReleaseRaceHandoff!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, releaseRaceRequestStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, releaseRaceRequestStart)!, {
          queue: "upload",
          revision: 102,
          last_accepted_order: 2,
          offset: 0,
          limit: 20,
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-before-release-race"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, releaseRaceRequestStart)
      ));
      const staleReleaseStatus = pendingRequest(
        ingestionStatusPath,
        releaseRaceRequestStart
      )!;
      await React.act(async () => {
        releaseRaceHandoff!();
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(releaseRaceReleased, true);
      assert.equal(
        ownerView().visible.some((job) => job.id === releaseRaceImageId),
        false
      );
      await React.act(async () => {
        respond(staleReleaseStatus, {
          items: [{
            session_id: releaseRaceSessionId,
            image_id: releaseRaceImageId,
            status: "completed",
            completed_item: adminImageListItem({ id: releaseRaceImageId }),
            redis_status: "missing"
          }]
        });
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(ownerView().pendingHandoff, false);
      assert.equal(
        ownerView().visible.some((job) => job.id === releaseRaceImageId),
        false,
        "同一 Server clear 已释放的 pair 不得被迟到 status 重新注入"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, releaseRaceRequestStart)
      ));
      const releaseRaceRecoverySnapshot = pendingRequest(
        ingestionSnapshotPath,
        releaseRaceRequestStart
      )!;
      const releaseRaceRecoveryUrl = new URL(
        releaseRaceRecoverySnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(releaseRaceRecoverySnapshot, {
          queue: "upload",
          revision: 102,
          last_accepted_order: 2,
          offset: Number(releaseRaceRecoveryUrl.searchParams.get("offset")),
          limit: Number(releaseRaceRecoveryUrl.searchParams.get("limit")),
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-after-release-race"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");

      assert.ok(releaseMountedFinalized);
      const mountedReleaseRequestStart = requests.length;
      await React.act(async () => {
        releaseRaceReleased = false;
        releaseMountedFinalized!();
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      assert.equal(ownerView().pendingHandoff, false);
      assert.equal(
        ownerView().visible.some((job) => job.id === mountedReleaseImageId),
        false,
        "commit-owned finalized 卡必须由专用权威释放动作移出"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, mountedReleaseRequestStart)
      ));
      const mountedReleaseSnapshot = pendingRequest(
        ingestionSnapshotPath,
        mountedReleaseRequestStart
      )!;
      const mountedReleaseSnapshotUrl = new URL(
        mountedReleaseSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(mountedReleaseSnapshot, {
          queue: "upload",
          revision: 103,
          last_accepted_order: 2,
          offset: Number(mountedReleaseSnapshotUrl.searchParams.get("offset")),
          limit: Number(mountedReleaseSnapshotUrl.searchParams.get("limit")),
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-after-mounted-release"
        });
        await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.slice(mountedReleaseRequestStart).filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        1,
        "一页 Server 替补必须让 mounted release 以一次快照收敛"
      );
      await settleUntil(() => (
        ownerView().status === "ready"
        && !pendingRequest(ingestionSnapshotPath, mountedReleaseRequestStart)
      ));

      assert.ok(bindCrossGenerationCompletedCoverage);
      const completedCoverageStart = requests.length;
      await React.act(async () => {
        bindCrossGenerationCompletedCoverage!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, completedCoverageStart)
      ));
      assert.equal(
        pendingRequest(ingestionSnapshotPath, completedCoverageStart),
        undefined,
        "跨代 completed 响应必须先由当前连接 status 确认真正 revision"
      );
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, completedCoverageStart)!, {
          items: [{
            session_id: crossGenerationCompletedSessionId,
            image_id: crossGenerationCompletedImageId,
            status: "completed",
            completed_item: adminImageListItem({
              id: crossGenerationCompletedImageId
            }),
            redis_status: "completed",
            redis_version: 2,
            redis_last_semantic_revision: 109
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().pendingHandoff
        && Boolean(pendingRequest(ingestionSnapshotPath, completedCoverageStart))
      ));
      assert.equal(
        ownerView().pendingHandoff,
        true,
        "高于当前 baseline 的 completed receipt 必须继续持有 owner 围栏"
      );
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, completedCoverageStart)!, {
          queue: "upload",
          revision: 109,
          last_accepted_order: 4,
          offset: 0,
          limit: 20,
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-completed-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(
        requests.slice(completedCoverageStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "completed coverage 应主动刷新权威快照且不得轮询 status"
      );

      assert.ok(bindCrossGenerationPresent);
      const presentCoverageStart = requests.length;
      await React.act(async () => {
        bindCrossGenerationPresent!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, presentCoverageStart)
      ));
      assert.equal(
        requests.slice(presentCoverageStart).some((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )),
        false,
        "当前代 revision 已覆盖时应先核对跨代 pair，不预读同一快照"
      );
      assert.equal(
        ownerView().total,
        63,
        "跨代 accepted 在 order 水位覆盖前必须以 byte-free 投影补回组合总数"
      );
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, presentCoverageStart)!, {
          items: [{
            session_id: crossGenerationPresentSessionId,
            image_id: crossGenerationPresentImageId,
            status: "present",
            item: {
              ...serverItem(
                "ready",
                4,
                5,
                crossGenerationPresentImageId
              ),
              session_id: crossGenerationPresentSessionId,
              last_semantic_revision: 110
            }
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().pendingHandoff
        && Boolean(pendingRequest(ingestionSnapshotPath, presentCoverageStart))
      ));
      assert.equal(
        ownerView().pendingHandoff,
        true,
        "高于当前 baseline 的 present DTO 不得提前释放跨代 owner 围栏"
      );
      assert.equal(
        ownerView().total,
        63,
        "present status 不得在覆盖快照到达前提前减掉 provisional 总数"
      );
      await React.act(async () => {
        respond(pendingRequest(ingestionSnapshotPath, presentCoverageStart)!, {
          queue: "upload",
          revision: 110,
          last_accepted_order: 5,
          offset: 0,
          limit: 20,
          total: 3,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-present-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => !ownerView().pendingHandoff);
      assert.equal(
        requests.slice(presentCoverageStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "present coverage 应以一次 status 加一次权威快照收敛，不得轮询"
      );

      assert.ok(bindIncarnationReplacement);
      assert.ok(releaseIncarnationReplacement);
      const incarnationRequestStart = requests.length;
      await React.act(async () => {
        bindIncarnationReplacement!();
        releaseRaceReleased = false;
        releaseIncarnationReplacement!();
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      assert.equal(ownerView().pendingHandoff, false);
      assert.equal(ownerView().pendingDraft, false);
      assert.ok(
        revokedObjectUrls.includes("blob:old-incarnation-owner"),
        "同 session 新 image 接管时必须释放旧 canonical 的 Blob URL"
      );
      assert.equal(
        ownerView().visible.some((job) => (
          job.id === oldIncarnationImageId
          || job.id === nextIncarnationImageId
        )),
        false,
        "释放新 incarnation 后不得残留旧 pair 的围栏或卡片"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, incarnationRequestStart)
      ));
      const incarnationSnapshot = pendingRequest(
        ingestionSnapshotPath,
        incarnationRequestStart
      )!;
      const incarnationSnapshotUrl = new URL(
        incarnationSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(incarnationSnapshot, {
          queue: "upload",
          revision: 112,
          last_accepted_order: 7,
          offset: Number(incarnationSnapshotUrl.searchParams.get("offset")),
          limit: Number(incarnationSnapshotUrl.searchParams.get("limit")),
          total: 3,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0,
          items: [],
          action_watermark: "watermark-incarnation-replaced"
        });
        await Promise.resolve();
      });
      const incarnationTrailingSnapshot = pendingRequest(
        ingestionSnapshotPath,
        incarnationRequestStart
      );
      if (incarnationTrailingSnapshot) {
        const trailingUrl = new URL(
          incarnationTrailingSnapshot.url,
          "https://imageshow.test"
        );
        await React.act(async () => {
          respond(incarnationTrailingSnapshot, {
            queue: "upload",
            revision: 112,
            last_accepted_order: 7,
            offset: Number(trailingUrl.searchParams.get("offset")),
            limit: Number(trailingUrl.searchParams.get("limit")),
            total: 3,
            unfinished: 1,
            waiting: 0,
            running: 0,
            ready: 1,
            duplicate_pending: 0,
            committing: 0,
            resolving: 0,
            completed: 2,
            failed: 0,
            items: [],
            action_watermark: "watermark-incarnation-replaced-trailing"
          });
          await Promise.resolve();
        });
      }
      await settleUntil(() => (
        ownerView().status === "ready"
        && !pendingRequest(ingestionSnapshotPath, incarnationRequestStart)
      ));

      assert.ok(bindReconnectAcceptedOwners);
      const reconnectAcceptedStart = requests.length;
      await React.act(async () => {
        bindReconnectAcceptedOwners!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, reconnectAcceptedStart)
      ));
      const preReconnectSnapshot = pendingRequest(
        ingestionSnapshotPath,
        reconnectAcceptedStart
      )!;
      await React.act(async () => {
        ownerSource.emit("error", {});
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 114,
          action_scope: "scope-owner-reconnect-accepted"
        });
        await Promise.resolve();
      });
      await settleUntil(() => {
        const pending = pendingRequest(
          ingestionSnapshotPath,
          reconnectAcceptedStart
        );
        return Boolean(pending && pending !== preReconnectSnapshot);
      });
      assert.equal(
        preReconnectSnapshot.aborted,
        true,
        "owner 换代也必须只取消旧 scope 的在途快照"
      );
      const reconnectSnapshot = pendingRequest(
        ingestionSnapshotPath,
        reconnectAcceptedStart
      )!;
      const reconnectSnapshotUrl = new URL(
        reconnectSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(reconnectSnapshot, {
          queue: "upload",
          revision: 114,
          last_accepted_order: 0,
          offset: Number(reconnectSnapshotUrl.searchParams.get("offset")),
          limit: Number(reconnectSnapshotUrl.searchParams.get("limit")),
          total: 0,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-owner-reconnect-accepted"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, reconnectAcceptedStart)
      ));
      const reconnectStatus = pendingRequest(
        ingestionStatusPath,
        reconnectAcceptedStart
      )!;
      const requestedReconnectPairs = (
        JSON.parse(String(reconnectStatus.init.body ?? "{}")) as {
          items: Array<{ session_id: string; image_id: string }>;
        }
      ).items;
      assert.deepEqual(
        new Set(requestedReconnectPairs.map((item) => item.session_id)),
        new Set([reconnectVisibleSessionId, reconnectOffPageSessionId]),
        "换代必须把可见与离页的未覆盖 accepted pair 一并升级为 status owner"
      );
      assert.equal(
        ownerView().total,
        21,
        "reconnect status 收敛前必须保留可见与离页 provisional 总数"
      );
      await React.act(async () => {
        respond(reconnectStatus, {
          items: requestedReconnectPairs.map((pair) => ({
            ...pair,
            status: "completed",
            completed_item: adminImageListItem({ id: pair.image_id }),
            redis_status: "missing"
          }))
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        !ownerView().pendingHandoff && ownerView().reconnectDone === 2
      ));
      assert.equal(
        requests.slice(reconnectAcceptedStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "reconnect promotion 必须用一次批量 status 收敛且不得轮询"
      );

      assert.ok(refreshOwner);
      const loadingSnapshotStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && Boolean(pendingRequest(ingestionSnapshotPath, loadingSnapshotStart))
      ));
      const loadingSnapshot = pendingRequest(
        ingestionSnapshotPath,
        loadingSnapshotStart
      )!;
      assert.ok(bindLoadingAcceptedOwner);
      const loadingAcceptedStart = requests.length;
      const staleRequestGeneration = ownerView().generation - 1;
      await React.act(async () => {
        bindLoadingAcceptedOwner!(staleRequestGeneration);
        await Promise.resolve();
      });
      assert.equal(loadingSnapshot.aborted, false);
      assert.equal(
        requests.slice(loadingAcceptedStart).filter((request) => (
          !request.aborted
          && !request.resolved
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        0,
        "已有同页快照在途时不得为新的收敛触发中止旧请求或并发读取"
      );
      assert.equal(ownerView().status, "ready");
      assert.equal(
        ownerView().total,
        61,
        "loading 期间到达的新 accepted order 必须保留 provisional 总数"
      );
      const loadingSnapshotUrl = new URL(
        loadingSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(loadingSnapshot, {
          queue: "upload",
          revision: 114,
          last_accepted_order: 10,
          offset: Number(loadingSnapshotUrl.searchParams.get("offset")),
          limit: Number(loadingSnapshotUrl.searchParams.get("limit")),
          total: 1,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-loading-accepted-stale"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, loadingAcceptedStart)
      ));
      assert.equal(ownerView().total, 61);
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, loadingAcceptedStart)!, {
          items: [{
            session_id: loadingAcceptedSessionId,
            image_id: loadingAcceptedImageId,
            status: "present",
            item: {
              ...serverItem("ready", 2, 10, loadingAcceptedImageId),
              session_id: loadingAcceptedSessionId,
              last_semantic_revision: 115
            }
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && Boolean(pendingRequest(ingestionSnapshotPath, loadingAcceptedStart))
      ));
      assert.equal(
        ownerView().total,
        61,
        "已含 pair 的稳定 total 在 revision coverage loading 时不得重复加 provisional"
      );
      const loadingCoverageSnapshot = pendingRequest(
        ingestionSnapshotPath,
        loadingAcceptedStart
      )!;
      const loadingCoverageUrl = new URL(
        loadingCoverageSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(loadingCoverageSnapshot, {
          queue: "upload",
          revision: 115,
          last_accepted_order: 10,
          offset: Number(loadingCoverageUrl.searchParams.get("offset")),
          limit: Number(loadingCoverageUrl.searchParams.get("limit")),
          total: 1,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-loading-accepted-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && !ownerView().pendingHandoff
        && ownerView().total === 61
      ));
      assert.equal(
        requests.slice(loadingAcceptedStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "loading accepted 必须以一次 status 和一次 coverage 快照收敛"
      );

      const completedSnapshotSessionId = "M".repeat(43);
      const completedSnapshotImageId =
        "019f8457-063a-7044-a580-7a432dc7fd8e";
      const completedSnapshotItem = adminImageListItem({
        id: completedSnapshotImageId,
        author: "snapshot-author",
        tags: ["snapshot-tag"]
      });
      const adjacentCompletedItem = adminImageListItem({
        id: "019f8457-063a-7045-a580-7a432dc7fd8e",
        author: "snapshot-author"
      });
      const completedSnapshotServerItem = {
        session_id: completedSnapshotSessionId,
        image_id: completedSnapshotImageId,
        queue: "upload" as const,
        status: "completed" as const,
        version: 2,
        progress_seq: 0 as const,
        last_semantic_revision: 116,
        accepted_at: 1,
        accepted_order: 11,
        completed_at: 2,
        completed_item: completedSnapshotItem
      };
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before completed snapshot"
      });
      const invalidationsBeforeCompletedSnapshot = adminImageInvalidations;
      assert.ok(observeOwnerCompleted);
      await React.act(async () => {
        const pair = {
          session_id: completedSnapshotSessionId,
          image_id: completedSnapshotImageId
        };
        observeOwnerCompleted!(pair, completedSnapshotItem);
        observeOwnerCompleted!(pair, completedSnapshotItem);
        observeOwnerCompleted!({
          session_id: "N".repeat(43),
          image_id: adjacentCompletedItem.id
        }, adjacentCompletedItem);
        await Promise.resolve();
      });
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompletedSnapshot + 1,
        "同一完成批次的不同 pair 及重复观察只能合并失效一次"
      );
      assert.ok(refreshOwner);
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath)
      ));
      const completedSnapshotRequest = pendingRequest(ingestionSnapshotPath);
      assert.ok(completedSnapshotRequest);
      const completedSnapshotStart = requests.length;
      await React.act(async () => {
        setOwnerPage!(4);
        await Promise.resolve();
      });
      assert.equal(completedSnapshotRequest.aborted, false);
      assert.equal(
        requests.slice(completedSnapshotStart).filter((request) => (
          !request.aborted
          && !request.resolved
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        0,
        "翻页参数落在同一组合 offset 时必须复用在途读取并只排队一个必要尾随快照"
      );
      const completedSnapshotUrl = new URL(
        completedSnapshotRequest.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(completedSnapshotRequest, {
          queue: "upload",
          revision: 116,
          last_accepted_order: 11,
          offset: Number(completedSnapshotUrl.searchParams.get("offset")),
          limit: Number(completedSnapshotUrl.searchParams.get("limit")),
          total: 2,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [completedSnapshotServerItem],
          action_watermark: "watermark-completed-snapshot"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
      ));
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompletedSnapshot + 1,
        "动作响应之后的 completed snapshot 不得重复失效"
      );
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before repeated completed snapshot"
      });

      const preRepeatedReconnectSnapshot = pendingRequest(ingestionSnapshotPath);
      assert.ok(preRepeatedReconnectSnapshot);
      const repeatedCompletedSnapshotStart = requests.length;
      await React.act(async () => {
        ownerSource.emit("error", {});
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 116,
          action_scope: "scope-owner-completed-snapshot-reconnect"
        });
        await Promise.resolve();
      });
      assert.equal(
        requests.length,
        repeatedCompletedSnapshotStart + 1,
        "completed snapshot 换代必须直接启动新 scope 的唯一读取"
      );
      assert.equal(preRepeatedReconnectSnapshot.aborted, true);
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, repeatedCompletedSnapshotStart)
      ));
      const repeatedCompletedSnapshot = pendingRequest(
        ingestionSnapshotPath,
        repeatedCompletedSnapshotStart
      )!;
      const repeatedCompletedSnapshotUrl = new URL(
        repeatedCompletedSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(repeatedCompletedSnapshot, {
          queue: "upload",
          revision: 116,
          last_accepted_order: 11,
          offset: Number(
            repeatedCompletedSnapshotUrl.searchParams.get("offset")
          ),
          limit: Number(
            repeatedCompletedSnapshotUrl.searchParams.get("limit")
          ),
          total: 2,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [completedSnapshotServerItem],
          action_watermark: "watermark-completed-snapshot-reconnect"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompletedSnapshot + 1,
        "同一 completed snapshot 在 SSE 重连代际不得重复失效"
      );

      assert.ok(bindLoadingAcceptedOwner);
      const renderGapStart = requests.length;
      const renderGapRequestGeneration = ownerView().generation;
      await React.act(async () => {
        ownerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 1,
          action_scope: "scope-owner-render-gap"
        });
        // Intentionally bind before React commits the ready projection. The
        // queue controller has already advanced internally, while handoff
        // callers still observe the previous high-revision generation.
        bindLoadingAcceptedOwner!(renderGapRequestGeneration);
        await Promise.resolve();
      });
      await settleUntil(() => (
        Boolean(pendingRequest(ingestionSnapshotPath, renderGapStart))
      ));
      assert.equal(
        ownerView().pendingHandoff,
        true,
        "React render-gap 内的旧代响应不得被旧高 revision 快捷清除"
      );
      const renderGapReadySnapshot = pendingRequest(
        ingestionSnapshotPath,
        renderGapStart
      )!;
      const renderGapReadyUrl = new URL(
        renderGapReadySnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(renderGapReadySnapshot, {
          queue: "upload",
          revision: 1,
          last_accepted_order: 0,
          offset: Number(renderGapReadyUrl.searchParams.get("offset")),
          limit: Number(renderGapReadyUrl.searchParams.get("limit")),
          total: 0,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [],
          action_watermark: "watermark-render-gap-ready"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      await settleUntil(() => Boolean(
        pendingRequest(ingestionStatusPath, renderGapStart)
      ));
      await React.act(async () => {
        respond(pendingRequest(ingestionStatusPath, renderGapStart)!, {
          items: [{
            session_id: loadingAcceptedSessionId,
            image_id: loadingAcceptedImageId,
            status: "present",
            item: {
              ...serverItem("ready", 2, 10, loadingAcceptedImageId),
              session_id: loadingAcceptedSessionId,
              last_semantic_revision: 2
            }
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, renderGapStart)
      ));
      const renderGapCoverageSnapshot = pendingRequest(
        ingestionSnapshotPath,
        renderGapStart
      )!;
      const renderGapCoverageUrl = new URL(
        renderGapCoverageSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(renderGapCoverageSnapshot, {
          queue: "upload",
          revision: 2,
          last_accepted_order: 10,
          offset: Number(renderGapCoverageUrl.searchParams.get("offset")),
          limit: Number(renderGapCoverageUrl.searchParams.get("limit")),
          total: 1,
          unfinished: 1,
          waiting: 0,
          running: 0,
          ready: 1,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: [{
            ...serverItem("ready", 2, 10, loadingAcceptedImageId),
            session_id: loadingAcceptedSessionId,
            last_semantic_revision: 2
          }],
          action_watermark: "watermark-render-gap-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready" && !ownerView().pendingHandoff
      ));
      assert.equal(
        requests.slice(renderGapStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        2,
        "render-gap 只允许新代 ready 与当前 status revision 各一次快照"
      );
      assert.equal(
        requests.slice(renderGapStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        )).length,
        1,
        "render-gap handoff 必须恰好回读一次当前代 status"
      );

      assert.ok(prepareVisibleReadyRelease);
      assert.ok(releaseVisibleReady);
      const staleReleaseSnapshotStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionSnapshotPath,
        staleReleaseSnapshotStart
      )));
      const staleReleaseSnapshot = pendingRequest(
        ingestionSnapshotPath,
        staleReleaseSnapshotStart
      )!;
      const staleReleaseUrl = new URL(
        staleReleaseSnapshot.url,
        "https://imageshow.test"
      );
      const singleReleaseStart = requests.length;
      await React.act(async () => {
        prepareVisibleReadyRelease!();
        assert.deepEqual(
          visibleReadyReleaseBeforeIds,
          [...visibleReadyReleaseImageIds],
          "回归基线必须固定为七张 ready 卡并保持 1→7 顺序"
        );
        releaseRaceReleased = false;
        releaseVisibleReady!();
        assert.equal(releaseRaceReleased, true);
        respond(staleReleaseSnapshot, {
          queue: "upload",
          revision: 3,
          last_accepted_order: 16,
          offset: Number(staleReleaseUrl.searchParams.get("offset")),
          limit: Number(staleReleaseUrl.searchParams.get("limit")),
          total: 7,
          unfinished: 7,
          waiting: 0,
          running: 0,
          ready: 7,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: visibleReadyReleaseImageIds.map((imageId, index) => ({
            ...serverItem("ready", 2, 10 + index, imageId),
            session_id: visibleReadyReleaseSessionIds[index],
            last_semantic_revision: 3
          })),
          action_watermark: "watermark-single-release-stale"
        });
        await Promise.resolve();
      });
      const remainingReadyReleaseImageIds = visibleReadyReleaseImageIds.filter(
        (imageId) => imageId !== visibleReadyReleaseTargetImageId
      );
      assert.deepEqual(
        visibleReadyReleaseAfterIds,
        remainingReadyReleaseImageIds,
        "第一次移除第 5 张时队列 ref 必须同步变为六张并原位保序"
      );
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(
        ownerView().visible.some((job) => (
          job.id === visibleReadyReleaseTargetImageId
        )),
        false,
        "第一次移除第 5 张后旧 snapshot 不得把同一 ready pair 放到队尾"
      );
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        remainingReadyReleaseImageIds,
        "移除前已在途的七项旧快照晚到后仍须保持六项原顺序"
      );
      assert.equal(ownerView().total, 6, "单项移除后总数必须立即减少一次");
      assert.equal(ownerView().ready, 6, "单项移除后 ready 摘要必须立即减少一次");
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, singleReleaseStart)
      ));
      const singleReleaseSnapshot = pendingRequest(
        ingestionSnapshotPath,
        singleReleaseStart
      )!;
      const singleReleaseUrl = new URL(
        singleReleaseSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(singleReleaseSnapshot, {
          queue: "upload",
          revision: 4,
          last_accepted_order: 16,
          offset: Number(singleReleaseUrl.searchParams.get("offset")),
          limit: Number(singleReleaseUrl.searchParams.get("limit")),
          total: 6,
          unfinished: 6,
          waiting: 0,
          running: 0,
          ready: 6,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: remainingReadyReleaseImageIds.map((imageId) => ({
            ...serverItem(
              "ready",
              2,
              10 + visibleReadyReleaseImageIds.indexOf(imageId),
              imageId
            ),
            session_id: visibleReadyReleaseSessionIds[
              visibleReadyReleaseImageIds.indexOf(imageId)
            ],
            last_semantic_revision: 4
          })),
          action_watermark: "watermark-single-release-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(
        requests.slice(singleReleaseStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        1,
        "单项移除成功后只允许一次 post-trigger 权威快照"
      );
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        remainingReadyReleaseImageIds
      );
      assert.equal(ownerView().total, 6);
      assert.equal(ownerView().ready, 6);

      const boundaryExtraImageIds = Array.from({ length: 15 }, (
        _value,
        index
      ) => (
        `019f8457-063a-${(0x7050 + index).toString(16)}-a580-7a432dc7fd8e`
      ));
      const boundaryImageIds = [
        ...remainingReadyReleaseImageIds,
        ...boundaryExtraImageIds
      ];
      const boundarySessionIds = [
        ...remainingReadyReleaseImageIds.map((imageId) => (
          visibleReadyReleaseSessionIds[
            visibleReadyReleaseImageIds.indexOf(imageId)
          ]!
        )),
        ...boundaryExtraImageIds.map((_imageId, index) => (
          String.fromCharCode("a".charCodeAt(0) + index).repeat(43)
        ))
      ];
      const boundaryItems = boundaryImageIds.map((imageId, index) => ({
        ...serverItem("ready", 3, 20 + index, imageId),
        session_id: boundarySessionIds[index]!,
        last_semantic_revision: 6
      }));
      const boundaryBaselineStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, boundaryBaselineStart)
      ));
      const boundaryBaseline = pendingRequest(
        ingestionSnapshotPath,
        boundaryBaselineStart
      )!;
      const boundaryBaselineUrl = new URL(
        boundaryBaseline.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(boundaryBaseline, {
          queue: "upload",
          revision: 6,
          last_accepted_order: 40,
          offset: Number(boundaryBaselineUrl.searchParams.get("offset")),
          limit: Number(boundaryBaselineUrl.searchParams.get("limit")),
          total: 21,
          unfinished: 21,
          waiting: 0,
          running: 0,
          ready: 21,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: boundaryItems.slice(0, 20),
          action_watermark: "watermark-release-page-boundary"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().total === 21
        && ownerView().visible.length === 20
      ));
      const boundaryPageTwoStart = requests.length;
      await React.act(async () => {
        setOwnerPage!(2);
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, boundaryPageTwoStart)
      ));
      const boundaryPageTwo = pendingRequest(
        ingestionSnapshotPath,
        boundaryPageTwoStart
      )!;
      const boundaryPageTwoUrl = new URL(
        boundaryPageTwo.url,
        "https://imageshow.test"
      );
      assert.equal(boundaryPageTwoUrl.searchParams.get("offset"), "20");
      await React.act(async () => {
        respond(boundaryPageTwo, {
          queue: "upload",
          revision: 6,
          last_accepted_order: 40,
          offset: Number(boundaryPageTwoUrl.searchParams.get("offset")),
          limit: Number(boundaryPageTwoUrl.searchParams.get("limit")),
          total: 21,
          unfinished: 21,
          waiting: 0,
          running: 0,
          ready: 21,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: boundaryItems.slice(20),
          action_watermark: "watermark-release-target-absent"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready" && ownerView().page === 2
      ));
      assert.equal(ownerView().total, 21);
      assert.equal(ownerView().ready, 21);

      const absentReleaseImageId = remainingReadyReleaseImageIds[0]!;
      const afterAbsentReleaseImageIds = remainingReadyReleaseImageIds.filter(
        (imageId) => imageId !== absentReleaseImageId
      );
      const absentReleaseRecoveryStart = requests.length;
      await React.act(async () => {
        releaseRaceReleased = false;
        releaseVisibleReady!(absentReleaseImageId, {
          revision: 7,
          summary: readyReleaseSummary
        });
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      await settleUntil(() => (
        ownerView().total === 20
        && ownerView().page === 1
        && ownerView().totalPages === 1
      ));
      assert.equal(
        ownerView().ready,
        20,
        "目标不在 bounded items 时仍须按 discard revision 立即扣减 ready"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, absentReleaseRecoveryStart)
      ));
      const absentReleaseFailedProof = pendingRequest(
        ingestionSnapshotPath,
        absentReleaseRecoveryStart
      )!;
      const firstAbsentReleaseProofUrl = new URL(
        absentReleaseFailedProof.url,
        "https://imageshow.test"
      );
      assert.equal(
        firstAbsentReleaseProofUrl.searchParams.get("offset"),
        "0",
        "21→20 跨页释放必须先原子夹紧到第一页再启动 proof"
      );
      assert.equal(
        requests.slice(absentReleaseRecoveryStart).filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        1,
        "跨页释放不得先按已越界 offset 发出随后被中止的 proof"
      );
      assert.equal(absentReleaseFailedProof.aborted, false);
      await React.act(async () => {
        absentReleaseFailedProof.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled absent release proof retry",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await clock.advanceBy(100);
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, absentReleaseRecoveryStart)
      ));
      const absentReleaseProof = pendingRequest(
        ingestionSnapshotPath,
        absentReleaseRecoveryStart
      )!;
      const absentReleaseProofUrl = new URL(
        absentReleaseProof.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(absentReleaseProof, {
          queue: "upload",
          revision: 7,
          last_accepted_order: 40,
          offset: Number(absentReleaseProofUrl.searchParams.get("offset")),
          limit: Number(absentReleaseProofUrl.searchParams.get("limit")),
          total: 20,
          unfinished: 20,
          waiting: 0,
          running: 0,
          ready: 20,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: boundaryItems.filter((item) => (
            item.image_id !== absentReleaseImageId
          )).map((item) => ({
            ...item,
            last_semantic_revision: 7
          })),
          action_watermark: "watermark-release-target-absent-covered"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().total === 20
        && ownerView().ready === 20
      ));
      assert.equal(
        requests.slice(absentReleaseRecoveryStart).filter((request) => (
          !request.aborted
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        2,
        "目标缺席时一次失败只允许按既定退避续接同一 proof snapshot"
      );

      const releaseBoundaryTrimStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, releaseBoundaryTrimStart)
      ));
      const releaseBoundaryTrimSnapshot = pendingRequest(
        ingestionSnapshotPath,
        releaseBoundaryTrimStart
      )!;
      const releaseBoundaryTrimUrl = new URL(
        releaseBoundaryTrimSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(releaseBoundaryTrimSnapshot, {
          queue: "upload",
          revision: 7,
          last_accepted_order: 40,
          offset: Number(releaseBoundaryTrimUrl.searchParams.get("offset")),
          limit: Number(releaseBoundaryTrimUrl.searchParams.get("limit")),
          total: 5,
          unfinished: 5,
          waiting: 0,
          running: 0,
          ready: 5,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: afterAbsentReleaseImageIds.map((imageId) => ({
            ...serverItem(
              "ready",
              3,
              10 + visibleReadyReleaseImageIds.indexOf(imageId),
              imageId
            ),
            session_id: visibleReadyReleaseSessionIds[
              visibleReadyReleaseImageIds.indexOf(imageId)
            ],
            last_semantic_revision: 7
          })),
          action_watermark: "watermark-release-boundary-trimmed"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().page === 1
        && ownerView().total === 5
      ));
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        afterAbsentReleaseImageIds,
        "同窗口 proof 成功后必须释放临时投影并保留其余原顺序"
      );

      const failedReleaseImageId = afterAbsentReleaseImageIds[0]!;
      const failedReleaseRemainingImageIds = afterAbsentReleaseImageIds.filter(
        (imageId) => imageId !== failedReleaseImageId
      );
      const failedReleaseRecoveryStart = requests.length;
      await React.act(async () => {
        releaseRaceReleased = false;
        releaseVisibleReady!(failedReleaseImageId);
        await Promise.resolve();
      });
      assert.equal(releaseRaceReleased, true);
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        failedReleaseRemainingImageIds,
        "恢复读取失败前也必须立即移除目标并维持其余四张顺序"
      );
      assert.equal(ownerView().total, 4);
      assert.equal(ownerView().ready, 4);

      const recoveryDelays = [100, 500, 1_500] as const;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await settleUntil(() => Boolean(
          pendingRequest(ingestionSnapshotPath, failedReleaseRecoveryStart)
        ));
        const failedRecoverySnapshot = pendingRequest(
          ingestionSnapshotPath,
          failedReleaseRecoveryStart
        )!;
        await React.act(async () => {
          failedRecoverySnapshot.resolve(new Response(JSON.stringify({
            ok: false,
            error: `controlled resolved-release recovery failure ${attempt + 1}`,
            details: {}
          }), {
            status: 500,
            headers: { "content-type": "application/json" }
          }));
          await Promise.resolve();
        });
        const retryDelay = recoveryDelays[attempt];
        if (retryDelay !== undefined) {
          await React.act(async () => {
            await clock.advanceBy(retryDelay);
          });
        }
      }
      await settleUntil(() => ownerView().status === "error");
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        failedReleaseRemainingImageIds,
        "恢复读取最终失败时只允许暂时过滤 retained 旧基线"
      );
      assert.equal(ownerView().total, 4);
      assert.equal(ownerView().ready, 4);

      await React.act(async () => {
        ownerRoot.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: false })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "idle");
      assert.equal(ownerSource.closed, true);
      assert.equal(ControlledEventSource.active.size, 0);

      const reopenedOwnerSourceStart = ControlledEventSource.all.length;
      const reopenedOwnerSnapshotStart = requests.length;
      await React.act(async () => {
        ownerRoot.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: true })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => (
        ControlledEventSource.all.length === reopenedOwnerSourceStart + 1
      ));
      const reopenedOwnerSource = ControlledEventSource.all.at(-1)!;
      await React.act(async () => {
        reopenedOwnerSource.emit("ready", {
          type: "ready",
          queue: "upload",
          revision: 6,
          action_scope: "scope-owner-resolved-release-reopened"
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, reopenedOwnerSnapshotStart)
      ));
      const reopenedOwnerSnapshot = pendingRequest(
        ingestionSnapshotPath,
        reopenedOwnerSnapshotStart
      )!;
      const reopenedOwnerUrl = new URL(
        reopenedOwnerSnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(reopenedOwnerSnapshot, {
          queue: "upload",
          revision: 6,
          last_accepted_order: 16,
          offset: Number(reopenedOwnerUrl.searchParams.get("offset")),
          limit: Number(reopenedOwnerUrl.searchParams.get("limit")),
          total: 5,
          unfinished: 5,
          waiting: 0,
          running: 0,
          ready: 5,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: afterAbsentReleaseImageIds.map((imageId) => ({
            ...serverItem(
              "ready",
              3,
              10 + visibleReadyReleaseImageIds.indexOf(imageId),
              imageId
            ),
            session_id: visibleReadyReleaseSessionIds[
              visibleReadyReleaseImageIds.indexOf(imageId)
            ],
            last_semantic_revision: 6
          })),
          action_watermark: "watermark-resolved-release-reopened"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().visible.length === 5
      ));
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        afterAbsentReleaseImageIds,
        "关闭后重新打开必须清除失败恢复过滤并接受新权威快照"
      );
      assert.equal(ownerView().total, 5);
      assert.equal(ownerView().ready, 5);

      const clearedCompletedSessionId = "N".repeat(43);
      const clearedCompletedImageId =
        "019f8457-063a-7046-a580-7a432dc7fd8e";
      const retainedCompletedSessionId = "O".repeat(43);
      const retainedCompletedImageId =
        "019f8457-063a-7047-a580-7a432dc7fd8e";
      const browserCompletedSessionId = "R".repeat(43);
      const browserCompletedImageId =
        "019f8457-063a-7048-a580-7a432dc7fd8e";
      const ownerCompletedItem = (
        sessionId: string,
        imageId: string,
        revision: number,
        acceptedOrder: number
      ) => ({
        session_id: sessionId,
        image_id: imageId,
        queue: "upload" as const,
        status: "completed" as const,
        version: 3,
        progress_seq: 0,
        last_semantic_revision: revision,
        accepted_at: 1,
        accepted_order: acceptedOrder,
        completed_at: 2,
        completed_item: adminImageListItem({ id: imageId })
      });
      const completedCleanupBaselineStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, completedCleanupBaselineStart)
      ));
      const completedCleanupBaseline = pendingRequest(
        ingestionSnapshotPath,
        completedCleanupBaselineStart
      )!;
      const completedCleanupBaselineUrl = new URL(
        completedCleanupBaseline.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(completedCleanupBaseline, {
          queue: "upload",
          revision: 7,
          last_accepted_order: 19,
          offset: Number(
            completedCleanupBaselineUrl.searchParams.get("offset")
          ),
          limit: Number(
            completedCleanupBaselineUrl.searchParams.get("limit")
          ),
          total: 3,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 3,
          failed: 0,
          items: [
            ownerCompletedItem(
              clearedCompletedSessionId,
              clearedCompletedImageId,
              7,
              17
            ),
            ownerCompletedItem(
              retainedCompletedSessionId,
              retainedCompletedImageId,
              8,
              18
            ),
            ownerCompletedItem(
              browserCompletedSessionId,
              browserCompletedImageId,
              9,
              19
            )
          ],
          action_watermark: "watermark-before-completed-cleanup"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().visible.length === 3
      ));
      await React.act(async () => {
        markOwnerCompletedBrowserOwned!(browserCompletedImageId);
        await Promise.resolve();
      });
      assert.ok(ownerView().visible.some((job) => (
        job.id === browserCompletedImageId
      )));

      const completedCleanupRecoveryStart = requests.length;
      let completedCleanupRecovery!: Promise<void>;
      const completedCleanupResult: IngestionQueueActionResultDto = {
        processed: 3,
        changed: 2,
        failed: 0,
        items: [{
          session_id: clearedCompletedSessionId,
          image_id: clearedCompletedImageId,
          status: "changed"
        }, {
          session_id: retainedCompletedSessionId,
          image_id: retainedCompletedImageId,
          status: "skipped",
          code: "ingestion_action_state_changed",
          message: "任务在操作确认后已发生变化"
        }, {
          session_id: browserCompletedSessionId,
          image_id: browserCompletedImageId,
          status: "changed"
        }]
      };
      await React.act(async () => {
        assert.equal(
          projectOwnerCompletedCleanupBatch!(completedCleanupResult),
          2
        );
        await Promise.resolve();
      });
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        [retainedCompletedImageId],
        "逐批成功投影必须先移除同 pair 的 Server 与浏览器展示卡片"
      );
      assert.equal(
        requests.length,
        completedCleanupRecoveryStart,
        "逐批展示投影本身不得为每个 continuation 启动权威读取"
      );
      await React.act(async () => {
        completedCleanupRecovery = recoverOwnerAfterSuccessfulAction!(
          completedCleanupResult
        );
        await Promise.resolve();
      });
      assert.equal(ownerView().status, "loading");
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        [retainedCompletedImageId],
        "动作后权威恢复期间必须继续保留逐批成功投影和边界外任务"
      );
      await settleUntil(() => Boolean(
        pendingRequest(ingestionSnapshotPath, completedCleanupRecoveryStart)
      ));
      const completedCleanupRecoverySnapshot = pendingRequest(
        ingestionSnapshotPath,
        completedCleanupRecoveryStart
      )!;
      assert.equal(
        requests.filter((request, index) => (
          index >= completedCleanupRecoveryStart
          && new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        1,
        "组合投影释放与 raw baseline 失效必须复用一个 post-action snapshot"
      );
      const completedCleanupRecoveryUrl = new URL(
        completedCleanupRecoverySnapshot.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(completedCleanupRecoverySnapshot, {
          queue: "upload",
          revision: 8,
          last_accepted_order: 18,
          offset: Number(
            completedCleanupRecoveryUrl.searchParams.get("offset")
          ),
          limit: Number(
            completedCleanupRecoveryUrl.searchParams.get("limit")
          ),
          total: 1,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 1,
          failed: 0,
          items: [ownerCompletedItem(
            retainedCompletedSessionId,
            retainedCompletedImageId,
            8,
            18
          )],
          action_watermark: "watermark-after-completed-cleanup"
        });
        await completedCleanupRecovery;
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.deepEqual(
        ownerView().visible.map((job) => job.id),
        [retainedCompletedImageId]
      );
      assert.deepEqual(
        requests.filter((request) => !request.aborted && !request.resolved)
          .map((request) => new URL(
            request.url,
            "https://imageshow.test"
          ).pathname),
        [],
        "23 项离页完成回归开始前不得遗留权威读取"
      );

      assert.ok(prepareOffPageCompletionBatch);
      let projectedRetainedCleanup = 0;
      await React.act(async () => {
        projectedRetainedCleanup = projectOwnerCompletedCleanupBatch!({
          processed: 1,
          changed: 1,
          failed: 0,
          items: [{
            session_id: retainedCompletedSessionId,
            image_id: retainedCompletedImageId,
            status: "changed"
          }]
        });
        await Promise.resolve();
      });
      assert.equal(projectedRetainedCleanup, 1);
      const offPageBaselineRequestStart = requests.length;
      await React.act(async () => {
        prepareOffPageCompletionBatch!();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(ownerView().page, 1);
      assert.equal(ownerView().offPageCompletionOwners, 23);
      await settleUntil(() => Boolean(pendingRequest(
        ingestionSnapshotPath,
        offPageBaselineRequestStart
      )));
      const offPageBaselineRequest = pendingRequest(
        ingestionSnapshotPath,
        offPageBaselineRequestStart
      )!;
      const offPageBaselineUrl = new URL(
        offPageBaselineRequest.url,
        "https://imageshow.test"
      );
      await React.act(async () => {
        respond(offPageBaselineRequest, {
          queue: "upload",
          revision: 42,
          last_accepted_order: 42,
          offset: Number(offPageBaselineUrl.searchParams.get("offset")),
          limit: Number(offPageBaselineUrl.searchParams.get("limit")),
          total: 23,
          unfinished: 23,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 23,
          resolving: 0,
          completed: 0,
          failed: 0,
          items: offPageCompletionImageIds.slice(0, 20).map((itemImageId, index) => ({
            session_id: offPageCompletionSessionIds[index],
            image_id: itemImageId,
            queue: "upload",
            source_type: "upload",
            resolved_image_time: "2026-08-23T01:02:03.456Z",
            status: "committing",
            phase: "committing",
            message: "提交中",
            progress: 100,
            version: 5,
            progress_seq: 0,
            last_semantic_revision: 42,
            accepted_at: 1,
            accepted_order: 20 + index,
            metadata: ingestionJob().draft,
            storage_slug: "local"
          })),
          action_watermark: "watermark-off-page-committing-baseline"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().revision === 42
        && ownerView().total === 23
      ));
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before 23 off-page completions"
      });
      const invalidationsBeforeOffPageCompletion = adminImageInvalidations;
      const offPageCompletionRequestStart = requests.length;
      const offPageCompletionBaseRevision = ownerView().revision ?? 0;
      const currentOwnerSource = [...ControlledEventSource.active].at(-1);
      assert.ok(currentOwnerSource);
      await React.act(async () => {
        offPageCompletionImageIds.forEach((completedImageId, index) => {
          const completedCount = index + 1;
          currentOwnerSource.emit("mutation", {
            type: "mutation",
            queue: "upload",
            kind: "semantic",
            revision: offPageCompletionBaseRevision + index + 1,
            last_accepted_order: 42,
            summary: {
              total: 23,
              unfinished: 23 - completedCount,
              waiting: 0,
              running: 0,
              ready: 0,
              duplicate_pending: 0,
              committing: 23 - completedCount,
              resolving: 0,
              completed: completedCount,
              failed: 0
            },
            session: index === 22
              ? {
                  session_id: offPageCompletionSessionIds[index],
                  image_id: completedImageId,
                  status: "completed",
                  version: 6,
                  progress_seq: 0,
                  last_semantic_revision:
                    offPageCompletionBaseRevision + index + 1,
                  accepted_at: 1,
                  accepted_order: 20 + index
                }
              : {
                  session_id: offPageCompletionSessionIds[index],
                  image_id: completedImageId,
                  queue: "upload",
                  status: "completed",
                  version: 6,
                  progress_seq: 0,
                  last_semantic_revision:
                    offPageCompletionBaseRevision + index + 1,
                  accepted_at: 1,
                  accepted_order: 20 + index,
                  completed_at: 2,
                  display: {
                    source_type: "upload",
                    batch_position: index,
                    original_width: 1600,
                    original_height: 900,
                    original_size: 1,
                    quality: 80,
                    transcoded: false
                  },
                  completed_item: adminImageListItem({
                    id: completedImageId,
                    title: `off-page-completed-${index}`
                  })
                },
            action_watermark: `watermark-off-page-completed-${index}`
          });
        });
        // Replaying the last semantic frame models an SSE reconnect overlap.
        currentOwnerSource.emit("mutation", {
          type: "mutation",
          queue: "upload",
          kind: "semantic",
          revision: offPageCompletionBaseRevision + 23,
          last_accepted_order: 42,
          summary: {
            total: 23,
            unfinished: 0,
            waiting: 0,
            running: 0,
            ready: 0,
            duplicate_pending: 0,
            committing: 0,
            resolving: 0,
            completed: 23,
            failed: 0
          },
          session: {
            session_id: offPageCompletionSessionIds[22],
            image_id: offPageCompletionImageIds[22],
            status: "completed",
            version: 6,
            progress_seq: 0,
            last_semantic_revision: offPageCompletionBaseRevision + 23,
            accepted_at: 1,
            accepted_order: 42
          },
          action_watermark: "watermark-off-page-completed-22"
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(ownerView().offPageCompletionOwners, 23);
      assert.equal(ownerView().offPageCompletionDone, 23);
      assert.equal(ownerView().total, 23, JSON.stringify(ownerView()));
      assert.equal(ownerView().totalPages, 2, JSON.stringify(ownerView()));
      await settleUntil(() => Boolean(pendingRequest(
        ingestionStatusPath,
        offPageCompletionRequestStart
      )));
      const compactCompletedStatusRequest = pendingRequest(
        ingestionStatusPath,
        offPageCompletionRequestStart
      )!;
      assert.deepEqual(
        JSON.parse(String(compactCompletedStatusRequest.init.body)),
        { items: [{
          session_id: offPageCompletionSessionIds[22],
          image_id: offPageCompletionImageIds[22]
        }] },
        "compact completed 只应按精确 pair 进入既有有界 status owner"
      );
      assert.equal(
        requests.slice(offPageCompletionRequestStart).filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        0,
        "compact 离页完成事件不得触发重复分页请求"
      );
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeOffPageCompletion,
        "compact DTO 未水合时应保留同批唯一图库失效边界"
      );
      await React.act(async () => {
        respond(compactCompletedStatusRequest, {
          items: [{
            session_id: offPageCompletionSessionIds[22],
            image_id: offPageCompletionImageIds[22],
            status: "completed",
            completed_item: adminImageListItem({
              id: offPageCompletionImageIds[22],
              title: "off-page-completed-22"
            }),
            display: {
              source_type: "upload",
              batch_position: 22,
              original_width: 1600,
              original_height: 900,
              original_size: 1,
              quality: 80,
              transcoded: false
            },
            redis_status: "completed",
            redis_version: 6,
            redis_last_semantic_revision:
              offPageCompletionBaseRevision + 23
          }]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        adminImageInvalidations === invalidationsBeforeOffPageCompletion + 1
      ));
      assert.ok(
        revokedObjectUrls.includes("blob:off-page-completion-preview"),
        "compact 离页完成水合后也必须回收原本地预览 URL"
      );
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeOffPageCompletion + 1,
        "23 项完成与重连重放只能产生一次图库查询失效"
      );

      const secondPageFirstRenderRequestStart = requests.length;
      await React.act(async () => {
        setOwnerPage!(2);
        await Promise.resolve();
      });
      assert.equal(ownerView().page, 2);
      assert.deepEqual(
        ownerView().visible.slice(0, 3),
        offPageCompletionImageIds.slice(20).map((id) => ({
          id,
          status: "done"
        })),
        "切换第二页后的首次渲染必须在分页响应前直接显示最终状态"
      );
      await settleUntil(() => Boolean(pendingRequest(
        ingestionSnapshotPath,
        secondPageFirstRenderRequestStart
      )));
      const secondPageSnapshot = pendingRequest(
        ingestionSnapshotPath,
        secondPageFirstRenderRequestStart
      )!;
      const secondPageSnapshotUrl = new URL(
        secondPageSnapshot.url,
        "https://imageshow.test"
      );
      assert.equal(secondPageSnapshot.resolved, false);
      await React.act(async () => {
        respond(secondPageSnapshot, {
          queue: "upload",
          revision: offPageCompletionBaseRevision + 23,
          last_accepted_order: 42,
          offset: Number(secondPageSnapshotUrl.searchParams.get("offset")),
          limit: Number(secondPageSnapshotUrl.searchParams.get("limit")),
          total: 23,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 23,
          failed: 0,
          items: offPageCompletionImageIds.slice(20).map((completedImageId, offset) => ({
            session_id: offPageCompletionSessionIds[20 + offset],
            image_id: completedImageId,
            queue: "upload",
            status: "completed",
            version: 6,
            progress_seq: 0,
            last_semantic_revision:
              offPageCompletionBaseRevision + 21 + offset,
            accepted_at: 1,
            accepted_order: 40 + offset,
            completed_at: 2,
            display: {
              source_type: "upload",
              batch_position: 20 + offset,
              original_width: 1600,
              original_height: 900,
              original_size: 1,
              quality: 80,
              transcoded: false
            },
            completed_item: adminImageListItem({ id: completedImageId })
          })),
          action_watermark: "watermark-off-page-completed-stable"
        });
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "ready");
      assert.equal(ownerView().offPageCompletionOwners, 23);
      assert.equal(ownerView().offPageCompletionDone, 23);
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeOffPageCompletion + 1,
        "分页水合与完成重放不得重复失效"
      );

      const compactChunkBaselineRequestStart = requests.length;
      await React.act(async () => {
        refreshOwner!();
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionSnapshotPath,
        compactChunkBaselineRequestStart
      )));
      const compactChunkBaselineRequest = pendingRequest(
        ingestionSnapshotPath,
        compactChunkBaselineRequestStart
      )!;
      const compactChunkBaselineUrl = new URL(
        compactChunkBaselineRequest.url,
        "https://imageshow.test"
      );
      const compactChunkBaselineRevision = (ownerView().revision ?? 0) + 1;
      const compactChunkLastAcceptedOrder = 144;
      const compactChunkActiveItem = (index: number) => ({
        session_id: compactChunkFailureSessionIds[index],
        image_id: compactChunkFailureImageIds[index],
        queue: "upload" as const,
        source_type: "upload" as const,
        resolved_image_time: "2026-08-23T01:02:03.456Z",
        status: "committing" as const,
        phase: "committing",
        message: "提交中",
        progress: 100,
        version: 5,
        progress_seq: 0,
        last_semantic_revision: compactChunkBaselineRevision,
        accepted_at: 1,
        accepted_order: 43 + index,
        metadata: ingestionJob().draft,
        storage_slug: "local"
      });
      await React.act(async () => {
        respond(compactChunkBaselineRequest, {
          queue: "upload",
          revision: compactChunkBaselineRevision,
          last_accepted_order: compactChunkLastAcceptedOrder,
          offset: Number(compactChunkBaselineUrl.searchParams.get("offset")),
          limit: Number(compactChunkBaselineUrl.searchParams.get("limit")),
          total: 125,
          unfinished: 102,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 102,
          resolving: 0,
          completed: 23,
          failed: 0,
          items: [
            ...offPageCompletionImageIds.slice(20).map((completedImageId, offset) => ({
              session_id: offPageCompletionSessionIds[20 + offset],
              image_id: completedImageId,
              queue: "upload" as const,
              status: "completed" as const,
              version: 6,
              progress_seq: 0,
              last_semantic_revision:
                offPageCompletionBaseRevision + 21 + offset,
              accepted_at: 1,
              accepted_order: 40 + offset,
              completed_at: 2,
              completed_item: adminImageListItem({ id: completedImageId })
            })),
            ...compactChunkFailureImageIds.slice(0, 20).map((_imageId, index) => (
              compactChunkActiveItem(index)
            ))
          ],
          action_watermark: "watermark-compact-chunk-failure-baseline"
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        ownerView().status === "ready"
        && ownerView().revision === compactChunkBaselineRevision
        && ownerView().total === 125
      ));
      const compactChunkRetainedJobCount = ownerView().jobCount;
      queryClient.setQueryData(queryKeys.adminImages, {
        cached: "before compact chunk failure"
      });
      const invalidationsBeforeCompactChunkFailure = adminImageInvalidations;
      const compactChunkHydrationStart = requests.length;
      const compactCompletedStatus = (index: number) => ({
        session_id: compactChunkFailureSessionIds[index],
        image_id: compactChunkFailureImageIds[index],
        status: "completed" as const,
        completed_item: adminImageListItem({
          id: compactChunkFailureImageIds[index],
          title: `compact-chunk-completed-${index}`
        }),
        redis_status: "completed" as const,
        redis_version: 6,
        redis_last_semantic_revision:
          compactChunkBaselineRevision + index + 1
      });
      const compactCompletedMutation = (index: number) => {
        const completedCount = index + 1;
        return {
          type: "mutation" as const,
          queue: "upload" as const,
          kind: "semantic" as const,
          revision: compactChunkBaselineRevision + completedCount,
          last_accepted_order: compactChunkLastAcceptedOrder,
          summary: {
            total: 125,
            unfinished: 102 - completedCount,
            waiting: 0,
            running: 0,
            ready: 0,
            duplicate_pending: 0,
            committing: 102 - completedCount,
            resolving: 0,
            completed: 23 + completedCount,
            failed: 0
          },
          session: {
            session_id: compactChunkFailureSessionIds[index],
            image_id: compactChunkFailureImageIds[index],
            status: "completed" as const,
            version: 6,
            progress_seq: 0,
            last_semantic_revision:
              compactChunkBaselineRevision + completedCount,
            accepted_at: 1,
            accepted_order: 43 + index
          },
          action_watermark: `watermark-compact-chunk-completed-${index}`
        };
      };
      await React.act(async () => {
        for (let index = 0; index < 101; index += 1) {
          currentOwnerSource.emit(
            "mutation",
            compactCompletedMutation(index)
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionStatusPath,
        compactChunkHydrationStart
      )));
      const compactChunkFirstRequest = pendingRequest(
        ingestionStatusPath,
        compactChunkHydrationStart
      )!;
      const compactChunkFirstPairs = JSON.parse(String(
        compactChunkFirstRequest.init.body
      )).items as Array<{ image_id: string }>;
      assert.deepEqual(
        compactChunkFirstPairs.map((pair) => pair.image_id),
        compactChunkFailureImageIds.slice(0, 100),
        "compact status owner 首批必须保持 100 项硬上限"
      );
      await React.act(async () => {
        respond(compactChunkFirstRequest, {
          items: Array.from(
            { length: 100 },
            (_value, index) => compactCompletedStatus(index)
          )
        });
        await Promise.resolve();
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionStatusPath,
        compactChunkHydrationStart
      )));
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      const compactChunkRequests = requests.slice(compactChunkHydrationStart)
        .filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionStatusPath
        ));
      assert.equal(
        compactChunkRequests.length,
        2,
        "成功首批后只能由下一任 effect 对未解决尾部发起一次请求"
      );
      assert.equal(
        compactChunkRequests.some((request) => request.aborted),
        false,
        "正常跨批水合不得先中止再重复请求同一尾部"
      );
      const compactChunkFailedSecondRequest = pendingRequest(
        ingestionStatusPath,
        compactChunkHydrationStart
      )!;
      assert.deepEqual(
        JSON.parse(String(compactChunkFailedSecondRequest.init.body)).items,
        [{
          session_id: compactChunkFailureSessionIds[100],
          image_id: compactChunkFailureImageIds[100]
        }]
      );
      await React.act(async () => {
        compactChunkFailedSecondRequest.resolve(new Response(JSON.stringify({
          ok: false,
          error: "controlled compact second chunk failure",
          details: {}
        }), {
          status: 500,
          headers: { "content-type": "application/json" }
        }));
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().serverNotice.includes(
        "controlled compact second chunk failure"
      ));
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompactChunkFailure,
        "后续 chunk 失败前不得丢失或部分落实先前 compact 水合结果"
      );
      assert.equal(
        ownerView().jobCount,
        compactChunkRetainedJobCount,
        "未知 compact pair 不得挂载额外卡片"
      );
      assert.equal(
        ownerView().compactChunkHydrated,
        17,
        "首个成功 chunk 必须在后续 chunk 失败前完整落实 retained 卡片"
      );

      const compactChunkRetryStart = requests.length;
      await React.act(async () => {
        currentOwnerSource.emit(
          "mutation",
          compactCompletedMutation(101)
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await settleUntil(() => Boolean(pendingRequest(
        ingestionStatusPath,
        compactChunkRetryStart
      )));
      const compactChunkRetryFirstRequest = pendingRequest(
        ingestionStatusPath,
        compactChunkRetryStart
      )!;
      assert.deepEqual(
        (JSON.parse(String(
          compactChunkRetryFirstRequest.init.body
        )).items as Array<{ image_id: string }>)
          .map((pair) => pair.image_id),
        compactChunkFailureImageIds.slice(100),
        "后续事件触发重试时只能读取前一失败 pair 与新 compact pair"
      );
      await React.act(async () => {
        respond(compactChunkRetryFirstRequest, {
          items: [compactCompletedStatus(100), compactCompletedStatus(101)]
        });
        await Promise.resolve();
      });
      await settleUntil(() => (
        adminImageInvalidations
          >= invalidationsBeforeCompactChunkFailure + 1
      ));
      assert.equal(
        adminImageInvalidations,
        invalidationsBeforeCompactChunkFailure + 1,
        "失败重试后的全部 compact 完成只能合并为一次图库失效"
      );
      assert.equal(ownerView().jobCount, compactChunkRetainedJobCount);
      const compactReplayStart = requests.length;
      await React.act(async () => {
        currentOwnerSource.emit(
          "mutation",
          compactCompletedMutation(101)
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      assert.equal(
        requests.length,
        compactReplayStart,
        "未知 compact pair 完成水合后，SSE 重放不得再次读取 status"
      );
      assert.equal(
        requests.slice(compactChunkHydrationStart).filter((request) => (
          new URL(request.url, "https://imageshow.test").pathname
            === ingestionSnapshotPath
        )).length,
        0,
        "未知 compact 水合与失败重试不得追加分页 snapshot"
      );

      await React.act(async () => {
        ownerRoot.render(withQueryClient(
          React.createElement(OwnerProbe, { displayed: false })
        ));
        await Promise.resolve();
      });
      await settleUntil(() => ownerView().status === "idle");
      assert.equal(reopenedOwnerSource.closed, true);
      assert.equal(ControlledEventSource.active.size, 0);
        }
      );
    } finally {
      await React.act(async () => {
        root.unmount();
        ownerRoot.unmount();
        if (!strictRootUnmounted) strictRoot.unmount();
        if (!emptyRootUnmounted) emptyRoot.unmount();
      });
      unsubscribeQueryEvents();
      queryClient.clear();
    }
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 全队列动作冻结水位并以同一 action ID 有界续传", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requests: Array<Record<string, unknown>> = [];
    let fetchCalls = 0;
    let refreshes = 0;
    const observedActionCompleted: string[] = [];
    const actionCompletedItem = adminImageListItem({
      id: "019f8457-063a-7001-a580-7a432dc7fd8e"
    });
    const connectionHold = { current: false };
    const fetchStub = async (_path: string, init?: RequestInit) => {
      assert.equal(
        connectionHold.current,
        true,
        "continuation 执行期间必须持有当前 owner 状态通道"
      );
    fetchCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if (fetchCalls === 1) {
      return new Response("upstream response lost", { status: 502 });
    }
    if (body.action === "clear_completed") {
      return new Response(JSON.stringify({
        ok: true,
        processed: 0,
        changed: 0,
        failed: 0,
        items: []
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    const continuation = body.continuation;
    const skipped = Boolean(continuation);
    return new Response(JSON.stringify({
      ok: true,
      processed: 1,
      changed: skipped ? 0 : 1,
      failed: 0,
      items: [{
        session_id: continuation ? "B".repeat(43) : "A".repeat(43),
        image_id: continuation
          ? "019f8457-063a-7002-a580-7a432dc7fd8e"
          : "019f8457-063a-7001-a580-7a432dc7fd8e",
        status: skipped ? "skipped" : "changed",
        ...(continuation ? {} : { completed_item: actionCompletedItem })
      }],
      ...(continuation ? {} : { continuation: "signed-next-cursor" })
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { useIngestionQueueActions } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts"
    );
    const server = {
      status: "ready",
      actionScope: "S".repeat(32),
      actionWatermark: "frozen-watermark",
      lastAcceptedOrder: 120,
      connectionGeneration: 7,
      refresh: () => { refreshes += 1; },
      recoverAuthority: async () => { refreshes += 1; }
    };
    let actions: ReturnType<typeof useIngestionQueueActions> | undefined;
    function Probe() {
      actions = useIngestionQueueActions(
        "upload",
        server as never,
        connectionHold,
        (entries) => {
          assert.equal(refreshes, 0, "完成 DTO 必须在动作刷新前交给 owner");
          observedActionCompleted.push(...entries.map(({ pair }) => pair.image_id));
        }
      );
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.ok(actions);
    const originalDateNow = Date.now;
    let frozen: ReturnType<typeof actions.freeze>;
    let laterFrozen: ReturnType<typeof actions.freeze>;
    try {
      Date.now = () => 1_700_000_000_000;
      frozen = actions.freeze("apply_metadata", { title: "全部标题" });
      laterFrozen = actions.freeze("apply_metadata", { title: "稍后标题" });
    } finally {
      Date.now = originalDateNow;
    }
    assert.ok(frozen);
    assert.ok(laterFrozen);
    assert.ok(
      frozen.actionRequestId < laterFrozen.actionRequestId,
      "同毫秒冻结的新动作必须取得更大的 UUIDv7 序值"
    );
    assert.equal(frozen.actionWatermark, "frozen-watermark");
    let result: Awaited<ReturnType<typeof actions.run>> | undefined;
    let queuedResult: Awaited<ReturnType<typeof actions.run>> | undefined;
    let queuedRun: ReturnType<typeof actions.run> | undefined;
    let preflightHeld = false;
    let overlappingFrozen: ReturnType<typeof actions.freeze> | undefined;
    await React.act(async () => {
      result = await actions!.run(frozen, async () => {
        preflightHeld = connectionHold.current;
        overlappingFrozen = actions!.freeze("clear_completed");
        assert.ok(overlappingFrozen);
        queuedRun = actions!.run(overlappingFrozen);
        await Promise.resolve();
      });
      queuedResult = await queuedRun;
    });
    assert.equal(preflightHeld, true, "动作前置草稿排空也必须保持 SSE");
    assert.ok(overlappingFrozen, "在途阶段仍须冻结点击时的第二个队列动作");
    assert.notEqual(
      overlappingFrozen.actionRequestId,
      frozen.actionRequestId,
      "排队动作必须使用独立幂等 ID"
    );
    assert.deepEqual(queuedResult && {
      processed: queuedResult.processed,
      changed: queuedResult.changed,
      failed: queuedResult.failed
    }, { processed: 0, changed: 0, failed: 0 });
    assert.equal(connectionHold.current, false);
    assert.deepEqual(result && {
      processed: result.processed,
      changed: result.changed,
      failed: result.failed
    }, { processed: 2, changed: 1, failed: 0 });
    assert.equal(
      actions.notice,
      "",
      "只有状态变化而无真实失败时不得显示协议动作汇总"
    );
    assert.equal(fetchCalls, 4);
    assert.equal(refreshes, 0, "成功动作由 SSE 收敛，不得追加同页快照");
    assert.deepEqual(
      observedActionCompleted,
      [actionCompletedItem.id],
      "页外清理动作返回的完成 DTO 必须进入 owner 失效入口"
    );
    assert.equal(requests[0]?.action_request_id, frozen.actionRequestId);
    assert.equal(requests[1]?.action_request_id, frozen.actionRequestId);
    assert.equal(requests[2]?.action_request_id, frozen.actionRequestId);
    assert.equal(
      requests[3]?.action_request_id,
      overlappingFrozen.actionRequestId,
      "第二个动作必须等首个动作完整续传后再执行"
    );
    assert.equal(requests[0]?.action_watermark, "frozen-watermark");
    assert.equal(requests[1]?.continuation, undefined);
    assert.equal(requests[2]?.continuation, "signed-next-cursor");
    assert.deepEqual(requests[0], requests[1], "网络重试必须复用首批完整请求");

    const nonBlockingFrozen = actions.freeze(
      "apply_metadata",
      { title: "不阻塞输入框" }
    );
    assert.ok(nonBlockingFrozen);
    let releaseNonBlockingPreflight!: () => void;
    const nonBlockingPreflight = new Promise<void>((resolve) => {
      releaseNonBlockingPreflight = resolve;
    });
    let nonBlockingRun!: ReturnType<typeof actions.run>;
    await React.act(async () => {
      nonBlockingRun = actions!.run(
        nonBlockingFrozen,
        () => nonBlockingPreflight,
        { blockUi: false }
      );
      await Promise.resolve();
    });
    assert.equal(connectionHold.current, true);
    assert.equal(
      actions.busy,
      false,
      "应用默认值的后台持久化不得禁用整窗卡片控件"
    );
    await React.act(async () => {
      releaseNonBlockingPreflight();
      await nonBlockingRun;
    });
    assert.equal(connectionHold.current, false);
    assert.equal(actions.busy, false);

    server.status = "loading";
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      actions.freeze("commit_ready"),
      null,
      "只读保留页不得复用旧水位，也不得在未来快照上扩大动作范围"
    );
    server.status = "ready";
    server.actionScope = "T".repeat(32);
    server.actionWatermark = "reconnected-watermark";
    server.connectionGeneration = 8;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const reconnected = actions.freeze("commit_ready");
    assert.ok(reconnected);
    assert.equal(reconnected.actionScope, "T".repeat(32));
    assert.equal(reconnected.actionWatermark, "reconnected-watermark");
    server.connectionGeneration = 9;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      assert.equal(await actions!.run(reconnected), null);
    });
    assert.equal(refreshes, 1, "动作失败仍须请求一次权威收敛");
    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 失效动作凭证先恢复 CSRF 再按 owner 刷新权威水位", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requestOrder: string[] = [];
  let actionRequests = 0;
  let uploadSnapshotRequests = 0;
  let importSnapshotRequests = 0;
  let authRecoveries = 0;
  let ordinaryRefreshes = 0;
  const fetchStub = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "https://imageshow.test");
    const csrf = new Headers(init.headers).get("x-csrf-token") ?? "";
    if (url.pathname === ingestionActionPath) {
      actionRequests += 1;
      requestOrder.push(`action:${csrf}`);
      return new Response(JSON.stringify({
        ok: false,
        code: "invalid_ingestion_token",
        error: "内容接入凭证已过期或时间无效"
      }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.pathname === ingestionSnapshotPath) {
      const queue = url.searchParams.get("queue");
      if (queue === "upload") uploadSnapshotRequests += 1;
      else importSnapshotRequests += 1;
      requestOrder.push(`snapshot:${queue}:${csrf}`);
      return new Response(JSON.stringify({
        ok: true,
        queue,
        revision: 2,
        last_accepted_order: 0,
        offset: Number(url.searchParams.get("offset")),
        limit: Number(url.searchParams.get("limit")),
        total: 0,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0,
        items: [],
        stale_items: [],
        action_watermark: "fresh-upload-watermark"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected request: ${url.pathname}`);
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    setCsrfToken("expired-csrf");
    const { createRoot } = await import("react-dom/client");
    const { useIngestionQueueActions } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts"
    );
    const uploadServer = {
      status: "ready",
      actionScope: "U".repeat(32),
      actionWatermark: "expired-upload-watermark",
      connectionGeneration: 1,
      refresh: () => { ordinaryRefreshes += 1; },
      recoverAuthority: async () => {
        const snapshot = await getIngestionQueueSnapshot({
          queue: "upload",
          offset: 0,
          limit: 20,
          exclude_items: [],
          include_items: []
        }, uploadServer.actionScope);
        uploadServer.actionWatermark = snapshot.action_watermark;
      }
    };
    const importServer = {
      ...uploadServer,
      actionScope: "I".repeat(32),
      actionWatermark: "untouched-import-watermark",
      recoverAuthority: async () => {
        importSnapshotRequests += 1;
      }
    };
    const recoverAuthSession = async () => {
      authRecoveries += 1;
      requestOrder.push("auth");
      setCsrfToken("current-csrf");
    };
    let uploadActions: ReturnType<typeof useIngestionQueueActions> | undefined;
    let importActions: ReturnType<typeof useIngestionQueueActions> | undefined;
    function Probe() {
      uploadActions = useIngestionQueueActions(
        "upload",
        uploadServer as never,
        { current: false },
        () => undefined,
        recoverAuthSession
      );
      importActions = useIngestionQueueActions(
        "import",
        importServer as never,
        { current: false },
        () => undefined,
        recoverAuthSession
      );
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const currentUploadActions = uploadActions!;
    const frozen = currentUploadActions.freeze("commit_ready");
    assert.ok(frozen);
    let result: Awaited<ReturnType<typeof currentUploadActions.run>> | undefined;
    await React.act(async () => {
      result = await currentUploadActions.run(frozen);
    });
    assert.equal(result, null);
    assert.equal(actionRequests, 1, "失效凭证不得自动重放原动作");
    assert.equal(authRecoveries, 1);
    assert.equal(uploadSnapshotRequests, 1);
    assert.equal(importSnapshotRequests, 0, "upload 恢复不得刷新 import owner");
    assert.equal(ordinaryRefreshes, 0, "凭证恢复不得抢先发出旧 CSRF snapshot");
    assert.deepEqual(requestOrder, [
      "action:expired-csrf",
      "auth",
      "snapshot:upload:current-csrf"
    ]);
    assert.equal(uploadServer.actionWatermark, "fresh-upload-watermark");
    assert.equal(uploadActions!.notice, "", "新权威 snapshot 后应清除旧凭证提示");
    assert.equal(importActions!.notice, "");
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 应用到全部在默认空主题下发送规范化稀疏 metadata", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const actionBodies: Array<Record<string, unknown>> = [];
  let appliedDefaults: Record<string, unknown> | undefined;
  let refreshes = 0;
  let postActionRecoveries = 0;
  let authRecoveries = 0;
  let nextActionResponseGate: Promise<void> | null = null;
  let nextAuthorityRecoveryGate: Promise<void> | null = null;
  const postActionConnectionHolds: boolean[] = [];
  const recoveryConnectionHolds: boolean[] = [];
  let pendingDraftUpdates = false;
    let pendingAuthorityHandoff = false;
    let draftFlushes = 0;
    let doneSignals = 0;
    let actionFailureMode = false;
    let completedActionResponseHandler: ((
      body: Record<string, unknown>
    ) => Response | Promise<Response>) | null = null;
    const projectedCompletedCleanupImageIds: string[] = [];
    const locallyCommittedJobs: string[] = [];
    const clearedJobIds: string[] = [];
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    assert.equal(path, ingestionActionPath);
    const actionBody = JSON.parse(
      String(init.body)
    ) as Record<string, unknown>;
    actionBodies.push(actionBody);
    const responseGate = nextActionResponseGate;
    if (responseGate) {
      nextActionResponseGate = null;
      await responseGate;
    }
    if (actionFailureMode) {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: "temporary_failure", message: "temporary failure" }
      }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
    if (
      actionBody.action === "clear_completed"
      && completedActionResponseHandler
    ) return completedActionResponseHandler(actionBody);
    return new Response(JSON.stringify({
      ok: true,
      processed: 0,
      changed: 0,
      failed: 0,
      items: []
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    setCsrfToken("apply-defaults-token");
    const { createRoot } = await import("react-dom/client");
    const { useIngestionQueueActions } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts"
    );
    const { useIngestionQueueWorkflowActions } = await import(
      "../../../packages/web/src/pages/admin/ingestion/workflow/useIngestionQueueWorkflowActions.ts"
    );
    const localJob = ingestionJob({
      id: "apply-defaults-local",
      attemptKey: "apply-defaults-attempt",
      status: "queued",
      serverAccepted: false
    });
    const jobsRef = { current: [localJob] };
    const connectionHold = { current: false };
    const recoverFakeAuthority = async () => {
      refreshes += 1;
      recoveryConnectionHolds.push(connectionHold.current);
      const recoveryGate = nextAuthorityRecoveryGate;
      if (recoveryGate) {
        nextAuthorityRecoveryGate = null;
        await recoveryGate;
      }
    };
    const server = {
      status: "ready",
      actionScope: "A".repeat(32),
      actionWatermark: "apply-defaults-watermark",
      connectionGeneration: 1,
      recoverAfterSuccessfulAction: async () => {
        postActionRecoveries += 1;
        postActionConnectionHolds.push(connectionHold.current);
        await recoverFakeAuthority();
      },
      recoverAuthority: recoverFakeAuthority,
      refresh: () => { refreshes += 1; }
    };
    const recoverAuthSession = async () => {
      authRecoveries += 1;
    };
    let workflow: ReturnType<typeof useIngestionQueueWorkflowActions> | undefined;
    function Probe() {
      const actions = useIngestionQueueActions(
        "upload",
        server as never,
        connectionHold,
        () => undefined,
        recoverAuthSession
      );
      workflow = useIngestionQueueWorkflowActions({
        queue: {
          queueType: "upload",
          localJobs: jobsRef.current,
          jobsRef,
          pendingAuthorityHandoff,
          summary: { unfinishedCount: 1, doneJobs: 0 },
          actions,
          server,
          appendJobs: () => true,
          captureBrowserActionJobs: (predicate: (job: IngestionJob) => boolean) => (
            jobsRef.current.filter(predicate)
          ),
          clearJobIds: (ids: ReadonlySet<string>) => {
            clearedJobIds.push(...ids);
            jobsRef.current = jobsRef.current.filter((job) => !ids.has(job.id));
          },
          releaseResolvedServerJobs: () => new Set<string>(),
          projectCompletedCleanupBatch: (result: IngestionQueueActionResultDto) => {
            const successful = result.items.filter((item) => (
              item.status === "changed" || item.status === "unchanged"
            ));
            projectedCompletedCleanupImageIds.push(...successful.map(
              (item) => item.image_id
            ));
            return successful.length;
          },
          recoverAfterSuccessfulAction: server.recoverAfterSuccessfulAction,
          applyDefaultsToLocalJobs: (defaults: Record<string, unknown>) => {
            appliedDefaults = defaults;
          },
          flushPendingUpdates: async () => {
            draftFlushes += 1;
            pendingDraftUpdates = false;
          },
          hasPendingDraftUpdates: () => pendingDraftUpdates
        } as never,
        defaults: {
          device: "auto",
          brightness: "auto",
          theme: "",
          author: "",
          tags: []
        },
        cancelJobs: async () => new Map(),
        commitJobs: async (jobs) => {
          draftFlushes += 1;
          pendingDraftUpdates = false;
          locallyCommittedJobs.push(...jobs.map((job) => job.id));
          return jobs.length > 0;
        },
        onDone: () => { doneSignals += 1; }
      });
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      workflow!.applyDefaultsToQueue();
      for (let attempt = 0; attempt < 20 && !actionBodies.length; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    const actionBody = actionBodies[0];
    assert.ok(actionBody);
    assert.equal(actionBody.action, "apply_metadata");
    assert.deepEqual(actionBody.metadata, {
      device: "auto",
      brightness: "auto"
    });
    assert.equal("theme" in (actionBody.metadata as object), false);
    assert.equal("author" in (actionBody.metadata as object), false);
    assert.equal("tags" in (actionBody.metadata as object), false);
    assert.deepEqual(appliedDefaults, {
      device: "auto",
      brightness: "auto",
      theme: "",
      author: "",
      tags: []
    });
    assert.equal(connectionHold.current, false);
    assert.equal(refreshes, 0);

    const draftFlushesBeforeLocalOnlyDefaults = draftFlushes;
    Object.assign(server, {
      summary: {
        total: 0,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      workflow!.applyDefaultsToQueue();
      await Promise.resolve();
    });
    assert.equal(
      actionBodies.length,
      1,
      "权威摘要已知为空时，纯本地默认值更新不得发送空 Server 动作"
    );
    assert.equal(
      draftFlushes,
      draftFlushesBeforeLocalOnlyDefaults + 1,
      "纯本地默认值更新仍须排空可能存在的逐项草稿写回"
    );
    assert.equal(refreshes, 0, "纯本地动作不应触发无意义的队列重读");

    const draftFlushesBeforeCommit = draftFlushes;
    pendingDraftUpdates = true;
    pendingAuthorityHandoff = true;
    jobsRef.current = [{ ...localJob, status: "ready" }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const actionsBeforePendingApply = actionBodies.length;
    const refreshesBeforePendingApply = refreshes;
    const draftFlushesBeforePendingApply = draftFlushes;
    await React.act(async () => {
      workflow!.applyDefaultsToQueue();
      await Promise.resolve();
    });
    assert.equal(
      actionBodies.length,
      actionsBeforePendingApply,
      "交接期间的本地精确集合不得伪造新的 Server 水位动作"
    );
    assert.equal(refreshes, refreshesBeforePendingApply);
    assert.equal(
      draftFlushes,
      draftFlushesBeforePendingApply + 1,
      "交接期间点击应用到全部必须立即处理点击时捕获的精确任务"
    );
    await React.act(async () => {
      workflow!.commitReadyJobs();
      for (let attempt = 0; attempt < 20 && actionBodies.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(actionBodies.length, 1);
    assert.equal(
      draftFlushes,
      draftFlushesBeforeCommit + 2,
      "应用与提交都必须由点击时冻结的逐项 owner 真正受理"
    );
    assert.deepEqual(locallyCommittedJobs, [localJob.id]);
    assert.equal(connectionHold.current, false);
    assert.equal(refreshes, 0);

    server.status = "loading";
    server.actionScope = "";
    server.actionWatermark = "";
    jobsRef.current = [{
      ...localJob,
      id: "local-ready-without-watermark",
      attemptKey: "local-ready-without-watermark-attempt",
      status: "ready"
    }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      workflow!.commitReadyJobs();
      await Promise.resolve();
    });
    assert.equal(actionBodies.length, 1, "无签名水位时不得补冻全队列动作");
    assert.deepEqual(
      locallyCommittedJobs,
      [localJob.id],
      "首个 Server 摘要未知时不得把未恢复队列误判为空并部分提交本地任务"
    );
    assert.equal(doneSignals, 1);

    Object.assign(server, {
      revision: 117,
      summary: {
        total: 1,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 1,
        failed: 0
      }
    });
    jobsRef.current = [{
      ...localJob,
      id: "local-completed-at-close",
      attemptKey: "local-completed-at-close-attempt",
      status: "done"
    }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      workflow!.runCleanupAction("completed");
      workflow!.runCleanupAction("completed");
      await Promise.resolve();
    });
    assert.equal(actionBodies.length, 1);
    assert.equal(
      connectionHold.current,
      true,
      "关闭瞬间重连时必须在后台保留唯一队列连接直至清理收敛"
    );
    Object.assign(server, { status: "error" });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      connectionHold.current,
      false,
      "后台重连进入错误态后必须释放连接占用，同时保留冻结的清理意图"
    );
    completedActionResponseHandler = () => new Response(JSON.stringify({
      ok: true,
      processed: 1,
      changed: 1,
      failed: 0,
      items: [{
        session_id: "D".repeat(43),
        image_id: "019f8457-063a-70a1-a580-7a432dc7fd8e",
        status: "changed"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    Object.assign(server, {
      status: "ready",
      actionScope: "B".repeat(32),
      actionWatermark: "reconnected-close-cleanup-watermark",
      connectionGeneration: 2
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      for (let attempt = 0; attempt < 20 && actionBodies.length < 2; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(actionBodies[1]?.action, "clear_completed");
    assert.equal(
      actionBodies.filter((body) => body.action === "clear_completed").length,
      1,
      "同一队列与关闭水位的 completed 清理必须合并为单次动作"
    );
    assert.equal(
      actionBodies[1]?.max_semantic_revision,
      117,
      "重连后的关闭清理必须沿用关闭前最后权威 semantic revision"
    );
    assert.equal(connectionHold.current, false);
    assert.equal(doneSignals, 2);
    assert.equal(postActionRecoveries, 1);
    assert.equal(
      postActionConnectionHolds.at(-1),
      true,
      "延迟清理成功后启动动作后收敛时必须仍持有队列连接"
    );
    completedActionResponseHandler = null;

    const failedDeferredActionStart = actionBodies.length;
    const failedDeferredRefreshStart = refreshes;
    actionFailureMode = true;
    Object.assign(server, {
      status: "loading",
      actionScope: "",
      actionWatermark: "",
      revision: 118,
      summary: {
        total: 1,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 1,
        failed: 0
      }
    });
    jobsRef.current = [{
      ...localJob,
      id: "local-completed-before-action-failure",
      attemptKey: "local-completed-before-action-failure-attempt",
      status: "done"
    }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      workflow!.runCleanupAction("completed");
      await Promise.resolve();
    });
    Object.assign(server, {
      status: "ready",
      actionScope: "C".repeat(32),
      actionWatermark: "failed-close-cleanup-watermark",
      connectionGeneration: 3
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      for (
        let attempt = 0;
        attempt < 20 && actionBodies.length < failedDeferredActionStart + 2;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(
      actionBodies.length,
      failedDeferredActionStart + 2,
      "延迟清理的 5xx 只能使用动作客户端自身的两次有界重试"
    );
    assert.equal(connectionHold.current, false);
    const failedDeferredActionSettled = actionBodies.length;
    const failedDeferredRefreshSettled = refreshes;
    assert.equal(
      failedDeferredRefreshSettled,
      failedDeferredRefreshStart + 2,
      "冻结清理只允许一次准入刷新和一次失败后的权威刷新"
    );
    await React.act(async () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        root.render(React.createElement(Probe));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(
      actionBodies.length,
      failedDeferredActionSettled,
      "同一 connection/revision 不得自激重发延迟清理"
    );
    assert.equal(
      refreshes,
      failedDeferredRefreshSettled,
      "同一失败 authority 不得形成 snapshot 尾随循环"
    );
    assert.equal(
      postActionRecoveries,
      1,
      "清理动作没有成功时不得启动成功后的收敛"
    );
    Object.assign(server, {
      actionWatermark: "freshly-signed-same-revision-watermark"
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      actionBodies.length,
      failedDeferredActionSettled,
      "同 revision 的新签名 watermark 不能被误认成新的队列 authority"
    );
    actionFailureMode = false;
    Object.assign(server, {
      actionWatermark: "revision-advanced-close-cleanup-watermark",
      revision: 119
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      for (
        let attempt = 0;
        attempt < 20 && (
          actionBodies.length < failedDeferredActionSettled + 1
          || doneSignals < 3
        );
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(
      actionBodies.length,
      failedDeferredActionSettled + 1,
      "同一 connection 内 semantic revision 推进后必须恰好恢复一次"
    );
    assert.equal(actionBodies.at(-1)?.max_semantic_revision, 118);
    assert.equal(
      doneSignals,
      2,
      "失败前已清理的本地卡片与零变更 Server 重试不应重复发送完成通知"
    );

    const completedAtCloseRequest = ingestionJob({
      ...localJob,
      id: "completed-at-close-request",
      attemptKey: "completed-at-close-request-attempt",
      status: "done"
    });
    const completedDuringExit = ingestionJob({
      ...localJob,
      id: "completed-during-close-exit",
      attemptKey: "completed-during-close-exit-attempt",
      status: "done"
    });
    jobsRef.current = [completedAtCloseRequest];
    Object.assign(server, {
      status: "ready",
      actionWatermark: "close-request-watermark",
      revision: 120,
      summary: {
        total: 1,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 1,
        failed: 0
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const closeActionStart = actionBodies.length;
    const closeClearStart = clearedJobIds.length;
    const closeRecoveryStart = postActionRecoveries;
    completedActionResponseHandler = () => new Response(JSON.stringify({
      ok: true,
      processed: 1,
      changed: 1,
      failed: 0,
      items: [{
        session_id: "E".repeat(43),
        image_id: "019f8457-063a-70a2-a580-7a432dc7fd8e",
        status: "changed"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    let releaseActionResponse!: () => void;
    let releaseAuthorityRecovery!: () => void;
    nextActionResponseGate = new Promise<void>((resolve) => {
      releaseActionResponse = resolve;
    });
    nextAuthorityRecoveryGate = new Promise<void>((resolve) => {
      releaseAuthorityRecovery = resolve;
    });
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      jobsRef.current = [...jobsRef.current, completedDuringExit];
      Object.assign(server, {
        actionWatermark: "after-close-request-watermark",
        revision: 121,
        summary: {
          total: 2,
          unfinished: 0,
          waiting: 0,
          running: 0,
          ready: 0,
          duplicate_pending: 0,
          committing: 0,
          resolving: 0,
          completed: 2,
          failed: 0
        }
      });
      root.render(React.createElement(Probe));
      for (
        let attempt = 0;
        attempt < 20 && actionBodies.length < closeActionStart + 1;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(
      postActionRecoveries,
      closeRecoveryStart,
      "动作响应尚未成功时允许快速重开看到尚未清理的旧卡片"
    );
    assert.equal(
      connectionHold.current,
      true,
      "异步清理在慢响应期间必须保留唯一连接且不得阻塞关闭"
    );
    await React.act(async () => {
      releaseActionResponse();
      for (
        let attempt = 0;
        attempt < 20 && postActionRecoveries === closeRecoveryStart;
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(postActionRecoveries, closeRecoveryStart + 1);
    assert.equal(
      connectionHold.current,
      true,
      "动作成功后必须持有连接直至权威快照收敛"
    );
    assert.equal(postActionConnectionHolds.at(-1), true);
    assert.equal(recoveryConnectionHolds.at(-1), true);
    await React.act(async () => {
      releaseAuthorityRecovery();
      for (let attempt = 0; attempt < 20 && connectionHold.current; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(connectionHold.current, false);
    assert.equal(
      actionBodies[closeActionStart]?.action_watermark,
      "close-request-watermark",
      "关闭请求必须立即复用清理动作并冻结当时的 Server 水位"
    );
    assert.deepEqual(
      clearedJobIds.slice(closeClearStart),
      [completedAtCloseRequest.id],
      "退场期间才完成的浏览器任务不得进入关闭请求的精确清理集合"
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [completedDuringExit.id]
    );
    completedActionResponseHandler = null;

    const pagedSuccessFirstImageId =
      "019f8457-063a-70b1-a580-7a432dc7fd8e";
    const pagedSuccessSecondImageId =
      "019f8457-063a-70b2-a580-7a432dc7fd8e";
    let releasePagedSuccessSecond!: () => void;
    const pagedSuccessSecondGate = new Promise<void>((resolve) => {
      releasePagedSuccessSecond = resolve;
    });
    let pagedSuccessSecondStarted = false;
    completedActionResponseHandler = async (body) => {
      if (!body.continuation) {
        return new Response(JSON.stringify({
          ok: true,
          processed: 100,
          changed: 1,
          failed: 0,
          items: [{
            session_id: "F".repeat(43),
            image_id: pagedSuccessFirstImageId,
            status: "changed"
          }],
          continuation: "completed-page-two-success"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      pagedSuccessSecondStarted = true;
      await pagedSuccessSecondGate;
      return new Response(JSON.stringify({
        ok: true,
        processed: 1,
        changed: 1,
        failed: 0,
        items: [{
          session_id: "G".repeat(43),
          image_id: pagedSuccessSecondImageId,
          status: "changed"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    };
    jobsRef.current = [];
    Object.assign(server, {
      status: "ready",
      actionScope: "F".repeat(32),
      actionWatermark: "paged-success-watermark",
      connectionGeneration: 4,
      revision: 122,
      summary: {
        total: 101,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 101,
        failed: 0
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const pagedSuccessProjectionStart =
      projectedCompletedCleanupImageIds.length;
    const pagedSuccessRecoveryStart = postActionRecoveries;
    const pagedSuccessDoneStart = doneSignals;
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      for (let attempt = 0; attempt < 20 && !pagedSuccessSecondStarted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(pagedSuccessSecondStarted, true);
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedSuccessProjectionStart),
      [pagedSuccessFirstImageId],
      "第二批慢响应期间，首批成功 pair 必须已经同步进入展示释放投影"
    );
    assert.equal(
      postActionRecoveries,
      pagedSuccessRecoveryStart,
      "continuation 尚未结束时不得抢先把首批快照当作完整动作证明"
    );
    await React.act(async () => {
      releasePagedSuccessSecond();
      for (
        let attempt = 0;
        attempt < 30 && (
          connectionHold.current
          || postActionRecoveries === pagedSuccessRecoveryStart
        );
        attempt += 1
      ) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedSuccessProjectionStart),
      [pagedSuccessFirstImageId, pagedSuccessSecondImageId]
    );
    assert.equal(postActionRecoveries, pagedSuccessRecoveryStart + 1);
    assert.equal(doneSignals, pagedSuccessDoneStart + 1);
    assert.equal(connectionHold.current, false);

    const pagedFailureFirstImageId =
      "019f8457-063a-70b3-a580-7a432dc7fd8e";
    let releasePagedFailureSecond!: () => void;
    const pagedFailureSecondGate = new Promise<void>((resolve) => {
      releasePagedFailureSecond = resolve;
    });
    let pagedFailureContinuationCalls = 0;
    completedActionResponseHandler = async (body) => {
      if (!body.continuation) {
        return new Response(JSON.stringify({
          ok: true,
          processed: 100,
          changed: 1,
          failed: 0,
          items: [{
            session_id: "H".repeat(43),
            image_id: pagedFailureFirstImageId,
            status: "changed"
          }],
          continuation: "completed-page-two-failure"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      pagedFailureContinuationCalls += 1;
      await pagedFailureSecondGate;
      return new Response(JSON.stringify({
        ok: false,
        error: {
          code: "temporary_failure",
          message: "controlled second page failure"
        }
      }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    };
    Object.assign(server, {
      actionScope: "G".repeat(32),
      actionWatermark: "paged-failure-watermark",
      connectionGeneration: 5,
      revision: 123
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const pagedFailureActionStart = actionBodies.length;
    const pagedFailureProjectionStart =
      projectedCompletedCleanupImageIds.length;
    const pagedFailureRecoveryStart = postActionRecoveries;
    const pagedFailureRefreshStart = refreshes;
    const pagedFailureDoneStart = doneSignals;
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      for (
        let attempt = 0;
        attempt < 20 && pagedFailureContinuationCalls === 0;
        attempt += 1
      ) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(pagedFailureContinuationCalls, 1);
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedFailureProjectionStart),
      [pagedFailureFirstImageId],
      "后续批失败前，首批成功证据也不得停留在动作聚合器里"
    );
    await React.act(async () => {
      releasePagedFailureSecond();
      for (
        let attempt = 0;
        attempt < 30 && (
          connectionHold.current
          || pagedFailureContinuationCalls < 2
        );
        attempt += 1
      ) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      actionBodies.length,
      pagedFailureActionStart + 3,
      "第二批失败只允许沿用 continuation 做两次有界请求"
    );
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedFailureProjectionStart),
      [pagedFailureFirstImageId],
      "后续批最终失败不得撤销首批已成功 pair 的展示投影"
    );
    assert.equal(postActionRecoveries, pagedFailureRecoveryStart + 1);
    assert.equal(
      refreshes,
      pagedFailureRefreshStart + 1,
      "部分成功后的 owner 恢复必须取代普通失败恢复，不能发两条快照链"
    );
    assert.equal(doneSignals, pagedFailureDoneStart + 1);
    assert.equal(connectionHold.current, false);

    const pagedAuthFirstImageId =
      "019f8457-063a-70b4-a580-7a432dc7fd8e";
    let pagedAuthContinuationCalls = 0;
    completedActionResponseHandler = (body) => {
      if (!body.continuation) {
        return new Response(JSON.stringify({
          ok: true,
          processed: 100,
          changed: 1,
          failed: 0,
          items: [{
            session_id: "J".repeat(43),
            image_id: pagedAuthFirstImageId,
            status: "changed"
          }],
          continuation: "completed-page-two-invalid-token"
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      pagedAuthContinuationCalls += 1;
      return new Response(JSON.stringify({
        ok: false,
        code: "invalid_ingestion_token",
        error: "内容接入凭证已过期或时间无效"
      }), {
        status: 401,
        headers: { "content-type": "application/json" }
      });
    };
    Object.assign(server, {
      actionScope: "H".repeat(32),
      actionWatermark: "paged-invalid-token-watermark",
      connectionGeneration: 6,
      revision: 124
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const pagedAuthActionStart = actionBodies.length;
    const pagedAuthProjectionStart =
      projectedCompletedCleanupImageIds.length;
    const pagedAuthRecoveryStart = postActionRecoveries;
    const pagedAuthRefreshStart = refreshes;
    const pagedAuthSessionStart = authRecoveries;
    const pagedAuthDoneStart = doneSignals;
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      for (
        let attempt = 0;
        attempt < 30 && (
          connectionHold.current
          || authRecoveries === pagedAuthSessionStart
        );
        attempt += 1
      ) await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      actionBodies.length,
      pagedAuthActionStart + 2,
      "失效 continuation 不得重放已执行的动作批次"
    );
    assert.equal(pagedAuthContinuationCalls, 1);
    assert.equal(authRecoveries, pagedAuthSessionStart + 1);
    assert.deepEqual(
      projectedCompletedCleanupImageIds.slice(pagedAuthProjectionStart),
      [pagedAuthFirstImageId],
      "续页凭证失效不得撤销首批已成功 pair 的展示投影"
    );
    assert.equal(postActionRecoveries, pagedAuthRecoveryStart + 1);
    assert.equal(
      refreshes,
      pagedAuthRefreshStart + 1,
      "登录恢复后必须由部分成功动作接管唯一 post-action snapshot"
    );
    assert.equal(doneSignals, pagedAuthDoneStart + 1);
    assert.equal(connectionHold.current, false);
    completedActionResponseHandler = null;

    jobsRef.current = [];
    Object.assign(server, {
      status: "loading",
      actionScope: "",
      actionWatermark: "",
      summary: {
        total: 1,
        unfinished: 1,
        waiting: 0,
        running: 0,
        ready: 1,
        duplicate_pending: 1,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const actionsBeforeUnavailableActions = actionBodies.length;
    const refreshesBeforeUnavailableActions = refreshes;
    let cleanupArmed: boolean | { readonly count: number } = true;
    let clearQueueArmed = true;
    await React.act(async () => {
      workflow!.commitReadyJobs();
      workflow!.runCleanupAction("duplicates");
      cleanupArmed = workflow!.armCleanupAction("uncommitted");
      clearQueueArmed = workflow!.armClearQueue();
      await Promise.resolve();
    });
    assert.equal(actionBodies.length, actionsBeforeUnavailableActions);
    assert.equal(cleanupArmed, false);
    assert.equal(clearQueueArmed, false);
    assert.equal(
      refreshes,
      refreshesBeforeUnavailableActions + 4,
      "只有旧展示而没有签名水位时必须重取权威，不能静默执行部分 Server 动作"
    );
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] ready 草稿串行写回并以语义 no-op 收敛响应丢失", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requests: Array<Record<string, unknown>> = [];
  let fetchCalls = 0;
  const observedDraftCompleted: string[] = [];
  let releaseThird: (() => void) | undefined;
  let markThirdStarted: (() => void) | undefined;
  let releaseLateGeneration: (() => void) | undefined;
  let markLateGenerationStarted: (() => void) | undefined;
  const thirdStarted = new Promise<void>((resolve) => {
    markThirdStarted = resolve;
  });
  const thirdGate = new Promise<void>((resolve) => {
    releaseThird = resolve;
  });
  const lateGenerationStarted = new Promise<void>((resolve) => {
    markLateGenerationStarted = resolve;
  });
  const lateGenerationGate = new Promise<void>((resolve) => {
    releaseLateGeneration = resolve;
  });
  const fetchStub = async (_path: string, init?: RequestInit) => {
    fetchCalls += 1;
    const path = String(_path);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if (fetchCalls === 1) {
      return new Response("upstream response lost", { status: 503 });
    }
    if (fetchCalls === 3) {
      markThirdStarted?.();
      await thirdGate;
    }
    if (fetchCalls === 8) {
      markLateGenerationStarted?.();
      await lateGenerationGate;
    }
    if (fetchCalls === 9 || fetchCalls === 10) {
      return new Response("draft service unavailable", { status: 503 });
    }
    if (fetchCalls === 11) {
      assert.equal(path, ingestionStatusPath);
      const pair = (body.items as Array<Record<string, unknown>>)[0]!;
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: pair.session_id,
          image_id: pair.image_id,
          status: "present",
          item: {
            session_id: pair.session_id,
            image_id: pair.image_id,
            queue: "upload",
            source_type: "upload",
            resolved_image_time: "2026-08-23T01:02:03.456Z",
            status: "ready",
            phase: "ready",
            message: "ready",
            version: 2,
            progress_seq: 0,
            last_semantic_revision: 2,
            accepted_at: 1,
            accepted_order: 1,
            metadata: ingestionJob().draft,
            storage_slug: "local"
          }
        }]
      }), { status: 200 });
    }
    if (fetchCalls === 13) {
      assert.equal(path, ingestionStatusPath);
      const pair = (body.items as Array<Record<string, unknown>>)[0]!;
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: pair.session_id,
          image_id: pair.image_id,
          status: "completed",
          completed_item: adminImageListItem({ id: String(pair.image_id) }),
          redis_status: "missing"
        }]
      }), { status: 200 });
    }
    const item = (body.items as Array<Record<string, unknown>>)[0]!;
    const version = fetchCalls === 2 ? 2 : fetchCalls === 3 ? 3 : 4;
    return new Response(JSON.stringify({
      ok: true,
      items: [{
        session_id: item.session_id,
        image_id: item.image_id,
        status: fetchCalls === 2 ? "unchanged" : "changed",
        version,
        last_semantic_revision: version,
        duplicate_count: 0,
        duplicate_decision: "upload"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { reduceIngestionQueue } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts"
    );
    const { useStoredIngestionDraftSync } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const sessionId = "D".repeat(43);
    const imageId = "019f8457-063a-7004-a580-7a432dc7fd8e";
    let state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    const jobsRef = { current: state.jobs };
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      if (next === state) return false;
      state = next;
      jobsRef.current = next.jobs;
      return true;
    };
    const errors: string[] = [];
    const ensuredRevisions: Array<{
      revision?: number;
      connectionGeneration?: number;
    }> = [];
    let authorityRecoveries = 0;
    const server = {
      status: "ready",
      revision: 100,
      connectionGeneration: 1,
      items: [] as Array<Record<string, unknown>>,
      ensureRevision(revision?: number, connectionGeneration?: number) {
        if (connectionGeneration !== server.connectionGeneration) return false;
        ensuredRevisions.push({ revision, connectionGeneration });
        return true;
      },
      async recoverAuthority() { authorityRecoveries += 1; },
      refresh() {}
    };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: server as never,
        reportError: (message) => errors.push(message),
        observeCompletedIngestions: (entries) => {
          observedDraftCompleted.push(...entries.map(({ pair }) => pair.image_id));
        }
      });
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.ok(sync);
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "响应丢失仍保留" });
      await sync!.flushPendingUpdates();
    });
    assert.equal(fetchCalls, 2);
    assert.deepEqual(requests[0], requests[1], "响应丢失必须重放同一草稿写入");
    assert.equal(jobsRef.current[0]?.serverVersion, 2);
    assert.equal(jobsRef.current[0]?.draft.title, "响应丢失仍保留");
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);

    let flush: Promise<void> | undefined;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "第一版" });
      flush = sync!.flushPendingUpdates();
      await thirdStarted;
    });
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "等待期间的新版本" });
    });
    await React.act(async () => {
      releaseThird?.();
      await flush;
    });
    const thirdItem = (requests[2]?.items as Array<Record<string, unknown>>)[0]!;
    const fourthItem = (requests[3]?.items as Array<Record<string, unknown>>)[0]!;
    assert.equal(thirdItem.expected_version, 2);
    assert.equal((thirdItem.metadata as Record<string, unknown>).title, "第一版");
    assert.equal(fourthItem.expected_version, 3);
    assert.equal(
      (fourthItem.metadata as Record<string, unknown>).title,
      "等待期间的新版本"
    );
    assert.equal(jobsRef.current[0]?.serverVersion, 4);
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);
    assert.deepEqual(errors, []);

    server.revision = 3;
    state = { page: 1, jobs: [ingestionJob()] };
    jobsRef.current = state.jobs;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "接管前冻结的草稿" });
    });
    assert.equal(fetchCalls, 4, "本地 placeholder 不应提前发草稿请求");
    assert.equal(jobsRef.current[0]?.serverDraftPending, true);
    await React.act(async () => {
      dispatch({
        type: "bind-server",
        id: "job-1",
        binding: {
          sessionId,
          imageId,
          serverAccepted: true,
          serverVersion: 1,
          status: "queued"
        }
      });
      const detached = jobsRef.current[0]!;
      state = { page: 2, jobs: [] };
      jobsRef.current = state.jobs;
      sync!.ensureJobSnapshot(detached);
      root.render(React.createElement(Probe));
      await sync!.flushPendingUpdates();
    });
    assert.equal(fetchCalls, 5);
    const fencedItem = (
      requests[4]?.items as Array<Record<string, unknown>>
    )[0]!;
    assert.equal(
      (fencedItem.metadata as Record<string, unknown>).title,
      "接管前冻结的草稿"
    );
    assert.equal(
      sync!.hasPendingUpdates(),
      true,
      "页外 accepted canonical 必须由 owner 继续持有草稿 revision 围栏"
    );
    server.revision = 4;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(sync!.hasPendingUpdates(), false);

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "翻页后仍须写回" });
    });
    state = { page: 2, jobs: [] };
    jobsRef.current = state.jobs;
    await React.act(async () => {
      await sync!.flushPendingUpdates();
    });
    assert.equal(fetchCalls, 6, "pending sync 必须独立持有离页任务快照");
    const offPageItem = (
      requests[5]?.items as Array<Record<string, unknown>>
    )[0]!;
    assert.equal(offPageItem.session_id, sessionId);
    assert.equal(offPageItem.image_id, imageId);
    assert.equal(
      (offPageItem.metadata as Record<string, unknown>).title,
      "翻页后仍须写回"
    );

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    server.revision = 3;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "等待旧连接 revision" });
      await sync!.flushPendingUpdates();
    });
    assert.equal(sync!.hasPendingUpdates(), true);
    assert.equal(jobsRef.current[0]?.serverDraftPending, true);
    server.connectionGeneration = 2;
    server.revision = 0;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      sync!.hasPendingUpdates(),
      false,
      "新连接的权威空基线不得永远等待旧 Redis revision"
    );
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    server.connectionGeneration = 2;
    server.revision = 0;
    const ensuredBeforeLateGeneration = ensuredRevisions.length;
    const recoveriesBeforeLateGeneration = authorityRecoveries;
    let lateGenerationFlush: Promise<void> | undefined;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "请求期间连接换代" });
      lateGenerationFlush = sync!.flushPendingUpdates();
      await lateGenerationStarted;
    });
    server.connectionGeneration = 3;
    server.revision = 0;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      releaseLateGeneration?.();
      await lateGenerationFlush;
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(fetchCalls, 8);
    assert.equal(
      ensuredRevisions.length,
      ensuredBeforeLateGeneration,
      "旧连接的迟到写响应不得把 generation-local revision 交给新连接"
    );
    assert.equal(
      authorityRecoveries,
      recoveriesBeforeLateGeneration + 1,
      "跨连接写响应必须改由触发后的权威 snapshot 收敛"
    );
    assert.equal(
      sync!.hasPendingUpdates(),
      false,
      "旧连接请求的迟到响应不得绑定到新连接空 revision"
    );
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);

    const detachedFailure = ingestionJob({
      id: "detached-draft-failure",
      attemptKey: "detached-draft-failure",
      status: "ready",
      serverAccepted: true,
      serverAcceptedOrder: 1,
      serverVersion: 1,
      serverDraftPending: true,
      sessionId,
      imageId,
      draft: {
        ...ingestionJob().draft,
        title: "连续失败后仍须保留的离页草稿"
      }
    });
    state = { page: 2, jobs: [] };
    jobsRef.current = state.jobs;
    let detachedFailureError: unknown;
    await React.act(async () => {
      sync!.ensureJobSnapshot(detachedFailure);
      try {
        await sync!.flushPendingUpdates();
      } catch (error) {
        detachedFailureError = error;
      }
    });
    assert.ok(detachedFailureError instanceof Error);
    assert.equal(fetchCalls, 10);
    assert.equal(sync!.hasPendingUpdates(), true);
    assert.equal(errors.length, 1);
    await React.act(async () => {
      assert.equal(await sync!.retryPendingUpdates(), true);
    });
    assert.equal(fetchCalls, 12);
    const retriedDetachedItem = (
      requests[11]?.items as Array<Record<string, unknown>>
    )[0]!;
    assert.equal(retriedDetachedItem.expected_version, 2);
    assert.equal(
      (retriedDetachedItem.metadata as Record<string, unknown>).title,
      "连续失败后仍须保留的离页草稿"
    );
    assert.equal(sync!.hasPendingUpdates(), true);
    server.revision = 4;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(sync!.hasPendingUpdates(), false);

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    server.revision = 5;
    server.items = [{
      session_id: sessionId,
      image_id: imageId,
      queue: "upload",
      source_type: "upload",
      resolved_image_time: "2026-08-23T01:02:03.456Z",
      status: "committing",
      phase: "committing",
      message: "另一设备已冻结提交",
      progress: 100,
      version: 2,
      progress_seq: 0,
      last_semantic_revision: 5,
      accepted_at: 1,
      accepted_order: 1,
      metadata: {
        ...ingestionJob().draft,
        title: "另一设备已冻结的权威草稿"
      },
      storage_slug: "local"
    }];
    let frozenDraftError: unknown;
    const previousErrorCount = errors.length;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "尚未写入的本地草稿" });
      state = {
        ...state,
        jobs: [{
          ...jobsRef.current[0]!,
          status: "committing",
          serverStatus: "committing"
        }]
      };
      jobsRef.current = state.jobs;
      assert.equal(sync!.hasPendingUpdates(), true);
      assert.equal(jobsRef.current[0]?.status, "committing");
      root.render(React.createElement(Probe));
      try {
        await sync!.flushPendingUpdates();
      } catch (error) {
        frozenDraftError = error;
      }
    });
    assert.ok(frozenDraftError instanceof Error);
    assert.equal(fetchCalls, 12, "已有 Server DTO 时不得额外逐卡读取草稿");
    assert.equal(errors.length, previousErrorCount + 1);
    assert.match(errors.at(-1) ?? "", /本地草稿未写入/u);
    assert.equal(jobsRef.current[0]?.serverDraftPending, false);
    assert.equal(
      jobsRef.current[0]?.draft.title,
      "另一设备已冻结的权威草稿"
    );
    server.items = [];

    state = {
      page: 1,
      jobs: [ingestionJob({
        status: "ready",
        serverAccepted: true,
        serverAcceptedOrder: 1,
        serverVersion: 1,
        sessionId,
        imageId
      })]
    };
    jobsRef.current = state.jobs;
    let completedDraftError: unknown;
    await React.act(async () => {
      sync!.updateJobDraft("job-1", { title: "完成前尚未写入的草稿" });
      state = {
        ...state,
        jobs: [{
          ...jobsRef.current[0]!,
          status: "committing",
          serverStatus: "committing"
        }]
      };
      jobsRef.current = state.jobs;
      try {
        await sync!.flushPendingUpdates();
      } catch (error) {
        completedDraftError = error;
      }
    });
    assert.ok(completedDraftError instanceof Error);
    assert.deepEqual(
      observedDraftCompleted,
      [imageId],
      "草稿冻结后的 completed status 必须先进入 owner 失效入口"
    );
    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 任务卡片连续文本只在失焦发布一次并围栏旧 incarnation", async (t) => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const clock = installControlledClock(t, window as unknown as Window, {
    minimumControlledDelayMs: 250,
    includeGlobalTimers: true,
    includeDateNow: false
  });
  const React = await import("react");
  const matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  Object.assign(window, {
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    innerWidth: 1280,
    innerHeight: 720
  });
  window.HTMLElement.prototype.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    width: 240,
    height: 32,
    top: 0,
    right: 240,
    bottom: 32,
    left: 0,
    toJSON() { return {}; }
  });
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    ResizeObserver: ResizeObserverStub,
    requestAnimationFrame,
    cancelAnimationFrame,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { IngestionJobCard } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/cards/IngestionJobCard.tsx"
    );
    const initialJob = ingestionJob({
      id: "deferred-card",
      attemptKey: "deferred-attempt",
      status: "ready",
      serverAccepted: true,
      serverVersion: 1,
      sessionId: "T".repeat(43),
      imageId: "019f8457-063a-7004-a580-7a432dc7fd8e"
    });
    const publications: Array<{
      baseline: IngestionJob;
      patch: Partial<IngestionJob["draft"]>;
    }> = [];
    let setHarnessJob: React.Dispatch<React.SetStateAction<IngestionJob>> | undefined;
    let setHarnessBusy: React.Dispatch<React.SetStateAction<boolean>> | undefined;
    function Harness() {
      const [job, setJob] = React.useState(initialJob);
      const [busy, setBusy] = React.useState(false);
      setHarnessJob = setJob;
      setHarnessBusy = setBusy;
      return React.createElement(IngestionJobCard, {
        job,
        busy,
        storageDisplayName: "本地",
        themes: [
          { slug: "existing-theme", display_name: "已有主题" },
          { slug: "new-theme", display_name: "新主题" },
          { slug: "candidate-theme", display_name: "候选主题" }
        ],
        allTags: [],
        authors: [
          { slug: "existing-author", display_name: "已有作者" },
          { slug: "ime-author", display_name: "输入法作者" }
        ],
        onPatch: (current, patch) => {
          publications.push({ baseline: current, patch });
          setJob({ ...current, draft: { ...current.draft, ...patch } });
        },
        onCancel() {},
        onRetry() {},
        onRemove() {},
        onConfirmDuplicate() {},
        onOpenDetail() {},
        onFocusWithin() {},
        onPreview() {}
      });
    }
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    const title = container.querySelector<HTMLInputElement>(
      "input[placeholder='标题']"
    )!;
    for (const value of ["慢", "慢速", "慢速输入"]) {
      await React.act(async () => {
        inputText(window as Window, title, value);
        await clock.advanceBy(250);
      });
    }
    assert.equal(publications.length, 0, "焦点内跨越多个防抖间隔仍不得发布草稿");
    assert.match(
      container.querySelector(".ingestion-job-head strong")?.textContent ?? "",
      /慢速输入/u,
      "卡片标题必须即时显示焦点会话临时值"
    );
    await React.act(async () => {
      setHarnessJob?.((current) => ({
        ...current,
        serverVersion: (current.serverVersion ?? 0) + 1,
        draft: { ...current.draft, title: "同 incarnation 远端标题" }
      }));
      await Promise.resolve();
    });
    assert.match(
      container.querySelector(".ingestion-job-head strong")?.textContent ?? "",
      /慢速输入/u,
      "同 incarnation snapshot 不得覆盖焦点内临时值"
    );
    await React.act(async () => {
      dispatchDomEvent(window as Window, title, "focusout", {
        relatedTarget: document.body
      });
      await Promise.resolve();
    });
    assert.equal(publications.length, 1);
    assert.equal(publications[0]?.baseline.draft.title, "同 incarnation 远端标题");
    assert.deepEqual(publications[0]?.patch, { title: "慢速输入" });

    const noChangeCount = publications.length;
    await React.act(async () => {
      dispatchDomEvent(window as Window, title, "focusin");
      dispatchDomEvent(window as Window, title, "focusout", {
        relatedTarget: document.body
      });
      await Promise.resolve();
    });
    assert.equal(publications.length, noChangeCount, "无变化失焦不得发布草稿");

    const theme = container.querySelector<HTMLInputElement>(
      "input[aria-label$='主题']"
    )!;
    for (const value of ["new", "new-theme"]) {
      await React.act(async () => {
        inputText(window as Window, theme, value);
        await clock.advanceBy(250);
      });
    }
    assert.equal(publications.length, noChangeCount);
    await React.act(async () => {
      dispatchDomEvent(window as Window, theme, "focusout", {
        relatedTarget: document.body
      });
      await Promise.resolve();
    });
    assert.deepEqual(publications.at(-1)?.patch, { theme: "new-theme" });

    const author = container.querySelector<HTMLInputElement>(
      "input[aria-label$='作者']"
    )!;
    const beforeIme = publications.length;
    await React.act(async () => {
      dispatchDomEvent(window as Window, author, "focusin");
      dispatchDomEvent(window as Window, author, "compositionstart");
      inputText(window as Window, author, "ime-author");
      dispatchDomEvent(window as Window, author, "compositionend");
      await Promise.resolve();
    });
    assert.equal(publications.length, beforeIme, "IME 组合期间不得发布草稿");
    await React.act(async () => {
      dispatchDomEvent(window as Window, author, "focusout", {
        relatedTarget: document.body
      });
      await Promise.resolve();
    });
    assert.deepEqual(publications.at(-1)?.patch, { author: "ime-author" });

    const beforeCandidate = publications.length;
    await React.act(async () => {
      inputText(window as Window, theme, "candidate");
      await Promise.resolve();
    });
    await React.act(async () => {
      dispatchDomEvent(window as Window, theme, "keydown", {
        key: "ArrowDown",
        keyCode: 40,
        isComposing: false
      });
      await Promise.resolve();
    });
    await React.act(async () => {
      dispatchDomEvent(window as Window, theme, "keydown", {
        key: "Enter",
        keyCode: 13,
        isComposing: false
      });
      await Promise.resolve();
    });
    assert.equal(
      publications.length,
      beforeCandidate + 1,
      "候选选择必须维持即时离散发布语义"
    );
    assert.deepEqual(publications.at(-1)?.patch, { theme: "candidate-theme" });
    await React.act(async () => {
      dispatchDomEvent(window as Window, theme, "focusout", {
        relatedTarget: document.body
      });
      await Promise.resolve();
    });
    assert.equal(publications.length, beforeCandidate + 1);

    const description = container.querySelector<HTMLTextAreaElement>(
      "textarea[placeholder='详情描述']"
    )!;
    await React.act(async () => {
      inputText(window as Window, description, "冻结前临时描述");
      setHarnessBusy?.(true);
      await Promise.resolve();
    });
    const beforeFrozenBlur = publications.length;
    await React.act(async () => {
      dispatchDomEvent(window as Window, description, "focusout", {
        relatedTarget: document.body
      });
      await Promise.resolve();
    });
    assert.equal(publications.length, beforeFrozenBlur, "失去可编辑资格后不得发布临时值");
    await React.act(async () => setHarnessBusy?.(false));

    const original = container.querySelector<HTMLInputElement>(
      "input[placeholder='原图 URL']"
    )!;
    await React.act(async () => {
      inputText(window as Window, original, "https://local.example/new.jpg");
      setHarnessJob?.((current) => ({
        ...current,
        attemptKey: "replacement-attempt",
        imageId: "019f8457-063a-7004-a580-7a432dc7fd99",
        draft: {
          ...current.draft,
          original: "https://canonical.example/replacement.jpg"
        }
      }));
      await Promise.resolve();
    });
    const beforeReplacementBlur = publications.length;
    await React.act(async () => {
      dispatchDomEvent(window as Window, original, "focusout", {
        relatedTarget: document.body
      });
      await Promise.resolve();
    });
    assert.equal(publications.length, beforeReplacementBlur, "换代后不得写入旧临时值");

    const source = container.querySelector<HTMLInputElement>(
      "input[placeholder='来源 URL']"
    )!;
    await React.act(async () => {
      inputText(window as Window, source, "https://discarded.example/source");
      root.unmount();
      await clock.advanceBy(250);
    });
    assert.equal(publications.length, beforeReplacementBlur, "卡片卸载不得补发临时值");
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 任务卡片慢速键入与 URL 格式校验只产生必要的失焦草稿请求", async (t) => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const clock = installControlledClock(t, window as unknown as Window, {
    minimumControlledDelayMs: 250,
    includeGlobalTimers: true,
    includeDateNow: false
  });
  const React = await import("react");
  let requestCount = 0;
  const requestPaths: string[] = [];
  let version = 1;
  const fetchStub = async (path: string, init?: RequestInit) => {
    requestCount += 1;
    requestPaths.push(path);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const item = (body.items as Array<Record<string, unknown>>)[0]!;
    version += 1;
    return new Response(JSON.stringify({
      ok: true,
      items: [{
        session_id: item.session_id,
        image_id: item.image_id,
        status: "changed",
        version,
        last_semantic_revision: version,
        duplicate_count: 0,
        duplicate_decision: "upload"
      }]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }
  const consoleMessages: string[] = [];
  const previousConsoleInfo = console.info;
  console.info = (...values: unknown[]) => {
    consoleMessages.push(values.map(String).join(" "));
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { reduceIngestionQueue } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts"
    );
    const { useStoredIngestionDraftSync } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const { IngestionJobCard } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/cards/IngestionJobCard.tsx"
    );
    const job = ingestionJob({
      status: "ready",
      serverAccepted: true,
      serverAcceptedOrder: 1,
      serverVersion: 1,
      sessionId: "R".repeat(43),
      imageId: "019f8457-063a-7004-a580-7a432dc7fd8e"
    });
    let state = { page: 1, jobs: [job] };
    const reportedErrors: string[] = [];
    const jobsRef = { current: state.jobs };
    let rerender: () => void = () => {};
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      if (next === state) return false;
      state = next;
      jobsRef.current = next.jobs;
      rerender();
      return true;
    };
    const server = {
      status: "ready",
      revision: 100,
      connectionGeneration: 1,
      items: [],
      ensureRevision() { return true; },
      async recoverAuthority() {},
      refresh() {}
    };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    function Harness() {
      const [, setEpoch] = React.useState(0);
      rerender = () => setEpoch((current) => current + 1);
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: server as never,
        reportError: (message) => reportedErrors.push(message),
        observeCompletedIngestions: () => undefined
      });
      return React.createElement(IngestionJobCard, {
        job: jobsRef.current[0]!,
        busy: false,
        storageDisplayName: "本地",
        themes: [],
        allTags: [],
        authors: [],
        onPatch: (current, patch) => sync!.updateJobDraft(current.id, patch),
        onCancel() {},
        onRetry() {},
        onRemove() {},
        onConfirmDuplicate() {},
        onOpenDetail() {},
        onFocusWithin() {},
        onPreview() {}
      });
    }
    const container = document.getElementById("root")!;
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
    const title = container.querySelector<HTMLInputElement>(
      "input[placeholder='标题']"
    )!;
    for (const value of ["慢", "慢速", "慢速输入"]) {
      await React.act(async () => {
        inputText(window as Window, title, value);
        await clock.advanceBy(250);
      });
    }
    assert.equal(requestCount, 0);
    await React.act(async () => {
      dispatchDomEvent(window as Window, title, "focusout", {
        relatedTarget: document.body
      });
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 1);
    assert.equal(jobsRef.current[0]?.draft.title, "慢速输入");

    await React.act(async () => {
      dispatchDomEvent(window as Window, title, "focusin");
      dispatchDomEvent(window as Window, title, "focusout", {
        relatedTarget: document.body
      });
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 1, "无变化失焦不得产生第二次请求");

    const original = container.querySelector<HTMLInputElement>(
      "input[placeholder='原图 URL']"
    )!;
    await React.act(async () => {
      inputText(
        window as Window,
        original,
        "http://draft-image.invalid/image.jpg"
      );
      dispatchDomEvent(window as Window, original, "focusout", {
        relatedTarget: document.body
      });
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 1, "无效原图 URL 不得进入草稿同步请求");
    assert.equal(reportedErrors.length, 0, "无效 URL 不得进入可见草稿错误入口");
    assert.equal(original.classList.contains("is-changed"), false);
    assert.equal(
      consoleMessages.at(-1),
      "[ImageShow] 内容接入草稿原图 URL 格式无效，未保存"
    );

    await React.act(async () => {
      inputText(window as Window, original, "draft-image.invalid/image.jpg");
      dispatchDomEvent(window as Window, original, "focusout", {
        relatedTarget: document.body
      });
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 2, "不可解析的保留域名仍应按纯格式合法草稿保存");
    assert.equal(requestPaths.every((path) => path === ingestionUpdatePath), true);
    assert.equal(
      jobsRef.current[0]?.draft.original,
      "draft-image.invalid/image.jpg",
      "浏览器校验不得以探测结果改写或拒绝格式合法草稿"
    );

    const source = container.querySelector<HTMLInputElement>(
      "input[placeholder='来源 URL']"
    )!;
    await React.act(async () => {
      inputText(
        window as Window,
        source,
        "https://user:password@example.com/post"
      );
      dispatchDomEvent(window as Window, source, "focusout", {
        relatedTarget: document.body
      });
      await sync!.flushPendingUpdates();
    });
    assert.equal(requestCount, 2, "无效来源 URL 不得进入草稿同步请求");
    assert.equal(reportedErrors.length, 0);
    assert.equal(
      consoleMessages.at(-1),
      "[ImageShow] 内容接入草稿来源 URL 格式无效，未保存"
    );
    await React.act(async () => root.unmount());
  } finally {
    console.info = previousConsoleInfo;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 未接管 placeholder 的草稿 fence 不阻塞 Server 全局动作", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { useStoredIngestionDraftSync } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const jobsRef = { current: [ingestionJob({
      id: "unaccepted-draft-fence",
      serverAccepted: false,
      serverDraftPending: true,
      serverVersion: undefined,
      sessionId: undefined,
      imageId: undefined
    })] };
    const server = {
      status: "ready",
      revision: 1,
      connectionGeneration: 1,
      ensureRevision() { return true; },
      async recoverAuthority() {},
      refresh() {}
    };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch: () => false,
        server: server as never,
        reportError: () => undefined,
        observeCompletedIngestions: () => undefined
      });
      return React.createElement("output", null, String(
        sync.hasPendingUpdates()
      ));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(container.textContent, "false");
    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 离页草稿 owner 可按 session incarnation 静默退休", async (t) => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const clock = installControlledClock(t, window as unknown as Window, {
    minimumControlledDelayMs: 250,
    includeGlobalTimers: true,
    includeDateNow: false
  });
  const React = await import("react");
  let fetchCalls = 0;
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("已退休的离页草稿不得再发送旧 pair 更新");
    },
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { useStoredIngestionDraftSync } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const sessionId = "O".repeat(43);
    const imageId = "019f8457-063a-7040-a580-7a432dc7fd8e";
    const jobsRef = { current: [ingestionJob({
      id: "off-page-draft-owner",
      attemptKey: "off-page-draft-attempt",
      sessionId,
      imageId,
      serverAccepted: true,
      serverVersion: 1,
      status: "ready"
    })] };
    let state = { jobs: jobsRef.current, page: 1 };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      const changed = next !== state;
      state = next;
      jobsRef.current = next.jobs;
      return changed;
    };
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: {
          status: "ready",
          revision: 1,
          connectionGeneration: 1,
          items: [],
          ensureRevision() { return true; },
          async recoverAuthority() {},
          refresh() {}
        } as never,
        reportError: () => undefined,
        observeCompletedIngestions: () => undefined
      });
      return React.createElement(
        "output",
        null,
        String(sync.hasPendingUpdates())
      );
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      sync!.updateJobDraft("off-page-draft-owner", { title: "离页草稿" });
      await Promise.resolve();
    });
    const oldPair = `${sessionId}\0${imageId}`;
    assert.deepEqual(sync!.pairKeysForSession(sessionId), new Set([oldPair]));
    state = { jobs: [], page: 1 };
    jobsRef.current = [];
    await React.act(async () => {
      sync!.retirePairOwners(new Set([oldPair]));
      await Promise.resolve();
    });
    assert.equal(sync!.hasPendingUpdates(), false);
    await React.act(async () => {
      await clock.advanceBy(250);
    });
    assert.equal(fetchCalls, 0);
    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 重复详情请求单飞执行并及时合并到最新队列", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const md5s = ["a".repeat(32), "b".repeat(32), "c".repeat(32)];
  const requestMd5s: string[][] = [];
  const requestSignals: Array<AbortSignal | undefined> = [];
  const responses: Array<(response: Response) => void> = [];
  const fetchStub = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ) => {
    const path = new URL(String(input), "http://localhost").pathname;
    assert.equal(path, ingestionDuplicatesPath);
    const body = JSON.parse(String(init.body ?? "{}")) as { md5s: string[] };
    requestMd5s.push(body.md5s);
    requestSignals.push(init.signal ?? undefined);
    return await new Promise<Response>((resolve) => responses.push(resolve));
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    setCsrfToken("duplicate-details-single-flight-token");
    const { createRoot } = await import("react-dom/client");
    const {
      invalidateIngestionDuplicateDetails,
      useIngestionDuplicateDetails
    } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionDuplicateDetails.ts"
    );
    const jobsFor = (count: number) => md5s.slice(0, count).map((md5, index) => (
      ingestionJob({
        id: `duplicate-details-single-flight-${index}`,
        status: "ready",
        md5,
        duplicateDecision: "undecided",
        duplicateCount: 1,
        serverVersion: index + 1,
        serverAccepted: true
      })
    ));
    const libraryItems = md5s.map((md5) => adminImageListItem({
      id: webUuidV7(),
      md5
    }));
    const responseFor = (indexes: readonly number[]) => new Response(JSON.stringify({
      ok: true,
      items: indexes.map((index) => ({
        md5: md5s[index]!,
        match_count: 1,
        duplicates: [libraryItems[index]!]
      }))
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
    const updatedJobIds = new Set<string>();
    let duplicateDetails: ReturnType<typeof useIngestionDuplicateDetails> | undefined;
    function Probe({ jobs }: { jobs: IngestionJob[] }) {
      duplicateDetails = useIngestionDuplicateDetails({
        jobs,
        updateJobs: (patches) => {
          for (const [id, patch] of patches) {
            if (patch.duplicates?.length) updatedJobIds.add(id);
          }
        },
        updateDuplicateDecision: async () => true
      });
      return React.createElement("output", null, String(jobs.length));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail("duplicate details single-flight request did not settle");
    };
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(1) }));
      await Promise.resolve();
    });
    await settleUntil(() => requestMd5s.length === 1);
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(2) }));
      await Promise.resolve();
    });
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(3) }));
      await Promise.resolve();
    });
    assert.equal(requestMd5s.length, 1);
    await React.act(async () => {
      responses[0]!(responseFor([0]));
      await Promise.resolve();
    });
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settleUntil(() => requestMd5s.length === 2);
    assert.deepEqual(requestMd5s[1], md5s.slice(1));
    await settleUntil(() => updatedJobIds.has("duplicate-details-single-flight-0"));
    assert.equal(updatedJobIds.has("duplicate-details-single-flight-1"), false);
    assert.equal(updatedJobIds.has("duplicate-details-single-flight-2"), false);
    assert.equal(requestSignals[0], undefined);
    assert.equal(requestSignals[1], undefined);
    await React.act(async () => {
      responses[1]!(responseFor([1, 2]));
      await Promise.resolve();
    });
    await settleUntil(() => responses.length === 2);
    assert.equal(requestMd5s.length, 2);
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(2) }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(requestMd5s.length, 2);
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(3) }));
      await Promise.resolve();
    });
    assert.equal(requestMd5s.length, 2);
    await React.act(async () => {
      duplicateDetails!.refresh();
      await Promise.resolve();
    });
    await settleUntil(() => requestMd5s.length === 3);
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(2) }));
      await Promise.resolve();
    });
    await React.act(async () => {
      responses[2]!(responseFor([0, 1, 2]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(requestMd5s.length, 3);
    await React.act(async () => {
      invalidateIngestionDuplicateDetails(md5s[2]!);
      await Promise.resolve();
    });
    await settleUntil(() => requestMd5s.length === 4);
    assert.deepEqual(requestMd5s[3], md5s.slice(0, 2));
    await React.act(async () => {
      responses[3]!(responseFor([0, 1]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await React.act(async () => {
      root.render(React.createElement(Probe, { jobs: jobsFor(3) }));
      await Promise.resolve();
    });
    await settleUntil(() => requestMd5s.length === 5);
    assert.deepEqual(requestMd5s[4], md5s.slice(2));
    await React.act(async () => {
      responses[4]!(responseFor([2]));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(requestMd5s.length, 5);
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 新完成图片按 MD5 精确刷新仍在展示的重复详情", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const md5 = "e".repeat(32);
  const completedItem = adminImageListItem({ id: webUuidV7(), md5 });
  let fetchCalls = 0;
  const observedCounts: number[] = [];
  const fetchStub = async (input: unknown) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    assert.equal(path, ingestionDuplicatesPath);
    fetchCalls += 1;
    return new Response(JSON.stringify({
      ok: true,
      items: [{
        md5,
        match_count: fetchCalls,
        duplicates: [completedItem]
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    setCsrfToken("duplicate-completed-invalidation-token");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { useIngestionQueue } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueue.ts"
    );
    const { useIngestionDuplicateDetails } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionDuplicateDetails.ts"
    );
    const jobs = [ingestionJob({
      id: "duplicate-completed-invalidation",
      status: "ready",
      md5,
      duplicateDecision: "undecided",
      duplicateCount: 1,
      duplicates: [completedItem],
      serverVersion: 3,
      serverAccepted: true
    })];
    let observeCompleted: (() => void) | undefined;
    function Probe() {
      const queue = useIngestionQueue(20, "upload", false);
      observeCompleted = () => queue.observeCompletedIngestions([{
        pair: {
          session_id: "D".repeat(43),
          image_id: completedItem.id
        },
        item: completedItem
      }]);
      useIngestionDuplicateDetails({
        jobs,
        updateJobs: (patches) => {
          const count = patches.get(jobs[0]!.id)?.duplicateCount;
          if (typeof count === "number") observedCounts.push(count);
        },
        updateDuplicateDecision: async () => true
      });
      return React.createElement("output", null, String(fetchCalls));
    }
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail("completed duplicate invalidation did not settle");
    };
    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(Probe)
      ));
      await Promise.resolve();
    });
    await settleUntil(() => observedCounts.includes(1));
    await React.act(async () => {
      observeCompleted!();
      await Promise.resolve();
    });
    await settleUntil(() => observedCounts.includes(2));
    assert.equal(fetchCalls, 2);
    await React.act(async () => root.unmount());
    queryClient.clear();
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 重复归零 CAS 失败保留可操作卡片并允许刷新重试", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const md5 = "d".repeat(32);
  let fetchCalls = 0;
  const fetchStub = async (input: unknown) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    assert.equal(path, ingestionDuplicatesPath);
    fetchCalls += 1;
    return new Response(JSON.stringify({
      ok: true,
      items: [{ md5, match_count: 0, duplicates: [] }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    setCsrfToken("duplicate-zero-cas-token");
    const { createRoot } = await import("react-dom/client");
    const { useIngestionDuplicateDetails } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionDuplicateDetails.ts"
    );
    const duplicate = adminImageListItem({ id: webUuidV7(), md5 });
    const jobs = [ingestionJob({
      id: "duplicate-zero-cas",
      status: "ready",
      md5,
      duplicateDecision: "undecided",
      duplicateCount: 1,
      duplicates: [duplicate],
      serverVersion: 3,
      serverAccepted: true
    })];
    const appliedPatches: Array<ReadonlyMap<string, Partial<IngestionJob>>> = [];
    let decisionCalls = 0;
    const updateJobs = (patches: ReadonlyMap<string, Partial<IngestionJob>>) => {
      appliedPatches.push(patches);
    };
    const updateDuplicateDecision = async () => {
      decisionCalls += 1;
      return decisionCalls > 1;
    };
    let details: ReturnType<typeof useIngestionDuplicateDetails> | undefined;
    function Probe() {
      details = useIngestionDuplicateDetails({
        jobs,
        updateJobs,
        updateDuplicateDecision
      });
      return React.createElement("output", null, details.error);
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail("duplicate zero CAS did not settle");
    };
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await settleUntil(() => decisionCalls === 1 && Boolean(details?.error));
    assert.match(details?.error ?? "", /重复状态恢复失败/);
    const firstPatch = appliedPatches[0]?.get(jobs[0]!.id);
    assert.ok(firstPatch);
    assert.equal("duplicateCount" in firstPatch, false);
    assert.equal("duplicates" in firstPatch, false);
    assert.equal(jobs[0]?.duplicateCount, 1);
    assert.equal(jobs[0]?.duplicates.length, 1);
    await React.act(async () => {
      details!.refresh();
      await Promise.resolve();
    });
    await settleUntil(() => decisionCalls === 2 && details?.error === "");
    assert.equal(fetchCalls, 2);
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 重复决定合并同一在途请求且拒绝跨 incarnation 响应", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const oldSessionId = "R".repeat(43);
  const oldImageId = "019f8457-063a-7036-a580-7a432dc7fd8e";
  let resolveUpdate: ((response: Response) => void) | undefined;
  let updateCalls = 0;
  const requiredRevisions: number[] = [];
  const fetchStub = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    assert.equal(String(input), ingestionUpdatePath);
    updateCalls += 1;
    const body = JSON.parse(String(init.body ?? "{}")) as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal(body.items[0]?.session_id, oldSessionId);
    assert.equal(body.items[0]?.image_id, oldImageId);
    return new Promise<Response>((resolve) => {
      resolveUpdate = resolve;
    });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    setCsrfToken("duplicate-incarnation-token");
    const { createRoot } = await import("react-dom/client");
    const { useStoredIngestionDraftSync } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const oldJob = ingestionJob({
      id: "duplicate-incarnation-card",
      attemptKey: "duplicate-incarnation-old-attempt",
      sessionId: oldSessionId,
      imageId: oldImageId,
      serverAccepted: true,
      serverVersion: 1,
      status: "ready",
      duplicateDecision: "undecided",
      duplicateCount: 1
    });
    const jobsRef = { current: [oldJob] };
    let state = { jobs: jobsRef.current, page: 1 };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      const changed = next !== state;
      state = next;
      jobsRef.current = next.jobs;
      return changed;
    };
    const server = {
      status: "ready",
      revision: 1,
      connectionGeneration: 1,
      items: [],
      ensureRevision(revision: number) {
        requiredRevisions.push(revision);
        return true;
      },
      async recoverAuthority() {},
      refresh() {}
    };
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: server as never,
        reportError: () => undefined,
        observeCompletedIngestions: () => undefined
      });
      return React.createElement("output", null, String(
        sync.hasPendingUpdates()
      ));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });

    const first = sync!.updateDuplicateDecision(oldJob.id, "confirmed");
    const repeated = sync!.updateDuplicateDecision(oldJob.id, "confirmed");
    assert.equal(first, repeated, "同一 target 与决定必须复用同一在途请求");
    for (let attempt = 0; attempt < 20 && !resolveUpdate; attempt += 1) {
      await React.act(async () => {
        await Promise.resolve();
      });
    }
    assert.ok(resolveUpdate);
    const newJob = ingestionJob({
      ...oldJob,
      attemptKey: "duplicate-incarnation-new-attempt",
      sessionId: "N".repeat(43),
      imageId: "019f8457-063a-7037-a580-7a432dc7fd8e",
      serverVersion: 1,
      duplicateDecision: "undecided",
      duplicateCount: 4
    });
    jobsRef.current = [newJob];
    state = { jobs: jobsRef.current, page: 1 };
    await React.act(async () => {
      resolveUpdate!(new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: oldSessionId,
          image_id: oldImageId,
          status: "changed",
          version: 2,
          last_semantic_revision: 2,
          duplicate_count: 0,
          duplicate_decision: "confirmed"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
      assert.equal(await first, false);
      assert.equal(await repeated, false);
    });
    assert.equal(updateCalls, 1);
    assert.equal(jobsRef.current[0]?.attemptKey, newJob.attemptKey);
    assert.equal(jobsRef.current[0]?.duplicateDecision, "undecided");
    assert.equal(jobsRef.current[0]?.duplicateCount, 4);
    assert.equal(jobsRef.current[0]?.serverVersion, 1);
    assert.deepEqual(
      requiredRevisions,
      [2],
      "已知旧 incarnation 写入结果必须按 semantic revision 对账"
    );
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 双队列重复确认各自单飞且 busy 互不阻塞", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { useIngestionCommit } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionCommit.ts"
    );

    const uploadJob = ingestionJob({
      id: "upload-duplicate-single-flight",
      sessionId: "G".repeat(43),
      imageId: "019f8457-063a-7041-a580-7a432dc7fd8e",
      serverAccepted: true,
      serverVersion: 1,
      status: "ready",
      duplicateDecision: "undecided",
      duplicateCount: 1
    });
    const importOwnerJob = ingestionJob({
      id: "import-duplicate-independent",
      sessionId: "I".repeat(43),
      imageId: "019f8457-063a-7042-a580-7a432dc7fd8e",
      serverAccepted: true,
      serverVersion: 1,
      status: "ready",
      duplicateDecision: "undecided",
      duplicateCount: 1
    });
    const uploadJobsRef = { current: [uploadJob] };
    const ingestionJobsRef = { current: [importOwnerJob] };
    let uploadDecisionCalls = 0;
    let importDecisionCalls = 0;
    let finishUploadDecision: (() => void) | undefined;
    let uploadCommit: ReturnType<typeof useIngestionCommit> | undefined;
    let importCommit: ReturnType<typeof useIngestionCommit> | undefined;
    function Probe() {
      uploadCommit = useIngestionCommit({
        jobsRef: uploadJobsRef,
        updateJob: () => undefined,
        updateJobs: () => undefined,
        updateDuplicateDecision: async () => {
          uploadDecisionCalls += 1;
          return new Promise<boolean>((resolve) => {
            finishUploadDecision = () => {
              uploadJobsRef.current = [{
                ...uploadJobsRef.current[0]!,
                duplicateDecision: "confirmed"
              }];
              resolve(true);
            };
          });
        },
        flushPendingUpdates: async () => undefined,
        observeCompletedIngestions: () => undefined,
        onDone: () => undefined
      });
      importCommit = useIngestionCommit({
        jobsRef: ingestionJobsRef,
        updateJob: () => undefined,
        updateJobs: () => undefined,
        updateDuplicateDecision: async () => {
          importDecisionCalls += 1;
          ingestionJobsRef.current = [{
            ...ingestionJobsRef.current[0]!,
            duplicateDecision: "confirmed"
          }];
          return true;
        },
        flushPendingUpdates: async () => undefined,
        observeCompletedIngestions: () => undefined,
        onDone: () => undefined
      });
      return React.createElement("output", null, JSON.stringify({
        uploadBusy: uploadCommit.busy,
        importBusy: importCommit.busy
      }));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const view = () => JSON.parse(container.textContent || "{}") as {
      uploadBusy: boolean;
      importBusy: boolean;
    };
    let uploadFirst: Promise<boolean> | undefined;
    let uploadSecond: Promise<boolean> | undefined;
    await React.act(async () => {
      uploadFirst = uploadCommit!.confirmDuplicate(uploadJob.id);
      uploadSecond = uploadCommit!.confirmDuplicate(uploadJob.id);
      await Promise.resolve();
    });
    assert.equal(await uploadSecond, false);
    assert.equal(uploadDecisionCalls, 1);
    assert.deepEqual(view(), { uploadBusy: true, importBusy: false });
    let importResult = false;
    await React.act(async () => {
      importResult = await importCommit!.confirmDuplicate(importOwnerJob.id);
    });
    assert.equal(importResult, true);
    assert.equal(importDecisionCalls, 1);
    assert.deepEqual(
      view(),
      { uploadBusy: true, importBusy: false },
      "upload 请求在途时 import owner 必须仍可独立确认"
    );
    await React.act(async () => {
      finishUploadDecision!();
      assert.equal(await uploadFirst, true);
    });
    assert.deepEqual(view(), { uploadBusy: false, importBusy: false });
    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 旧提交点击不会命中同 ID 的新任务尝试", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let fetchCalls = 0;
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("旧尝试不得发起提交请求");
    },
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { useIngestionCommit } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionCommit.ts"
    );
    const oldAttempt = ingestionJob({
      id: "reused-job-id",
      attemptKey: "old-attempt",
      status: "ready",
      serverAccepted: true,
      serverVersion: 1,
      sessionId: "O".repeat(43),
      imageId: "019f8457-063a-7043-a580-7a432dc7fd8e"
    });
    const newAttempt = ingestionJob({
      ...oldAttempt,
      attemptKey: "new-attempt",
      sessionId: "N".repeat(43),
      imageId: "019f8457-063a-7044-a580-7a432dc7fd8e"
    });
    const jobsRef = { current: [newAttempt] };
    let commit: ReturnType<typeof useIngestionCommit>["commit"] | undefined;
    let patchedJobs = 0;
    let doneSignals = 0;
    function Probe() {
      ({ commit } = useIngestionCommit({
        jobsRef,
        updateJob: () => undefined,
        updateJobs: (patches) => {
          patchedJobs += patches.size;
        },
        updateDuplicateDecision: async () => false,
        flushPendingUpdates: async () => undefined,
        observeCompletedIngestions: () => undefined,
        onDone: () => {
          doneSignals += 1;
        }
      }));
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    let accepted = true;
    await React.act(async () => {
      accepted = await commit!([oldAttempt]);
    });
    assert.equal(accepted, false);
    assert.equal(fetchCalls, 0);
    assert.equal(patchedJobs, 0);
    assert.equal(doneSignals, 0);
    assert.equal(jobsRef.current[0]?.attemptKey, "new-attempt");
    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] placeholder 草稿按批写回并自动跨越 worker 版本推进", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const paths: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  let updateCalls = 0;
  const sessionIds = ["K".repeat(43), "L".repeat(43), "M".repeat(43)];
  const imageIds = [
    "019f8457-063a-7004-a580-7a432dc7fd92",
    "019f8457-063a-7004-a580-7a432dc7fd93",
    "019f8457-063a-7004-a580-7a432dc7fd94"
  ];
  const json = (value: unknown) => new Response(JSON.stringify({
    ok: true,
    ...value as object
  }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    const path = String(input);
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
    paths.push(path);
    bodies.push(body);
    if (path === ingestionUpdatePath) {
      updateCalls += 1;
      const items = body.items as Array<Record<string, unknown>>;
      if (updateCalls === 1) {
        assert.equal(items.length, 3, "同一 debounce 窗口必须合并为一个 update 批次");
        return json({
          items: items.map((item, index) => index === 0 ? {
            session_id: item.session_id,
            image_id: item.image_id,
            status: "failed",
            code: "ingestion_version_conflict",
            message: "内容接入任务版本已变化"
          } : {
            session_id: item.session_id,
            image_id: item.image_id,
            status: index === 1 ? "changed" : "unchanged",
            version: index === 1 ? 2 : 1,
            last_semantic_revision: index === 1 ? 2 : 1,
            duplicate_count: 0,
            duplicate_decision: "upload"
          })
        });
      }
      assert.equal(items.length, 1);
      assert.equal(items[0]?.expected_version, 2);
      assert.equal(
        (items[0]?.metadata as Record<string, unknown>).title,
        "clicked-draft-0"
      );
      return json({
        items: [{
          session_id: items[0]?.session_id,
          image_id: items[0]?.image_id,
          status: "changed",
          version: 3,
          last_semantic_revision: 3,
          duplicate_count: 0,
          duplicate_decision: "upload"
        }]
      });
    }
    if (path === ingestionStatusPath) {
      const requested = body.items as Array<Record<string, unknown>>;
      assert.equal(requested.length, 1);
      return json({
        items: [{
          session_id: sessionIds[0],
          image_id: imageIds[0],
          status: "present",
          item: {
            session_id: sessionIds[0],
            image_id: imageIds[0],
            queue: "import",
            source_type: "url",
            resolved_image_time: "2026-08-23T01:02:03.456Z",
            status: "preparing",
            phase: "prepare",
            message: "worker advanced",
            progress: 10,
            version: 2,
            progress_seq: 1,
            last_semantic_revision: 2,
            accepted_at: 1,
            accepted_order: 1,
            metadata: ingestionJob().draft,
            storage_slug: "local"
          }
        }]
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }
  try {
    const { createRoot } = await import("react-dom/client");
    const { useStoredIngestionDraftSync } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    let state = {
      page: 1,
      jobs: sessionIds.map((sessionId, index) => ingestionJob({
        id: `batched-draft-${index}`,
        attemptKey: `batched-draft-attempt-${index}`,
        status: "queued",
        serverAccepted: true,
        serverAcceptedOrder: index + 1,
        serverVersion: 1,
        serverDraftPending: true,
        sessionId,
        imageId: imageIds[index],
        draft: {
          ...ingestionJob().draft,
          title: `clicked-draft-${index}`
        }
      }))
    };
    const jobsRef = { current: state.jobs };
    const dispatch = (action: Parameters<typeof reduceIngestionQueue>[1]) => {
      const next = reduceIngestionQueue(state, action);
      if (next === state) return false;
      state = next;
      jobsRef.current = next.jobs;
      return true;
    };
    const errors: string[] = [];
    const server = {
      status: "ready",
      revision: 0,
      connectionGeneration: 1,
      ensureRevision() { return true; },
      async recoverAuthority() {},
      refresh() {}
    };
    let sync: ReturnType<typeof useStoredIngestionDraftSync> | undefined;
    function Probe() {
      sync = useStoredIngestionDraftSync({
        jobsRef,
        dispatch,
        server: server as never,
        reportError: (message) => errors.push(message),
        observeCompletedIngestions: () => undefined
      });
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    let flushError: unknown;
    await React.act(async () => {
      try {
        await sync!.flushPendingUpdates();
      } catch (error) {
        flushError = error;
      }
    });
    assert.equal(
      flushError,
      undefined,
      JSON.stringify({ paths, bodies, errors })
    );
    assert.deepEqual(paths, [ingestionUpdatePath, ingestionStatusPath, ingestionUpdatePath]);
    assert.equal(jobsRef.current[0]?.serverVersion, 3);
    assert.equal(jobsRef.current[1]?.serverVersion, 2);
    assert.equal(jobsRef.current[2]?.serverVersion, 1);
    assert.deepEqual(errors, []);
    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 未知 completed 交接在 status 失败后可显式重试", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let fetchCalls = 0;
  let releaseHeldStatus: ((response: Response) => void) | undefined;
  let heldStatusAborted = false;
  const fetchStub = async (_input: unknown, init: RequestInit = {}) => {
    fetchCalls += 1;
    if (fetchCalls === 1) {
      return new Response(JSON.stringify({
        ok: false,
        error: { code: "temporary", message: "temporary status failure" }
      }), {
        status: 503,
        headers: { "content-type": "application/json" }
      });
    }
    if (fetchCalls === 4) {
      return new Promise<Response>((resolve, reject) => {
        releaseHeldStatus = resolve;
        init.signal?.addEventListener("abort", () => {
          heldStatusAborted = true;
          reject(new Error("held status aborted"));
        }, { once: true });
      });
    }
    if (fetchCalls === 5 || fetchCalls === 6) {
      const active = fetchCalls === 5;
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: "J".repeat(43),
          image_id: "019f8457-063a-7004-a580-7a432dc7fd90",
          status: "completed",
          completed_item: adminImageListItem({
            id: "019f8457-063a-7004-a580-7a432dc7fd90"
          }),
          redis_status: active ? "active" : "completed",
          redis_version: active ? 2 : 3,
          redis_last_semantic_revision: active ? 101 : 102
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({
      ok: true,
      items: [{
        session_id: "H".repeat(43),
        image_id: "019f8457-063a-7004-a580-7a432dc7fd8f",
        status: "missing"
      }]
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { useIngestionAuthorityHandoffs } = await import(
      "../../../packages/web/src/pages/admin/ingestion/queue/useIngestionAuthorityHandoffs.ts"
    );
    const errors: Array<{ message: string; retryable: boolean }> = [];
    const observedHandoffCompleted: string[] = [];
    const ensuredHandoffCoverage: Array<{
      revision?: number;
      connectionGeneration?: number;
    }> = [];
    const jobsRef = { current: [] as IngestionJob[] };
    const server = {
      status: "ready",
      connectionGeneration: 1,
      revision: 7,
      ensureRevision(revision?: number, connectionGeneration?: number) {
        ensuredHandoffCoverage.push({ revision, connectionGeneration });
        return true;
      },
      async recoverAuthority() {},
      refresh() {}
    };
    let handoffs: ReturnType<typeof useIngestionAuthorityHandoffs> | undefined;
    function Probe() {
      handoffs = useIngestionAuthorityHandoffs({
        jobs: [],
        jobsRef,
        dispatch: () => false,
        server: server as never,
        reportError: (message, retryable = true) => {
          errors.push({ message, retryable });
        },
        promoteReconnectOwners: () => new Set(),
        observeCompletedIngestions: (entries) => {
          observedHandoffCompleted.push(...entries.map(({ pair }) => pair.image_id));
        }
      });
      return React.createElement("output", null, String(handoffs.pending));
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
      assert.fail("authority handoff retry did not settle");
    };
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "H".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd8f",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: undefined
      });
      handoffs!.prepareBinding({
        sessionId: "H".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd8f",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: 8
      }, 1);
      await Promise.resolve();
    });
    assert.deepEqual(
      ensuredHandoffCoverage.slice(0, 2),
      [
        { revision: undefined, connectionGeneration: 1 },
        { revision: 8, connectionGeneration: 1 }
      ],
      "同一轮 unknown 与已知 revision 必须同时登记到单一 snapshot owner"
    );
    await settleUntil(() => fetchCalls === 1 && errors.length === 1);
    assert.equal(container.textContent, "true");
    await React.act(async () => {
      handoffs!.retry();
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 2 && container.textContent === "false");
    assert.equal(
      errors.length,
      1,
      "missing 只收敛交接围栏，不应再发布队列级提示"
    );
    server.connectionGeneration = 2;
    server.revision = 100;
    const coverageBeforeCrossGeneration = ensuredHandoffCoverage.length;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "H".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd8f",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: 44
      }, 1);
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 3 && container.textContent === "false");
    assert.equal(
      fetchCalls,
      3,
      "旧连接的迟到 HTTP revision 即使数值已覆盖也必须先查当前 status"
    );
    assert.equal(
      ensuredHandoffCoverage.length,
      coverageBeforeCrossGeneration,
      "旧连接 handoff revision 不得直接排入新连接 snapshot 围栏"
    );

    server.connectionGeneration = 3;
    server.revision = 100;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const coverageBeforeCurrentPairResponse = ensuredHandoffCoverage.length;
    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "I".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd91",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: 99
      }, 2);
      handoffs!.prepareBinding({
        sessionId: "I".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd91",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: 2
      }, 3);
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 4 && Boolean(releaseHeldStatus));
    assert.deepEqual(
      ensuredHandoffCoverage.slice(coverageBeforeCurrentPairResponse),
      [{ revision: 2, connectionGeneration: 3 }],
      "当前代同 pair 响应不得继承 status 未验证的旧代高 revision"
    );
    server.revision = 101;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(fetchCalls, 4, "无关 revision 推进不得重启在途 status 查询");
    assert.equal(heldStatusAborted, false);
    await React.act(async () => {
      releaseHeldStatus?.(new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: "I".repeat(43),
          image_id: "019f8457-063a-7004-a580-7a432dc7fd91",
          status: "missing"
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
      await Promise.resolve();
    });
    await settleUntil(() => container.textContent === "false");
    assert.equal(
      errors.length,
      1,
      "迟到的 missing 结果同样不得覆盖可重试错误或插入新提示"
    );

    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "J".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd90",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: undefined
      }, 3);
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 5);
    assert.equal(container.textContent, "true");
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      fetchCalls,
      5,
      "PG completed 但 Redis active 时同一 revision 不得轮询"
    );
    server.revision = 102;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await settleUntil(() => fetchCalls === 6 && container.textContent === "false");
    assert.deepEqual(
      ensuredHandoffCoverage.at(-1),
      { revision: 102, connectionGeneration: 3 },
      "跨代围栏必须改用当前连接 status 返回的 revision 证明"
    );
    assert.deepEqual(observedHandoffCompleted, [
      "019f8457-063a-7004-a580-7a432dc7fd90",
      "019f8457-063a-7004-a580-7a432dc7fd90"
    ], "权威交接每次完成态 status 都必须交给 owner 统一去重");

    server.connectionGeneration = 4;
    server.revision = 200;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const externalPairKey = `${"K".repeat(43)}\0${
      "019f8457-063a-7004-a580-7a432dc7fd92"
    }`;
    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "K".repeat(43),
        imageId: "019f8457-063a-7004-a580-7a432dc7fd92",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: undefined
      }, 4, true);
      await Promise.resolve();
    });
    assert.equal(container.textContent, "true");
    server.connectionGeneration = 5;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      container.textContent,
      "true",
      "unknown completed 围栏不得因 SSE 连接代际变化而清除"
    );
    assert.equal(fetchCalls, 6, "external status owner 仍只允许外部查询");
    await React.act(async () => {
      handoffs!.verifyExternalStatusRevisions(new Map([
        [externalPairKey, 202]
      ]));
      await Promise.resolve();
    });
    assert.equal(container.textContent, "true");
    server.revision = 202;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      container.textContent,
      "true",
      "external status owner 必须等待外层 snapshot coverage 显式释放"
    );
    await React.act(async () => {
      handoffs!.resolveExternalStatuses(new Set([externalPairKey]));
      await Promise.resolve();
    });
    assert.equal(container.textContent, "false");
    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 取消只在服务端明确丢弃后报告成功", async () => {
  const originalFetch = globalThis.fetch;
  const sessionId = "C".repeat(43);
  const imageId = "019f8457-063a-7003-a580-7a432dc7fd8e";
  let jobs = [ingestionJob({
    kind: "upload",
    sessionId,
    imageId,
    serverVersion: undefined,
    status: "failed",
    failureStage: "prepare"
  })];
  const jobsRef = { current: jobs };
  const observedCompleted: string[] = [];
  const queue = {
    jobsRef,
    observeCompletedIngestions(entries: readonly {
      pair: { session_id: string; image_id: string };
    }[]) {
      observedCompleted.push(...entries.map(({ pair }) => (
        `${pair.session_id}\0${pair.image_id}`
      )));
    },
    updateJob(id: string, patch: Partial<IngestionJob>) {
      jobs = jobs.map((job) => job.id === id ? { ...job, ...patch } : job);
      jobsRef.current = jobs;
    }
  };
  const paths: string[] = [];
  let statusItem: Record<string, unknown> = {
    session_id: sessionId,
    image_id: imageId,
    status: "missing"
  };
  let cancelStatus: "discarded" | "completed" = "discarded";
  const completedCancelItem = adminImageListItem({ id: imageId });
  globalThis.fetch = (async (input) => {
    const path = String(input);
    paths.push(path);
    if (path === ingestionStatusPath) {
      return new Response(JSON.stringify({
        ok: true,
        items: [statusItem]
      }), { status: 200 });
    }
    if (path === ingestionCancelPath) {
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: sessionId,
          image_id: imageId,
          status: cancelStatus,
          ...(cancelStatus === "completed"
            ? { completed_item: completedCancelItem }
            : { queue_revision: 17 })
        }]
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;
  try {
    assert.equal(await cancelServerIngestionJob(queue, jobs[0]!), false);
    assert.equal(jobs[0]?.status, "failed");
    assert.equal(jobs[0]?.failureStage, "cancel");
    assert.match(jobs[0]?.message ?? "", /尚未确认/);
    assert.deepEqual(paths, [ingestionStatusPath]);

    jobs = [ingestionJob({
      kind: "upload",
      sessionId,
      imageId,
      serverVersion: 3,
      status: "failed",
      failureStage: "cancel"
    })];
    jobsRef.current = jobs;
    const discardedJob = jobs[0]!;
    const discardedOutcome = (
      await cancelServerIngestionJobs(queue, [discardedJob])
    ).get(discardedJob.id);
    assert.equal(discardedOutcome?.succeeded, true);
    assert.equal(
      discardedOutcome?.releasedRevision,
      17,
      "discarded queue_revision 必须传入 owner 的 releasedRevision"
    );
    assert.equal(jobs[0]?.status, "cancelled");
    assert.deepEqual(paths, [ingestionStatusPath, ingestionCancelPath]);

    jobs = [ingestionJob({
      kind: "upload",
      sessionId,
      imageId,
      serverVersion: undefined,
      status: "failed",
      failureStage: "cancel"
    })];
    jobsRef.current = jobs;
    statusItem = {
      session_id: sessionId,
      image_id: imageId,
      status: "completed",
      completed_item: completedCancelItem,
      redis_status: "active",
      redis_version: 4,
      redis_last_semantic_revision: 9
    };
    cancelStatus = "completed";
    assert.equal(await cancelServerIngestionJob(queue, jobs[0]!), false);
    assert.equal(jobs[0]?.status, "finalized");
    assert.deepEqual(
      paths.slice(-2),
      [ingestionStatusPath, ingestionCancelPath],
      "PG completed 但 Redis receipt 仍存在时必须继续调用 cancel 收口回执"
    );
    assert.deepEqual(observedCompleted, [
      `${sessionId}\0${imageId}`,
      `${sessionId}\0${imageId}`
    ], "status 与取消终态都必须先交给 owner 的 pair 去重入口");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("[Web/内容接入] 清空队列按 pair 合并 placeholder 与同一 Server 动作结果", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { useIngestionQueueWorkflowActions } = await import(
      "../../../packages/web/src/pages/admin/ingestion/workflow/useIngestionQueueWorkflowActions.ts"
    );
    const pair = {
      session_id: "C".repeat(43),
      image_id: "019f8457-063a-7021-a580-7a432dc7fd8e"
    };
    const placeholder = ingestionJob({
      id: "overlap-placeholder",
      attemptKey: "overlap-attempt",
      batchKey: "overlap-batch",
      kind: "import",
      status: "queued"
    });
    const jobsRef = { current: [placeholder] };
    let serverPair = pair;
    let serverItems: Array<{
      session_id: string;
      image_id: string;
      status: "changed" | "unchanged" | "skipped" | "failed";
      message?: string;
    }> = [{ ...serverPair, status: "changed" }];
    let outcomeAcceptedOrder = 1;
    let cancellationMode: "completed" | "discarded" | "missing" = "completed";
    let failNextAction = false;
    let freezeCalls = 0;
    let refreshes = 0;
    const actionRuns: unknown[] = [];
    const queue = {
      queueType: "import" as const,
      localJobs: jobsRef.current,
      jobsRef,
      pendingAuthorityHandoff: false,
      summary: { unfinishedCount: 1, doneJobs: 0 },
      actions: {
        identity: "generation\0scope\0watermark",
        freeze: (action: string) => {
          freezeCalls += 1;
          return {
            queue: "import",
            actionRequestId: "019f8457-063a-7022-a580-7a432dc7fd8e",
            action,
            actionScope: "scope",
            actionWatermark: "watermark",
            connectionGeneration: 1
          };
        },
        run: async (frozen: unknown) => {
          actionRuns.push(frozen);
          if (failNextAction) {
            failNextAction = false;
            refreshes += 1;
            return null;
          }
          const result = {
            processed: serverItems.length,
            changed: serverItems.filter(
              (item) => item.status === "changed"
            ).length,
            failed: serverItems.filter(
              (item) => item.status === "failed"
            ).length,
            items: serverItems
          };
          refreshes += 1;
          return result;
        }
      },
      server: {
        status: "ready" as const,
        connectionGeneration: 1,
        actionScope: "scope",
        recoverAfterSuccessfulAction: async () => { refreshes += 1; },
        recoverAuthority: async () => { refreshes += 1; },
        refresh() { refreshes += 1; }
      },
      projectCompletedCleanupBatch: () => 0,
      recoverAfterSuccessfulAction: async () => { refreshes += 1; },
      captureBrowserActionJobs: (predicate: (job: IngestionJob) => boolean) => (
        jobsRef.current.filter(predicate)
      ),
      appendJobs: (jobs: IngestionJob[]) => {
        jobsRef.current = [...jobsRef.current, ...jobs];
        queue.localJobs = jobsRef.current;
        return true;
      },
      clearJobIds: (ids: ReadonlySet<string>) => {
        jobsRef.current = jobsRef.current.filter((job) => !ids.has(job.id));
        queue.localJobs = jobsRef.current;
      },
      releaseResolvedServerJobs: (targets: readonly {
        id: string;
        attemptKey: string;
        pair: { session_id: string; image_id: string };
      }[]) => {
        const released = new Set<string>();
        for (const target of targets) {
          const current = jobsRef.current.find((job) => job.id === target.id);
          if (
            current?.attemptKey === target.attemptKey
            && current.sessionId === target.pair.session_id
            && current.imageId?.toLowerCase() === target.pair.image_id.toLowerCase()
            && current.serverAccepted === true
          ) released.add(target.id);
        }
        jobsRef.current = jobsRef.current.filter((job) => !released.has(job.id));
        queue.localJobs = jobsRef.current;
        return released;
      },
      applyDefaultsToLocalJobs() {},
      flushPendingUpdates: async () => undefined,
      hasPendingDraftUpdates: () => false
    };
    const cancelJobs = async (jobs: readonly IngestionJob[]) => {
      const targetPairs = new Map(jobs.map((target) => [
        target.id,
        target.sessionId && target.imageId
          ? {
              session_id: target.sessionId,
              image_id: target.imageId
            }
          : pair
      ]));
      jobsRef.current = jobsRef.current.map((job) => {
        const target = jobs.find((candidate) => (
          candidate.id === job.id && candidate.attemptKey === job.attemptKey
        ));
        if (!target) return job;
        const targetPair = targetPairs.get(target.id)!;
        return {
          ...target,
          sessionId: targetPair.session_id,
          imageId: targetPair.image_id,
          serverAccepted: true,
          serverAcceptedOrder: outcomeAcceptedOrder,
          status: cancellationMode === "completed"
            ? "finalized"
            : cancellationMode === "discarded"
              ? "cancelled"
              : "failed"
        };
      });
      queue.localJobs = jobsRef.current;
      return new Map(jobs.map((target) => [target.id, {
        succeeded: cancellationMode === "discarded",
        pair: targetPairs.get(target.id)!,
        ...(cancellationMode === "completed"
          ? { terminal: "completed" as const }
          : {})
      }]));
    };
    let workflow: ReturnType<typeof useIngestionQueueWorkflowActions> | undefined;
    function Probe() {
      workflow = useIngestionQueueWorkflowActions({
        queue: queue as never,
        defaults: {
          device: "pc",
          brightness: "dark",
          theme: "none",
          author: "",
          tags: []
        },
        cancelJobs,
        commitJobs: async () => false,
        onDone() {}
      });
      return null;
    }
    const root = createRoot(document.getElementById("root")!);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const abandonedCleanupJob = ingestionJob({
      id: "abandoned-cleanup",
      attemptKey: "abandoned-cleanup-attempt",
      status: "ready"
    });
    const replacementCleanupJob = ingestionJob({
      id: "replacement-cleanup",
      attemptKey: "replacement-cleanup-attempt",
      status: "ready"
    });
    jobsRef.current = [abandonedCleanupJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const abandonedFreezeStart = freezeCalls;
    assert.deepEqual(
      workflow!.armCleanupAction("uncommitted", 1),
      { count: 1 }
    );
    workflow!.discardUnconfirmedIntents();
    jobsRef.current = [replacementCleanupJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.deepEqual(
      workflow!.armCleanupAction("uncommitted", 2),
      { count: 2 }
    );
    assert.equal(
      freezeCalls,
      abandonedFreezeStart + 2,
      "未执行的确认被关闭后必须释放冻结任务并为下一次操作重新取界"
    );
    workflow!.discardUnconfirmedIntents();
    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), true);
    assert.deepEqual(jobsRef.current, []);

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    serverPair = {
      ...pair,
      image_id: "019f8457-063a-7023-a580-7a432dc7fd8e"
    };
    serverItems = [{ ...serverPair, status: "changed" }];
    outcomeAcceptedOrder = 2;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "并行 status 已推进出原筛选集合时应保留卡片并收起确认"
    );
    assert.equal(jobsRef.current.length, 1);

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    serverItems = [];
    outcomeAcceptedOrder = 99;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(
      await workflow!.confirmClearQueue(),
      true,
      "clear 首响应丢失或确认后 accept 的本地 attempt 仍属于冻结清空意图"
    );
    assert.deepEqual(jobsRef.current, []);

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    cancellationMode = "discarded";
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), true);
    assert.deepEqual(
      jobsRef.current,
      [],
      "明确 discarded 的 Server pair 必须同步释放本地 owner"
    );

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    cancellationMode = "missing";
    serverItems = [{ ...pair, status: "changed" }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "Server 已 changed 的 exact pair 必须收敛本地 missing 结果"
    );
    assert.deepEqual(
      jobsRef.current,
      [],
      "全局清理先完成时，本地 status/cancel 的 missing 不得卡住 owner"
    );
    cancellationMode = "discarded";

    const laterJob = ingestionJob({
      id: "later-uncommitted-job",
      attemptKey: "later-uncommitted-attempt",
      status: "ready"
    });
    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    serverItems = [];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    jobsRef.current = [placeholder, laterJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(await workflow!.confirmCleanupAction("uncommitted"), true);
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [laterJob.id],
      "状态清理确认必须保留打开确认后新加入的任务"
    );

    const replacedAttempt = ingestionJob({
      id: "cleanup-replaced-attempt",
      attemptKey: "cleanup-replaced-old",
      status: "queued"
    });
    const replacementAttempt = ingestionJob({
      ...replacedAttempt,
      attemptKey: "cleanup-replaced-new"
    });
    jobsRef.current = [replacedAttempt];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    jobsRef.current = [replacementAttempt];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "同 id 新 attempt 应跳过旧冻结任务并正常结束确认"
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.attemptKey),
      [replacementAttempt.attemptKey]
    );

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    jobsRef.current = [placeholder, laterJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(await workflow!.confirmClearQueue(), true);
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [laterJob.id],
      "整队列确认也只能清理打开确认时冻结的任务"
    );

    const advancedJob = { ...placeholder, status: "done" as const };
    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    serverItems = [{ ...serverPair, status: "skipped" }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.notEqual(workflow!.armCleanupAction("uncommitted"), false);
    jobsRef.current = [advancedJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "状态变化造成的 skipped 应关闭确认并由卡片直接反映"
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [advancedJob.id],
      "确认时已不匹配原清理谓词的冻结任务不得被本地路径移除"
    );

    const retryDoneJob = ingestionJob({
      id: "cleanup-retry-done",
      attemptKey: "cleanup-retry-attempt",
      status: "done"
    });
    let retryDoneStatusReads = 0;
    Object.defineProperty(retryDoneJob, "status", {
      configurable: true,
      enumerable: true,
      get() {
        retryDoneStatusReads += 1;
        return "done";
      }
    });
    jobsRef.current = [retryDoneJob];
    queue.localJobs = jobsRef.current;
    serverItems = [];
    failNextAction = true;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const cleanupFreezeStart = freezeCalls;
    const cleanupRunStart = actionRuns.length;
    const cleanupRefreshStart = refreshes;
    assert.deepEqual(
      workflow!.armCleanupAction("completed", 1),
      { count: 1 }
    );
    assert.equal(await workflow!.confirmCleanupAction("completed"), false);
    const retryDoneReadsAfterFirstRun = retryDoneStatusReads;
    assert.equal(
      refreshes,
      cleanupRefreshStart + 1,
      "失败确认只能由 action 所有者刷新一次 snapshot"
    );
    const retryCleanupLaterJob = ingestionJob({
      id: "cleanup-retry-later",
      attemptKey: "cleanup-retry-later-attempt",
      status: "done"
    });
    jobsRef.current = [retryCleanupLaterJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    workflow!.discardUnconfirmedIntents();
    assert.deepEqual(
      workflow!.armCleanupAction("completed", 2),
      { count: 1 },
      "结果未知后重开弹窗必须继续显示首次冻结数量"
    );
    assert.equal(
      await workflow!.confirmCleanupAction("completed"),
      true,
      "结果未知后即使关闭弹窗也必须能重试同一冻结意图"
    );
    assert.equal(
      retryDoneStatusReads,
      retryDoneReadsAfterFirstRun,
      "重试意图不得继续持有或重新读取已明确清除的本地任务"
    );
    assert.equal(refreshes, cleanupRefreshStart + 2);
    assert.equal(freezeCalls, cleanupFreezeStart + 1);
    assert.strictEqual(
      actionRuns[cleanupRunStart],
      actionRuns[cleanupRunStart + 1],
      "清理重试必须复用原 action ID、水位与冻结集合"
    );

    const partialResolvedPair = {
      session_id: "P".repeat(43),
      image_id: "019f8457-063a-7024-a580-7a432dc7fd8e"
    };
    const partialUnknownPair = {
      session_id: "Q".repeat(43),
      image_id: "019f8457-063a-7025-a580-7a432dc7fd8e"
    };
    const partialResolvedJob = ingestionJob({
      id: "cleanup-partial-resolved",
      attemptKey: "cleanup-partial-resolved-attempt",
      status: "queued",
      sessionId: partialResolvedPair.session_id,
      imageId: partialResolvedPair.image_id
    });
    const partialUnknownJob = ingestionJob({
      id: "cleanup-partial-unknown",
      attemptKey: "cleanup-partial-unknown-attempt",
      status: "queued",
      sessionId: partialUnknownPair.session_id,
      imageId: partialUnknownPair.image_id
    });
    let partialResolvedStatusReads = 0;
    Object.defineProperty(partialResolvedJob, "status", {
      configurable: true,
      enumerable: true,
      get() {
        partialResolvedStatusReads += 1;
        return "queued";
      }
    });
    jobsRef.current = [partialResolvedJob, partialUnknownJob];
    queue.localJobs = jobsRef.current;
    cancellationMode = "missing";
    serverItems = [{ ...partialResolvedPair, status: "changed" }];
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.deepEqual(
      workflow!.armCleanupAction("uncommitted", 2),
      { count: 2 }
    );
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      false,
      "部分对账仍未知时必须保留同一冻结动作"
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [partialUnknownJob.id],
      "服务端已对账的本地卡片应在首次响应后立即释放"
    );
    const partialResolvedReadsAfterFirstRun = partialResolvedStatusReads;
    cancellationMode = "completed";
    serverItems = [{ ...partialUnknownPair, status: "changed" }];
    assert.deepEqual(
      workflow!.armCleanupAction("uncommitted", 99),
      { count: 2 },
      "部分重试仍须显示首次冻结数量"
    );
    assert.equal(
      await workflow!.confirmCleanupAction("uncommitted"),
      true,
      "后续响应应使用保留的 exact pair 收敛最后一项"
    );
    assert.equal(
      partialResolvedStatusReads,
      partialResolvedReadsAfterFirstRun,
      "部分重试不得继续持有或读取已对账任务"
    );
    assert.deepEqual(jobsRef.current, []);

    const retryClearJob = ingestionJob({
      id: "clear-retry-done",
      attemptKey: "clear-retry-attempt",
      status: "done"
    });
    let retryClearStatusReads = 0;
    Object.defineProperty(retryClearJob, "status", {
      configurable: true,
      enumerable: true,
      get() {
        retryClearStatusReads += 1;
        return "done";
      }
    });
    jobsRef.current = [retryClearJob];
    queue.localJobs = jobsRef.current;
    failNextAction = true;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const clearFreezeStart = freezeCalls;
    const clearRunStart = actionRuns.length;
    const clearRefreshStart = refreshes;
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), false);
    const retryClearReadsAfterFirstRun = retryClearStatusReads;
    assert.equal(refreshes, clearRefreshStart + 1);
    workflow!.discardUnconfirmedIntents();
    const retryClearLaterJob = ingestionJob({
      id: "clear-retry-later",
      attemptKey: "clear-retry-later-attempt",
      status: "done"
    });
    jobsRef.current = [retryClearLaterJob];
    queue.localJobs = jobsRef.current;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(
      workflow!.armClearQueue(),
      true,
      "真实 UI 解除武装后应在下一次第一击恢复原冻结意图"
    );
    assert.equal(
      await workflow!.confirmClearQueue(),
      true,
      "整队列清空失败后也必须保留原冻结意图供重试"
    );
    assert.equal(
      retryClearStatusReads,
      retryClearReadsAfterFirstRun,
      "整队列重试不得继续持有或重新读取已明确清除的本地任务"
    );
    assert.equal(refreshes, clearRefreshStart + 2);
    assert.equal(freezeCalls, clearFreezeStart + 1);
    assert.strictEqual(
      actionRuns[clearRunStart],
      actionRuns[clearRunStart + 1]
    );
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [retryClearLaterJob.id],
      "结果未知期间加入的任务不得进入恢复后的清空范围"
    );

    jobsRef.current = [placeholder];
    queue.localJobs = jobsRef.current;
    cancellationMode = "missing";
    Object.assign(queue.server, {
      summary: {
        total: 0,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0
      }
    });
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const localRetryFreezeStart = freezeCalls;
    const localRetryRunStart = actionRuns.length;
    const localRetryRefreshStart = refreshes;
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), false);
    const localRetryLater = ingestionJob({
      id: "local-clear-retry-later",
      attemptKey: "local-clear-retry-later-attempt",
      status: "done"
    });
    jobsRef.current = [...jobsRef.current, localRetryLater];
    queue.localJobs = jobsRef.current;
    cancellationMode = "discarded";
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    assert.equal(workflow!.armClearQueue(), true);
    assert.equal(await workflow!.confirmClearQueue(), true);
    assert.equal(
      freezeCalls,
      localRetryFreezeStart,
      "权威 Server 计数为零时不得为本地清空重试补冻空动作"
    );
    assert.equal(actionRuns.length, localRetryRunStart);
    assert.equal(refreshes, localRetryRefreshStart);
    assert.deepEqual(
      jobsRef.current.map((job) => job.id),
      [localRetryLater.id],
      "纯本地结果未知后的重试也必须复用原冻结集合"
    );
    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 本地重试按 completed 与 discarded 结果保留或重建 attempt", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let cancelRequests = 0;
  let uploadIntentRequests = 0;
  let releaseRequests = 0;
  let refreshRequests = 0;
  let boundDisplayPage: number | undefined;
  let uploadIntentBatchKey: string | undefined;
  let uploadIntentBatchTime: string | undefined;
  let cancelResponseStatus: "completed" | "discarded" = "completed";
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    if (path === uploadIntentPath) {
      uploadIntentRequests += 1;
      const body = JSON.parse(String(init.body)) as {
        items: Array<{
          idempotency_key: string;
          batch_key: string;
          batch_time: string;
          batch_position: number;
        }>;
      };
      uploadIntentBatchKey = body.items[0]!.batch_key;
      uploadIntentBatchTime = body.items[0]!.batch_time;
      assert.match(
        body.items[0]!.batch_key,
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      );
      assert.equal(body.items[0]!.batch_position, 0);
      return new Response(JSON.stringify({
        ok: true,
        items: body.items.map(() => ({
          session_id: "N".repeat(43),
          image_id: "019f8457-063a-7026-a580-7a432dc7fd8e",
          resolved_image_time: "2026-08-23T01:02:03.456Z",
          request_hash: "a".repeat(64),
          status: "accepted",
          accepted_order: 1,
          version: 1,
          last_semantic_revision: 1
        }))
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (path !== ingestionCancelPath) throw new Error(`unexpected fetch ${path}`);
    cancelRequests += 1;
    const body = JSON.parse(String(init.body)) as {
      items: Array<{ session_id: string; image_id: string }>;
    };
    return new Response(JSON.stringify({
      ok: true,
      items: body.items.map((item) => ({
        ...item,
        status: cancelResponseStatus,
        ...(cancelResponseStatus === "completed" ? {
          completed_item: adminImageListItem({ id: item.image_id })
        } : {})
      }))
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    setCsrfToken("local-retry-completed-token");
    const { createRoot } = await import("react-dom/client");
    const { useUpload } = await import(
      "../../../packages/web/src/pages/admin/ingestion/upload/useUpload.ts"
    );
    const retryJob = ingestionJob({
      id: "local-retry-completed",
      attemptKey: "local-retry-completed-attempt",
      batchKey: webUuidV7(),
      batchPosition: 0,
      kind: "upload",
      file: new File(["completed"], "completed.webp", {
        type: "image/webp"
      }),
      sessionId: "L".repeat(43),
      imageId: "019f8457-063a-7025-a580-7a432dc7fd8e",
      serverAccepted: true,
      serverVersion: 1,
      status: "failed",
      failureStage: "prepare"
    });
    const jobsRef = { current: [retryJob] };
    const updateJob = (id: string, patch: Partial<IngestionJob>) => {
      jobsRef.current = jobsRef.current.map((job) => (
        job.id === id ? { ...job, ...patch } : job
      ));
    };
    const queue = {
      jobsRef,
      observeCompletedIngestions: () => undefined,
      appendJobs: (jobs: IngestionJob[]) => {
        jobsRef.current = [...jobsRef.current, ...jobs];
        return true;
      },
      updateJob,
      bindServerJob: (
        id: string,
        binding: Partial<IngestionJob> & { serverHandoffPending?: boolean }
      ) => {
        const current = jobsRef.current.find((job) => job.id === id);
        boundDisplayPage = binding.serverHandoffPending
          ? current?.serverHandoffDisplayPage ?? 1
          : undefined;
        updateJob(id, {
          ...binding,
          serverHandoffDisplayPage: boundDisplayPage,
          serverAccepted: true
        });
      },
      captureServerConnectionGeneration: () => 1,
      releaseResolvedServerJobs: (targets: readonly { id: string }[]) => {
        releaseRequests += 1;
        const released = new Set(targets.map((target) => target.id));
        jobsRef.current = jobsRef.current.filter((job) => !released.has(job.id));
        return released;
      },
      server: {
        recoverAuthority: async () => { refreshRequests += 1; },
        refresh: () => { refreshRequests += 1; }
      }
    };
    let owner: ReturnType<typeof useUpload> | undefined;
    function Probe() {
      owner = useUpload({
        queue: queue as never,
        defaults: {
          device: "pc",
          brightness: "dark",
          theme: "none",
          author: "",
          tags: []
        },
        storageSlug: "local",
        maxItems: 100,
        maxBytes: 1024 * 1024,
        maxLongEdge: 4096,
        browserConcurrency: 2
      });
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    await owner!.retry(retryJob);
    assert.equal(cancelRequests, 1);
    assert.equal(releaseRequests, 0);
    assert.equal(refreshRequests, 0);
    assert.equal(jobsRef.current.length, 1);
    assert.equal(jobsRef.current[0]?.attemptKey, retryJob.attemptKey);
    assert.equal(jobsRef.current[0]?.status, "finalized");

    cancelResponseStatus = "discarded";
    const releasedRetryBatchKey = webIngestionBatchKey();
    const releasedRetryJob = ingestionJob({
      ...retryJob,
      id: "local-retry-released",
      attemptKey: "local-retry-released-attempt",
      batchKey: releasedRetryBatchKey,
      batchTime: "2026-08-23T00:00:00.000Z",
      batchPosition: 37,
      sessionId: "M".repeat(43),
      imageId: "019f8457-063a-7027-a580-7a432dc7fd8e",
      serverHandoffPending: true,
      serverHandoffRevision: 8,
      serverHandoffDisplayPage: 3,
      serverHandoffProvisionalTotal: true,
      serverStatus: "failed",
      serverAttemptKey: "local-retry-released-attempt",
      serverSessionId: "M".repeat(43),
      serverImageId: "019f8457-063a-7027-a580-7a432dc7fd8e",
      status: "failed",
      failureStage: "prepare"
    });
    jobsRef.current = [releasedRetryJob];
    await owner!.retry(releasedRetryJob);
    assert.equal(cancelRequests, 2);
    assert.equal(uploadIntentRequests, 1);
    assert.equal(releaseRequests, 1);
    assert.equal(refreshRequests, 0);
    assert.notEqual(
      jobsRef.current[0]?.attemptKey,
      releasedRetryJob.attemptKey,
      "discarded old owner 后必须创建新 attempt"
    );
    assert.equal(
      uploadIntentBatchKey,
      releasedRetryJob.batchKey,
      "discarded old owner 的新 attempt 仍须保留原批次展示位置"
    );
    assert.equal(
      jobsRef.current[0]?.batchKey,
      uploadIntentBatchKey
    );
    assert.equal(uploadIntentBatchTime, releasedRetryJob.batchTime);
    assert.equal(jobsRef.current[0]?.batchTime, uploadIntentBatchTime);
    assert.equal(jobsRef.current[0]?.batchPosition, 37);
    assert.equal(
      boundDisplayPage,
      undefined,
      "保留原批次位置的重试无需创建额外 handoff 页锚点"
    );
    assert.equal(jobsRef.current[0]?.serverHandoffDisplayPage, undefined);
    assert.equal(jobsRef.current[0]?.serverHandoffProvisionalTotal, undefined);
    assert.equal(jobsRef.current[0]?.serverStatus, undefined);
    assert.equal(jobsRef.current[0]?.serverAttemptKey, undefined);
    assert.equal(jobsRef.current[0]?.serverSessionId, undefined);
    assert.equal(jobsRef.current[0]?.serverImageId, undefined);
    if (jobsRef.current[0]?.objectUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(jobsRef.current[0]!.objectUrl!);
    }
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] Import 批次清空只等待一次 accept 并聚合 50+ 取消", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let releaseAccept: ((response: Response) => void) | undefined;
  let acceptRequests = 0;
  let statusRequests = 0;
  let cancelResponseStatus: "discarded" | "completed" = "discarded";
  const cancelBodies: Array<{ items: unknown[] }> = [];
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    if (path === importAcceptPath) {
      acceptRequests += 1;
      const body = JSON.parse(String(init.body)) as {
        items: Array<{ batch_key: string; batch_position: number }>;
      };
      assert.equal(new Set(body.items.map((item) => item.batch_key)).size, 1);
      assert.deepEqual(
        body.items.map((item) => item.batch_position),
        Array.from({ length: 60 }, (_, index) => index)
      );
      return new Promise<Response>((resolve) => {
        releaseAccept = resolve;
      });
    }
    if (path === ingestionStatusPath) {
      statusRequests += 1;
      throw new Error("known accepted versions must not need status reads");
    }
    if (path === ingestionCancelPath) {
      const body = JSON.parse(String(init.body)) as {
        items: Array<{ session_id: string; image_id: string }>;
      };
      cancelBodies.push(body);
      return new Response(JSON.stringify({
        ok: true,
        items: body.items.map((item) => ({
          ...item,
          status: cancelResponseStatus,
          ...(cancelResponseStatus === "completed" ? {
            completed_item: adminImageListItem({ id: item.image_id })
          } : {})
        }))
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    throw new Error(`unexpected fetch ${path}`);
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    setCsrfToken("import-batch-cancel-token");
    const { createRoot } = await import("react-dom/client");
    const { useImport } = await import(
      "../../../packages/web/src/pages/admin/ingestion/import/useImport.ts"
    );
    const jobsRef = { current: [] as IngestionJob[] };
    const updateJob = (id: string, patch: Partial<IngestionJob>) => {
      jobsRef.current = jobsRef.current.map((job) => (
        job.id === id ? { ...job, ...patch } : job
      ));
    };
    const queue = {
      jobsRef,
      observeCompletedIngestions: () => undefined,
      appendJobs: (jobs: IngestionJob[]) => {
        jobsRef.current = [...jobsRef.current, ...jobs];
        return true;
      },
      updateJob,
      bindServerJob: (
        id: string,
        binding: Partial<IngestionJob> & {
          sessionId: string;
          imageId: string;
        }
      ) => {
        updateJob(id, binding);
        // Simulate the combined-page owner immediately detaching an off-page
        // accepted pair while the frozen clear intent is still waiting.
        jobsRef.current = jobsRef.current.filter((job) => job.id !== id);
      },
      captureServerConnectionGeneration: () => 1
    };
    let owner: ReturnType<typeof useImport> | undefined;
    function Probe() {
      owner = useImport({
        queue: queue as never,
        defaults: {
          device: "pc",
          brightness: "dark",
          theme: "none",
          author: "",
          tags: []
        },
        keepOriginalLinkForUrlImports: true,
        storageSlug: "local"
      });
      return null;
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const importBatchKey = webUuidV7();
    const jobs = Array.from({ length: 60 }, (_, index) => ingestionJob({
      id: `import-batch-${index}`,
      attemptKey: webUuidV7(),
      batchKey: importBatchKey,
      batchPosition: index,
      downloadUrl: `https://example.com/image-${index}.jpg`,
      draft: {
        ...ingestionJob().draft,
        original: `https://example.com/image-${index}.jpg`
      }
    }));
    await owner!.addParsedImports(jobs);
    assert.equal(acceptRequests, 1);
    assert.ok(releaseAccept);
    const cancellation = owner!.cancelMany([...jobsRef.current]);
    await Promise.resolve();
    assert.equal(
      jobsRef.current.filter((job) => job.status === "cancelling").length,
      60
    );
    releaseAccept!(new Response(JSON.stringify({
      ok: true,
      items: jobs.map((job, index) => ({
        session_id: String(index).padStart(43, "S"),
        image_id: `019f8457-063a-7${String(index).padStart(3, "0")}-a580-7a432dc7fd8e`,
        resolved_image_time: "2026-08-23T01:02:03.456Z",
        request_hash: job.attemptKey,
        status: "accepted",
        accepted_order: index + 1,
        version: 1,
        last_semantic_revision: index + 1
      }))
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    const outcomes = await cancellation;
    assert.equal(statusRequests, 0);
    assert.equal(cancelBodies.length, 1);
    assert.equal(cancelBodies[0]?.items.length, 60);
    assert.equal(
      [...outcomes.values()].filter((outcome) => outcome.succeeded).length,
      60
    );
    cancelResponseStatus = "completed";
    const retryJob = ingestionJob({
      id: "import-retry-completed",
      attemptKey: "import-retry-completed-attempt",
      kind: "import",
      downloadUrl: "https://example.com/completed.jpg",
      sessionId: "R".repeat(43),
      imageId: "019f8457-063a-7024-a580-7a432dc7fd8e",
      serverAccepted: true,
      serverVersion: 1,
      status: "failed",
      failureStage: "prepare"
    });
    jobsRef.current = [retryJob];
    await owner!.retry(retryJob);
    assert.equal(
      acceptRequests,
      1,
      "取消返回 completed 时 retry 不得生成新 attempt 或重新 accept"
    );
    assert.equal(jobsRef.current[0]?.attemptKey, retryJob.attemptKey);
    assert.equal(jobsRef.current[0]?.status, "finalized");
    await React.act(async () => root.unmount());
  } finally {
    clearCsrfToken();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] Upload 与 Import 接管只使用固定短路由和 1 + N 请求预算", async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const fetchCalls: Array<{ path: string; init: RequestInit }> = [];
  const sessionIds = ["A".repeat(43), "B".repeat(43)];
  const imageIds = [
    "019f8457-063a-7001-a580-7a432dc7fd8e",
    "019f8457-063a-7002-a580-7a432dc7fd8e"
  ];
  const metadata = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: "none",
    author: "",
    title: "最大字段由 JSON 承载",
    description: "description",
    source: "",
    original: "",
    tags: Array.from({ length: 50 }, (_, index) => `tag-${index}`)
  };

  class FakeXmlHttpRequest {
    static instances: FakeXmlHttpRequest[] = [];
    upload: { onprogress?: (event: ProgressEvent) => void } = {};
    headers = new Map<string, string>();
    method = "";
    url = "";
    status = 0;
    responseText = "";
    body: unknown;
    onload?: () => void;
    onerror?: () => void;
    onabort?: () => void;

    constructor() {
      FakeXmlHttpRequest.instances.push(this);
    }

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name: string, value: string) {
      this.headers.set(name.toLowerCase(), value);
    }

    send(body: unknown) {
      this.body = body;
      const index = FakeXmlHttpRequest.instances.indexOf(this);
      this.status = 200;
      this.responseText = JSON.stringify({
        ok: true,
        session_id: sessionIds[index],
        image_id: imageIds[index],
        status: "accepted",
        version: 1
      });
      queueMicrotask(() => {
        this.upload.onprogress?.({
          lengthComputable: true,
          loaded: 1,
          total: 1
        } as ProgressEvent);
        this.onload?.();
      });
    }

    abort() {
      this.onabort?.();
    }
  }

  globalThis.fetch = (async (input, init = {}) => {
    const path = String(input);
    fetchCalls.push({ path, init });
    if (path === uploadIntentPath) {
      const items = JSON.parse(String(init.body)).items as unknown[];
      return new Response(JSON.stringify({
        ok: true,
        items: items.map((_, index) => ({
          session_id: sessionIds[index],
          candidate_image_id: imageIds[index],
          resolved_image_time: "2026-08-23T01:02:03.456Z",
          request_hash: String(index + 1).repeat(64),
          credential: `credential-${index}`,
          expires_at: 1,
          status: "intent"
        }))
      }), { status: 200 });
    }
    if (path === importAcceptPath) {
      const items = JSON.parse(String(init.body)).items as unknown[];
      return new Response(JSON.stringify({
        ok: true,
        items: items.map((_, index) => ({
          session_id: sessionIds[index],
          image_id: imageIds[index],
          resolved_image_time: "2026-08-23T01:02:03.456Z",
          request_hash: String(index + 3).repeat(64),
          status: "accepted"
        }))
      }), { status: 200 });
    }
    if (path === ingestionStatusPath) {
      const items = JSON.parse(String(init.body)).items as Array<{
        session_id: string;
        image_id: string;
      }>;
      return new Response(JSON.stringify({
        ok: true,
        items: items.map((item) => ({ ...item, status: "missing" }))
      }), { status: 200 });
    }
    if (path.startsWith(`${ingestionSnapshotPath}?`)) {
      const request = new URL(path, "https://imageshow.test");
      return new Response(JSON.stringify({
        ok: true,
        queue: request.searchParams.get("queue"),
        revision: 0,
        total: 0,
        unfinished: 0,
        waiting: 0,
        running: 0,
        ready: 0,
        duplicate_pending: 0,
        committing: 0,
        resolving: 0,
        completed: 0,
        failed: 0,
        offset: Number(request.searchParams.get("offset")),
        limit: Number(request.searchParams.get("limit")),
        items: [],
        action_watermark: "watermark"
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${path}`);
  }) as typeof fetch;
  globalThis.XMLHttpRequest = FakeXmlHttpRequest as unknown as typeof XMLHttpRequest;
  setCsrfToken("csrf-current-import");
  try {
    const intentItems = imageIds.map((id, index) => ({
      ...metadata,
      idempotency_key: id,
      batch_key: "api-contract-upload-batch",
      batch_time: "2026-08-23T01:02:03.456Z",
      batch_position: index,
      storage_slug: "local",
      expected_size: 1,
      max_long_edge: 4096
    }));
    const intents = await createUploadIntents({ items: intentItems });
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0]?.path, uploadIntentPath);
    assert.equal(new URL(fetchCalls[0]!.path, "https://imageshow.test").search, "");
    assert.equal((JSON.parse(String(fetchCalls[0]?.init.body)).items as unknown[]).length, 2);
    assert.equal(
      new Headers(fetchCalls[0]?.init.headers).get("x-csrf-token"),
      "csrf-current-import"
    );

    const files = [
      new File(["a"], "a.webp", { type: "image/webp" }),
      new File(["b"], "b.webp", { type: "image/webp" })
    ];
    await Promise.all(intents.items.map((item, index) => {
      assert.equal(item.status, "intent");
      if (item.status !== "intent") throw new Error("intent expected");
      return uploadRaw(item.credential, files[index]!, {
        onProgress: () => undefined
      }).promise;
    }));
    assert.equal(FakeXmlHttpRequest.instances.length, 2);
    assert.ok(FakeXmlHttpRequest.instances.every((request) => (
      request.method === "PUT"
      && request.url === uploadRawPath
      && new URL(request.url, "https://imageshow.test").search === ""
      && request.headers.has(uploadCredentialHeader)
      && request.body instanceof File
    )));

    await acceptImports({
      items: imageIds.map((id, index) => ({
        ...metadata,
        idempotency_key: id,
        batch_key: "api-contract-import-batch",
        source_type: "url",
        download_url: `https://example.com/${index}.webp`,
        batch_position: index,
        storage_slug: "local"
      }))
    });
    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[1]?.path, importAcceptPath);
    assert.equal(
      (JSON.parse(String(fetchCalls[1]?.init.body)).items as unknown[]).length,
      2
    );
    await getIngestionStatuses(sessionIds.map((sessionId, index) => ({
      session_id: sessionId,
      image_id: imageIds[index]!
    })));
    assert.equal(fetchCalls[2]?.path, ingestionStatusPath);
    await getIngestionQueueSnapshot({
      queue: "upload",
      offset: 20,
      limit: 10,
      exclude_items: [{
        session_id: sessionIds[0]!,
        image_id: imageIds[0]!
      }],
      include_items: [{
        session_id: sessionIds[0]!,
        image_id: imageIds[0]!
      }]
    }, "A".repeat(32));
    const snapshotCall = fetchCalls[3]!;
    const snapshotUrl = new URL(snapshotCall.path, "https://imageshow.test");
    assert.equal(snapshotUrl.pathname, ingestionSnapshotPath);
    assert.equal(snapshotCall.init.method, "POST");
    assert.deepEqual(Object.fromEntries(snapshotUrl.searchParams), {
      queue: "upload",
      offset: "20",
      limit: "10"
    });
    assert.deepEqual(JSON.parse(String(snapshotCall.init.body)), {
      exclude_items: [{
        session_id: sessionIds[0],
        image_id: imageIds[0]
      }],
      include_items: [{
        session_id: sessionIds[0],
        image_id: imageIds[0]
      }]
    });
    assert.equal(
      new Headers(snapshotCall.init.headers).get(ingestionActionScopeHeader),
      "A".repeat(32)
    );
  } finally {
    clearCsrfToken();
    globalThis.fetch = originalFetch;
    globalThis.XMLHttpRequest = originalXhr;
  }
});
test("[Web/内容接入] 队列事件只合并连续 semantic 与同版本递增 progress", () => {
  const summary = {
    total: 1,
    unfinished: 1,
    waiting: 0,
    running: 1,
    ready: 0,
    duplicate_pending: 0,
    committing: 0,
    resolving: 0,
    completed: 0,
    failed: 0
  };
  const active = {
    session_id: "S".repeat(43),
    image_id: "019f8457-063a-7005-a580-7a432dc7fd8e",
    queue: "upload" as const,
    source_type: "upload" as const,
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing" as const,
    phase: "prepare",
    message: "processing",
    progress: 20,
    version: 2,
    progress_seq: 2,
    last_semantic_revision: 5,
    accepted_at: 1,
    accepted_order: 1,
    metadata: {
      device: "auto" as const,
      brightness: "auto" as const,
      theme: "none",
      author: "",
      title: "event item",
      description: "",
      source: "",
      original: "",
      tags: []
    },
    storage_slug: "local"
  };
  let baseline = baselineFromIngestionSnapshot({
    ...summary,
    queue: "upload",
    revision: 5,
    last_accepted_order: 1,
    offset: 0,
    limit: 20,
    items: [active],
    stale_items: [],
    action_watermark: "watermark-5"
  });
  const emptySelection = {
    offset: 0,
    limit: 20,
    requiredItems: 20,
    excludeItems: [],
    includeItems: []
  };
  const selectedPair = {
    session_id: active.session_id,
    image_id: active.image_id
  };
  const selectedCurrentItem = {
    ...emptySelection,
    excludeItems: [selectedPair],
    includeItems: [selectedPair]
  };
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      baseline,
      emptySelection,
      selectedCurrentItem
    ),
    true,
    "已读到队尾且新筛选任务已在基线中时不得重复 snapshot"
  );
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      {
        ...baseline,
        summary: { ...baseline.summary, total: 60 }
      },
      emptySelection,
      selectedCurrentItem
    ),
    false,
    "满队列中筛掉当前行后可能需要补位，不能错误复用短基线"
  );
  const reservoirItems = Array.from({ length: 20 }, (_, index) => ({
    ...active,
    session_id: index === 0
      ? active.session_id
      : String(index).padStart(43, "R"),
    image_id: index === 0
      ? active.image_id
      : `019f8457-063a-72${String(index).padStart(2, "0")}-a580-7a432dc7fd8e`,
    accepted_order: index + 1
  }));
  const reservoirBaseline = {
    ...baseline,
    summary: { ...baseline.summary, total: 60 },
    items: reservoirItems
  };
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      reservoirBaseline,
      emptySelection,
      {
        ...selectedCurrentItem,
        requiredItems: 19
      }
    ),
    true,
    "筛选变化后替补仍覆盖实际展示槽位时不得为补满缓存重复读取"
  );
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      reservoirBaseline,
      emptySelection,
      selectedCurrentItem
    ),
    false,
    "实际展示需要完整 20 行时不能把 19 行替补误判为覆盖"
  );
  assert.equal(
    ingestionQueueBaselineCoversSelection(
      baseline,
      selectedCurrentItem,
      emptySelection
    ),
    false,
    "移除筛选会改变 Server 页面成员，必须重新读取"
  );
  const skippedProgress = mergeIngestionQueueMutation(baseline, {
    type: "mutation",
    queue: "upload",
    kind: "progress",
    revision: 5,
    last_accepted_order: 1,
    summary,
    session: { ...active, progress: 90, progress_seq: 9 }
  });
  assert.equal(skippedProgress.kind, "accepted");
  assert.equal(skippedProgress.baseline.items[0]?.progress_seq, 9);
  baseline = skippedProgress.baseline;

  const delayedProgress = mergeIngestionQueueMutation(baseline, {
    type: "mutation",
    queue: "upload",
    kind: "progress",
    revision: 5,
    last_accepted_order: 1,
    summary,
    session: { ...active, version: 1, progress_seq: 99 }
  });
  assert.equal(delayedProgress.kind, "ignored");

  const semantic = mergeIngestionQueueMutation(baseline, {
    type: "mutation",
    queue: "upload",
    kind: "semantic",
    revision: 6,
    last_accepted_order: 1,
    summary: { ...summary, running: 0, ready: 1 },
    action_watermark: "watermark-6",
    session: {
      ...active,
      status: "ready",
      phase: "ready",
      message: "ready",
      progress: 100,
      version: 3,
      progress_seq: 0,
      last_semantic_revision: 6
    }
  });
  assert.equal(semantic.kind, "accepted");
  assert.equal(semantic.baseline.revision, 6);
  assert.equal(semantic.baseline.items[0]?.version, 3);
  assert.equal(semantic.baseline.actionWatermark, "watermark-6");

  const semanticGap = mergeIngestionQueueMutation(semantic.baseline, {
    type: "mutation",
    queue: "upload",
    kind: "semantic",
    revision: 8,
    last_accepted_order: 1,
    summary,
    session: { ...active, version: 4, last_semantic_revision: 8 }
  });
  assert.equal(semanticGap.kind, "reload");

  const completed = mergeIngestionQueueMutation(semantic.baseline, {
    type: "mutation",
    queue: "upload",
    kind: "semantic",
    revision: 7,
    last_accepted_order: 1,
    summary: { ...summary, unfinished: 0, running: 0, completed: 1 },
    action_watermark: "watermark-7",
    session: {
      session_id: active.session_id,
      image_id: active.image_id,
      status: "completed",
      version: 4,
      progress_seq: 0,
      last_semantic_revision: 7,
      accepted_at: 1,
      accepted_order: 1
    }
  });
  assert.equal(
    completed.kind,
    "accepted",
    "compact completed 应推进全局 metadata，并由精确 status owner 补齐 DTO"
  );
  assert.equal(completed.baseline.revision, 7);
  assert.equal(completed.baseline.summary.completed, 1);
  assert.equal(
    completed.baseline.items[0]?.status,
    "ready",
    "bounded page 不得用 compact 回执伪造完整 completed DTO"
  );
  const completedItem = adminImageListItem({ id: active.image_id });
  const hydratedCompleted = mergeIngestionQueueMutation(semantic.baseline, {
    type: "mutation",
    queue: "upload",
    kind: "semantic",
    revision: 7,
    last_accepted_order: 1,
    summary: { ...summary, unfinished: 0, running: 0, completed: 1 },
    action_watermark: "watermark-7",
    session: {
      session_id: active.session_id,
      image_id: active.image_id,
      queue: "upload",
      status: "completed",
      version: 4,
      progress_seq: 0,
      last_semantic_revision: 7,
      accepted_at: 1,
      accepted_order: 1,
      completed_at: 2,
      completed_item: completedItem
    }
  });
  assert.equal(
    hydratedCompleted.kind,
    "accepted",
    "携带 PostgreSQL 完成投影的 SSE 不得再请求同页 snapshot"
  );
  assert.equal(hydratedCompleted.baseline.items[0]?.status, "completed");
  assert.equal(
    hydratedCompleted.baseline.items[0]?.completed_item.id,
    completedItem.id
  );
});
test("[Web/内容接入] 队列 progress 以当前 revision 同步页内与离页汇总且不回退", () => {
  const waitingSummary = {
    total: 1,
    unfinished: 1,
    waiting: 1,
    running: 0,
    ready: 0,
    duplicate_pending: 0,
    committing: 0,
    resolving: 0,
    completed: 0,
    failed: 0
  };
  const runningSummary = {
    ...waitingSummary,
    waiting: 0,
    running: 1
  };
  const waiting = {
    session_id: "W".repeat(43),
    image_id: "019f8457-063a-7005-a580-7a432dc7fd8e",
    queue: "upload" as const,
    source_type: "upload" as const,
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "preparing" as const,
    phase: "prepare-waiting",
    message: "waiting",
    progress: 0,
    version: 2,
    progress_seq: 0,
    last_semantic_revision: 5,
    accepted_at: 1,
    accepted_order: 1,
    metadata: {
      device: "auto" as const,
      brightness: "auto" as const,
      theme: "none",
      author: "",
      title: "waiting item",
      description: "",
      source: "",
      original: "",
      tags: []
    },
    storage_slug: "local"
  };
  const normalizing = {
    ...waiting,
    phase: "normalizing",
    message: "processing",
    progress: 1,
    progress_seq: 1
  };
  const progressEvent = {
    type: "mutation" as const,
    queue: "upload" as const,
    kind: "progress" as const,
    revision: 5,
    last_accepted_order: 1,
    summary: runningSummary,
    session: normalizing
  };
  const pageBaseline = baselineFromIngestionSnapshot({
    ...waitingSummary,
    queue: "upload",
    revision: 5,
    last_accepted_order: 1,
    offset: 0,
    limit: 20,
    items: [waiting],
    stale_items: [],
    action_watermark: "watermark-5"
  });
  const pageResult = mergeIngestionQueueMutation(pageBaseline, progressEvent);
  assert.equal(pageResult.kind, "accepted");
  const mergedPageItem = pageResult.baseline.items[0];
  assert.equal(
    mergedPageItem && "phase" in mergedPageItem
      ? mergedPageItem.phase
      : undefined,
    "normalizing"
  );
  assert.deepEqual(pageResult.baseline.summary, runningSummary);

  const offPageBaseline = {
    ...pageBaseline,
    items: []
  };
  const offPageResult = mergeIngestionQueueMutation(
    offPageBaseline,
    progressEvent
  );
  assert.equal(offPageResult.kind, "accepted");
  assert.deepEqual(offPageResult.baseline.summary, runningSummary);
  assert.deepEqual(offPageResult.baseline.items, []);

  const delayedRevision = mergeIngestionQueueMutation(
    {
      ...offPageBaseline,
      revision: 6,
      summary: runningSummary
    },
    {
      ...progressEvent,
      revision: 5,
      summary: waitingSummary
    }
  );
  assert.equal(delayedRevision.kind, "ignored");
  assert.deepEqual(delayedRevision.baseline.summary, runningSummary);

  const delayedSameRevisionOffPage = mergeIngestionQueueMutation(
    {
      ...offPageBaseline,
      summary: {
        ...runningSummary,
        total: 2,
        unfinished: 2,
        running: 2
      }
    },
    {
      ...progressEvent,
      summary: {
        ...runningSummary,
        total: 2,
        unfinished: 2,
        waiting: 1,
        running: 1
      }
    }
  );
  assert.equal(delayedSameRevisionOffPage.kind, "ignored");
  assert.equal(delayedSameRevisionOffPage.baseline.summary.waiting, 0);
  assert.equal(delayedSameRevisionOffPage.baseline.summary.running, 2);

  const delayedProgress = mergeIngestionQueueMutation(
    pageResult.baseline,
    {
      ...progressEvent,
      summary: waitingSummary,
      session: waiting
    }
  );
  assert.equal(delayedProgress.kind, "ignored");
  assert.deepEqual(delayedProgress.baseline.summary, runningSummary);
});
test("[Web/内容接入] 异步提交仅发送冻结意图并由 pair 状态完成水合", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ path: string; init: RequestInit }> = [];
  const sessionIds = ["A".repeat(43), "B".repeat(43)];
  const imageIds = [
    "019f8457-063a-7005-a580-7a432dc7fd8e",
    "019f8457-063a-7006-a580-7a432dc7fd8e"
  ];
  const attemptIds = [
    "019f8457-063a-7007-a580-7a432dc7fd8e",
    "019f8457-063a-7008-a580-7a432dc7fd8e"
  ];
  const commitRequestIds = [
    "019f8457-063a-7009-a580-7a432dc7fd8e",
    "019f8457-063a-700a-a580-7a432dc7fd8e"
  ];
  const jobs = imageIds.map((imageId, index) => {
    const ready = ingestionJob({
      id: `commit-${index}`,
      attemptKey: attemptIds[index],
      sessionId: sessionIds[index],
      imageId,
      status: "ready",
      serverVersion: 4,
      duplicateDecision: "upload"
    });
    return {
      ...ready,
      commitIntent: createIngestionCommitIntent(
        ready,
        commitRequestIds[index]
      )
    };
  });
  const current = new Map(jobs.map((job) => [job.id, job]));
  const completedCommitItem = adminImageListItem({ id: imageIds[1] });
  const observedCompleted: string[] = [];
  globalThis.fetch = (async (input, init = {}) => {
    const path = String(input);
    calls.push({ path, init });
    if (path !== ingestionCommitPath) throw new Error(`unexpected fetch ${path}`);
    return new Response(JSON.stringify({
      ok: true,
      items: jobs.map((job, index) => ({
        session_id: job.sessionId,
        image_id: job.imageId,
        status: index === 0 ? "accepted" : "completed",
        version: 5,
        ...(index === 0 ? {} : { completed_item: completedCommitItem })
      }))
    }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal(await commitSelectedIngestions({
      selected: jobs,
      getJob: (id) => current.get(id),
      observeCompletedIngestions: (entries) => {
        observedCompleted.push(...entries.map(({ pair }) => pair.image_id));
      },
      updateJob: (id, patch) => {
        const job = current.get(id);
        if (job) current.set(id, { ...job, ...patch });
      }
    }), 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.path, ingestionCommitPath);
    const body = JSON.parse(String(calls[0]?.init.body));
    assert.equal(body.items.length, 2);
    assert.equal("created_by" in body.items[0], false);
    assert.deepEqual(
      body.items.map((item: Record<string, unknown>) => [
        item.session_id,
        item.image_id,
        item.expected_version,
        item.expected_md5,
        item.commit_request_id
      ]),
      jobs.map((job) => [
        job.sessionId,
        job.imageId,
        4,
        job.commitIntent.md5,
        job.commitIntent.attemptId
      ])
    );
    assert.equal(current.get(jobs[0]!.id)?.status, "committing");
    assert.equal(current.get(jobs[1]!.id)?.status, "finalized");
    assert.deepEqual(
      observedCompleted,
      [imageIds[1]],
      "同步 completed 提交响应必须先进入 owner 失效入口"
    );

    const first = current.get(jobs[0]!.id)!;
    const completedItem = adminImageListItem({ id: imageIds[0] });
    const hydrated = ingestionStatusEventPatch(first, {
      session_id: sessionIds[0]!,
      image_id: imageIds[0]!,
      status: "completed",
      completed_item: completedItem,
      redis_status: "missing"
    });
    assert.equal(hydrated?.status, "done");
    assert.equal(hydrated?.resultState, "hydrated");
    assert.equal(hydrated?.md5, completedItem.md5);
    assert.equal(hydrated?.width, completedItem.width);
    assert.equal(hydrated?.height, completedItem.height);
    assert.equal(hydrated?.finalSize, completedItem.image_size);

    const lostResponseReady = ingestionJob({
      id: "commit-response-lost",
      attemptKey: "019f8457-063a-7014-a580-7a432dc7fd8e",
      sessionId: "R".repeat(43),
      imageId: "019f8457-063a-7015-a580-7a432dc7fd8e",
      status: "ready",
      serverVersion: 7,
      duplicateDecision: "upload"
    });
    const lostResponseJob = {
      ...lostResponseReady,
      commitIntent: createIngestionCommitIntent(
        lostResponseReady,
        "019f8457-063a-7016-a580-7a432dc7fd8e"
      )
    };
    const lostResponseCurrent = new Map([
      [lostResponseJob.id, lostResponseJob]
    ]);
    const lostResponseCompleted = adminImageListItem({
      id: lostResponseJob.imageId
    });
    const reconciledCompleted: string[] = [];
    globalThis.fetch = (async (input) => {
      if (String(input) === ingestionCommitPath) {
        return new Response("commit response lost", { status: 502 });
      }
      assert.equal(String(input), ingestionStatusPath);
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          session_id: lostResponseJob.sessionId,
          image_id: lostResponseJob.imageId,
          status: "completed",
          completed_item: lostResponseCompleted,
          redis_status: "missing"
        }]
      }), { status: 200 });
    }) as typeof fetch;
    assert.equal(await commitSelectedIngestions({
      selected: [lostResponseJob],
      getJob: (id) => lostResponseCurrent.get(id),
      observeCompletedIngestions: (entries) => {
        reconciledCompleted.push(...entries.map(({ pair }) => pair.image_id));
      },
      updateJob: (id, patch) => {
        const job = lostResponseCurrent.get(id);
        if (job) lostResponseCurrent.set(id, { ...job, ...patch });
      }
    }), 0);
    assert.equal(lostResponseCurrent.get(lostResponseJob.id)?.status, "done");
    assert.deepEqual(
      reconciledCompleted,
      [lostResponseJob.imageId],
      "提交响应丢失后的 status 完成态必须进入 owner 失效入口"
    );

    const duplicateReady = ingestionJob({
      id: "commit-duplicate",
      attemptKey: "019f8457-063a-700b-a580-7a432dc7fd8e",
      sessionId: "C".repeat(43),
      imageId: "019f8457-063a-700c-a580-7a432dc7fd8e",
      status: "ready",
      serverVersion: 5,
      duplicateDecision: "upload"
    });
    const duplicateJob = {
      ...duplicateReady,
      commitIntent: createIngestionCommitIntent(
        duplicateReady,
        "019f8457-063a-700d-a580-7a432dc7fd8e"
      )
    };
    const duplicateCurrent = new Map([[duplicateJob.id, duplicateJob]]);
    const duplicateItem = adminImageListItem({
      id: "019f8457-063a-700e-a580-7a432dc7fd8e"
    });
    globalThis.fetch = (async () => new Response(JSON.stringify({
      ok: true,
      items: [{
        session_id: duplicateJob.sessionId,
        image_id: duplicateJob.imageId,
        status: "failed",
        code: "ingestion_duplicate_conflict",
        message: "提交前发现相同内容图片",
        version: 6,
        duplicate_count: 23,
        duplicates: [duplicateItem]
      }]
    }), { status: 200 })) as typeof fetch;
    assert.equal(await commitSelectedIngestions({
      selected: [duplicateJob],
      getJob: (id) => duplicateCurrent.get(id),
      observeCompletedIngestions: () => undefined,
      updateJob: (id, patch) => {
        const job = duplicateCurrent.get(id);
        if (job) duplicateCurrent.set(id, { ...job, ...patch });
      }
    }), 0);
    const duplicateConflict = duplicateCurrent.get(duplicateJob.id)!;
    assert.equal(duplicateConflict.status, "ready");
    assert.equal(duplicateConflict.serverVersion, 6);
    assert.equal(duplicateConflict.duplicateCount, 23);
    assert.equal(duplicateConflict.duplicateDecision, "undecided");
    assert.deepEqual(duplicateConflict.duplicates, [duplicateItem]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("[Web/内容接入] 内容接入写后缓存每批只失效受新增图片影响的查询", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const allKeys = [
    queryKeys.publicImages,
    queryKeys.publicImageDetail,
    queryKeys.galleryFacets,
    queryKeys.galleryStats,
    queryKeys.adminImages,
    queryKeys.adminImageInfo,
    queryKeys.overview,
    queryKeys.themes,
    queryKeys.tags,
    queryKeys.authors,
    queryKeys.ingestionVocabulary
  ] as const;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  for (const key of allKeys) client.setQueryData([...key, "fixture"], {});
  const vocabulary: IngestionVocabularyDto = {
    themes: [{ slug: "none", display_name: "未分类" }],
    tags: [{ slug: "existing-tag", display_name: "既有标签" }],
    authors: [{ slug: "existing-author", display_name: "既有作者" }]
  };
  client.setQueryData(queryKeys.ingestionVocabulary, vocabulary);

  await invalidateImageDataAfterIngestion(client, [adminImageListItem()]);
  const invalidated = (
    queryClient: InstanceType<typeof QueryClient>,
    key: readonly unknown[]
  ) => (
    queryClient.getQueryState(key)?.isInvalidated === true
  );
  for (const key of [
    queryKeys.publicImages,
    queryKeys.galleryFacets,
    queryKeys.galleryStats,
    queryKeys.adminImages,
    queryKeys.overview,
    queryKeys.themes
  ]) {
    assert.equal(invalidated(client, [...key, "fixture"]), true, key[0]);
  }
  for (const key of [
    queryKeys.publicImageDetail,
    queryKeys.adminImageInfo,
    queryKeys.tags,
    queryKeys.authors
  ]) {
    assert.equal(invalidated(client, [...key, "fixture"]), false, key[0]);
  }
  assert.equal(invalidated(client, queryKeys.ingestionVocabulary), false);

  const changedClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  for (const key of [
    queryKeys.tags,
    queryKeys.authors,
    queryKeys.ingestionVocabulary
  ]) changedClient.setQueryData(key, key === queryKeys.ingestionVocabulary ? vocabulary : {});
  await invalidateImageDataAfterIngestion(changedClient, [adminImageListItem({
    theme: "new-theme",
    author: "new-author",
    tags: ["new-tag"]
  })]);
  assert.equal(changedClient.getQueryState(queryKeys.tags)?.isInvalidated, true);
  assert.equal(changedClient.getQueryState(queryKeys.authors)?.isInvalidated, true);
  assert.equal(
    changedClient.getQueryState(queryKeys.ingestionVocabulary)?.isInvalidated,
    true
  );
  const coveredClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  const coveredKey = [...queryKeys.adminImages, "covered-page"] as const;
  const coveredData = { items: [], total: 0, etag: 'W/"covered"' };
  coveredClient.setQueryData(coveredKey, coveredData);
  recordAdminImageListValidation(coveredClient, coveredKey, 200);
  let coveredReads = 0;
  const coveredObserver = new QueryObserver(coveredClient, {
    queryKey: coveredKey,
    queryFn: async () => {
      coveredReads += 1;
      recordAdminImageListValidation(coveredClient, coveredKey, Date.now());
      return coveredData;
    },
    staleTime: Infinity
  });
  const unsubscribeCovered = coveredObserver.subscribe(() => undefined);
  await invalidateImageDataAfterIngestion(
    coveredClient,
    [adminImageListItem()],
    { completedAt: 100 }
  );
  assert.equal(coveredReads, 0, "已覆盖完成水位的列表不得条件重读");
  recordAdminImageListValidation(coveredClient, coveredKey, 300);
  await invalidateImageDataAfterIngestion(
    coveredClient,
    [adminImageListItem()],
    { completedAt: 300 }
  );
  assert.equal(
    coveredReads,
    1,
    "列表读取与完成事件处于同一毫秒时仍必须恰好重读一次"
  );
  unsubscribeCovered();

  const inFlightClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const inFlightKey = [...queryKeys.adminImages, "in-flight-page"] as const;
  let inFlightReads = 0;
  let inFlightAborted = false;
  let resolveInFlight: (() => void) | undefined;
  const inFlightObserver = new QueryObserver(inFlightClient, {
    queryKey: inFlightKey,
    queryFn: async ({ signal }) => {
      inFlightReads += 1;
      signal.addEventListener("abort", () => { inFlightAborted = true; });
      const validationStartedAt = inFlightReads === 1 ? 300 : 500;
      if (inFlightReads === 1) {
        await new Promise<void>((resolve) => { resolveInFlight = resolve; });
      }
      recordAdminImageListValidation(
        inFlightClient,
        inFlightKey,
        validationStartedAt
      );
      return coveredData;
    }
  });
  const unsubscribeInFlight = inFlightObserver.subscribe(() => undefined);
  await Promise.resolve();
  const invalidatingInFlight = invalidateImageDataAfterIngestion(
    inFlightClient,
    [adminImageListItem()],
    { completedAt: 400 }
  );
  await Promise.resolve();
  assert.equal(inFlightAborted, false, "完成失效不得取消同一在途列表");
  assert.equal(inFlightReads, 1, "在途列表不得叠加第二个读取");
  assert.ok(resolveInFlight);
  resolveInFlight();
  await invalidatingInFlight;
  assert.equal(
    inFlightReads,
    2,
    "早于完成水位的在途读取结束后必须顺序补一次读取"
  );
  assert.equal(inFlightAborted, false, "尾随读取也不得取消原始请求");
  unsubscribeInFlight();

  const authorProfileClient = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  for (const key of allKeys) authorProfileClient.setQueryData(key, {});
  await invalidateDataAfterAuthorProfileSave(authorProfileClient);
  for (const key of [
    queryKeys.galleryFacets,
    queryKeys.galleryStats,
    queryKeys.ingestionVocabulary
  ]) {
    assert.equal(invalidated(authorProfileClient, key), true, key[0]);
  }
  for (const key of [
    queryKeys.authors,
    queryKeys.publicImages,
    queryKeys.adminImages,
    queryKeys.overview,
    queryKeys.tags,
    queryKeys.themes
  ]) {
    assert.equal(invalidated(authorProfileClient, key), false, key[0]);
  }
  client.clear();
  changedClient.clear();
  coveredClient.clear();
  inFlightClient.clear();
  authorProfileClient.clear();
});
test("[Web/内容接入] 元数据保存只在词条超出共享接入词表时刷新一次", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const vocabulary: IngestionVocabularyDto = {
    themes: [{ slug: "none", display_name: "未分类" }],
    authors: [{ slug: "known-author", display_name: "已有作者" }],
    tags: [{ slug: "known-tag", display_name: "已有标签" }]
  };
  for (const scenario of [
    { updates: [{ id: "one", title: "仅标题" }], reads: 0 },
    { updates: [{ id: "one", theme: "none", author: "known-author", tags: ["known-tag"] }], reads: 0 },
    { updates: [{ id: "one", author: "", tags: [] }], reads: 0 },
    { updates: [{ id: "one", theme: "new-theme" }], reads: 1 },
    { updates: [{ id: "one", author: "new-author" }], reads: 1 },
    { updates: [{ id: "one", tags: ["new-tag"] }], reads: 1 },
    { updates: [{ id: "one", theme: "new-theme" }, { id: "two", tags: ["new-tag"] }], reads: 1 },
    { updates: [{ id: "one", tags: ["unconfirmed-tag"] }], reads: 1, confirmationLost: true },
    { updates: [], reads: 0 }
  ]) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(queryKeys.ingestionVocabulary, vocabulary);
    let reads = 0;
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.ingestionVocabulary,
      staleTime: Infinity,
      queryFn: async () => {
        reads += 1;
        return { ...vocabulary, tags: [...vocabulary.tags, { slug: "new-tag", display_name: "新标签" }] };
      }
    });
    const unsubscribe = observer.subscribe(() => undefined);
    try {
      await invalidateImageDataAfterMetadataSave(client, scenario.updates,
        scenario.confirmationLost ? null : scenario.updates.map(({ id }) => ({ id })));
      assert.equal(reads, scenario.reads, JSON.stringify(scenario));
      if (reads) assert.ok(client.getQueryData<IngestionVocabularyDto>(queryKeys.ingestionVocabulary)?.tags.some(({ slug }) => slug === "new-tag"));
    } finally {
      unsubscribe();
      client.clear();
    }
  }
  const unusedClient = new QueryClient();
  await invalidateImageDataAfterMetadataSave(unusedClient, [{ id: "one", theme: "new-theme" }], null);
  assert.equal(unusedClient.getQueryState(queryKeys.ingestionVocabulary), undefined, "未打开过的词表不创建新查询");
  unusedClient.clear();
});
test("[Web/内容接入] 上传与导入窗口真实挂载保持双行摘要、来源切换和关闭回焦", async (t) => {
  assert.equal(
    ingestionJobStatusLabel(ingestionJob({ status: "commit-queued" })),
    "提交排队",
    "稳定配色不得掩盖真实的提交排队状态"
  );
  assert.equal(
    ingestionJobStatusLabel(ingestionJob({ status: "committing" })),
    "提交中",
    "稳定配色不得把真实提交状态伪装成已就绪"
  );
  const { window, document } = parseHTML(
    "<!doctype html><html><body><button id=return-target>打开上传</button><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  const matchMedia = (query: string) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  Object.assign(window, {
    requestAnimationFrame,
    cancelAnimationFrame,
    matchMedia,
    scrollTo() {},
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 720
  });
  const clock = installControlledClock(t, window as unknown as Window);

  let activeElement: HTMLElement | null = null;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => activeElement
  });
  const originalFocus = window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus = function focus() {
    activeElement = this;
  };

  let fetchCount = 0;
  const windowDuplicateMd5 = "e".repeat(32);
  const windowDuplicateItem = adminImageListItem({
    id: "019f8457-063a-7034-a580-7a432dc7fd8e",
    md5: windowDuplicateMd5
  });
  const fetchStub = async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "https://imageshow.test").pathname;
    if (path === ingestionDuplicatesPath) {
      return new Response(JSON.stringify({
        ok: true,
        items: [{
          md5: windowDuplicateMd5,
          match_count: 1,
          duplicates: [windowDuplicateItem]
        }]
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    fetchCount += 1;
    throw new Error("内容接入窗口渲染不应发起请求");
  };
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    fetch: fetchStub,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  let deregisterCssHooks = () => {};
  try {
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    deregisterCssHooks = () => cssHooks.deregister();
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider } = await import(
      "../../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { IngestionWorkflowWindow } = await import(
      "../../../packages/web/src/pages/admin/ingestion/workflow/IngestionWorkflowWindow.tsx"
    );
    const rootElement = document.getElementById("root");
    const returnTarget = document.getElementById("return-target") as HTMLElement;
    assert.ok(rootElement);
    returnTarget.focus();
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: Number.POSITIVE_INFINITY,
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnWindowFocus: false
        }
      }
    });
    client.setQueryData(queryKeys.me, {
      authenticated: true,
      username: "workflow-window-test",
      role: "super",
      permissions: [],
      csrf_token: "workflow-window-token",
      application_version: "current-test",
      preferences: {},
      preferences_etag: 'W/"workflow-window-preferences"',
      version_settings: { enabled: true, link_enabled: true }
    });
    client.setQueryData(queryKeys.siteConfig, {
      site: { static_url: "https://static.example.com" }
    });
    client.setQueryData(queryKeys.galleryFacets, {
      themes: [],
      tags: [],
      authors: []
    });

    const sourceSelections: string[] = [];
    let closeCount = 0;
    let prepareCloseCount = 0;
    let finishPreparedCloseCount = 0;
    let fallbackCloseCount = 0;
    const closeOptions: Array<Readonly<{
      skipCompletedCleanup?: boolean;
    }> | undefined> = [];
    let clearArmCount = 0;
    let clearConfirmCount = 0;
    let clearShouldSucceed = false;
    let delayClearConfirmation = false;
    let resolveClearConfirmation: ((closed: boolean) => void) | undefined;
    let cleanupConfirmCount = 0;
    let cleanupRunCount = 0;
    let commitReadyCount = 0;
    let applyDefaultsCount = 0;
    let setHarnessOpen: ((open: boolean) => void) | undefined;
    let setHarnessBusy: ((busy: boolean) => void) | undefined;
    let setHarnessMode: ((mode: "upload" | "import") => void) | undefined;
    let setHarnessJobs: ((jobs: IngestionJob[]) => void) | undefined;
    let setHarnessTotalItems: ((total: number | null) => void) | undefined;
    type HarnessServerStatus =
      | "idle"
      | "connecting"
      | "loading"
      | "ready"
      | "disconnected"
      | "error";
    let setHarnessServerStatus: ((status: HarnessServerStatus) => void)
      | undefined;
    let setHarnessTransientFlags: ((flags: {
      actionBusy: boolean;
      pendingAuthorityHandoff: boolean;
    }) => void) | undefined;
    const emptyJobs: IngestionJob[] = [];
    const queueBase = {
      page: 1,
      totalPages: 1,
      serverNotice: "",
      serverNoticeRetryable: false,
      pendingAuthorityHandoff: false,
      actions: {
        busy: false,
        notice: "",
        identity: "test-action-scope"
      },
      server: {
        status: "ready",
        summary: null,
        error: "",
        refresh() {}
      },
      setPage() {},
      applyDefaultsToLocalJobs() {},
      removeLibraryDuplicate() {},
      updateJobs() {},
      updateDuplicateDecision: async () => true
    };

    function Harness() {
      const [open, setOpen] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [workflowMode, setWorkflowMode] = React.useState<"upload" | "import">(
        "import"
      );
      const [jobs, setJobs] = React.useState(emptyJobs);
      const [totalItemsOverride, setTotalItemsOverride] = React.useState<
        number | null
      >(null);
      const [serverStatus, setServerStatus] = React.useState<
        HarnessServerStatus
      >("loading");
      const [transientFlags, setTransientFlags] = React.useState({
        actionBusy: false,
        pendingAuthorityHandoff: false
      });
      setHarnessOpen = setOpen;
      setHarnessBusy = setBusy;
      setHarnessMode = setWorkflowMode;
      setHarnessJobs = setJobs;
      setHarnessTotalItems = setTotalItemsOverride;
      setHarnessServerStatus = setServerStatus;
      setHarnessTransientFlags = setTransientFlags;
      const [sourceMode, setSourceMode] = React.useState<
        "urls" | "jsonl" | "weibo"
      >("urls");
      const returnFocusRef = React.useRef<HTMLElement | null>(returnTarget);
      if (!open) return null;
      const queue = {
        ...queueBase,
        pendingAuthorityHandoff: transientFlags.pendingAuthorityHandoff,
        actions: {
          ...queueBase.actions,
          busy: transientFlags.actionBusy
        },
        jobs,
        localJobs: jobs,
        jobsRef: { current: jobs },
        server: {
          ...queueBase.server,
          status: serverStatus
        },
        totalItems: totalItemsOverride ?? jobs.length,
        visibleJobs: jobs,
        summary: summarizeIngestionJobs(jobs),
        uncommittedCount: jobs.length
      };
      return React.createElement(IngestionWorkflowWindow, {
        mode: workflowMode,
        busy,
        queue: queue as never,
        returnFocusRef,
        onPrepareClose: (options) => {
          prepareCloseCount += 1;
          return () => {
            finishPreparedCloseCount += 1;
            closeCount += 1;
            closeOptions.push(options);
            setOpen(false);
          };
        },
        onClose: (options) => {
          fallbackCloseCount += 1;
          closeCount += 1;
          closeOptions.push(options);
          setOpen(false);
        },
        defaults: {
          device: "auto",
          brightness: "auto",
          theme: "",
          author: "",
          tags: []
        },
        onDefaultsChange() {},
        themes: [],
        tags: [],
        authors: [],
        importParseErrors: [],
        onClearImportParseErrors() {},
        storageName: (slug: string) => slug,
        onAddFiles() {},
        onPatchJob() {},
        onCancelJob() {},
        onRetryJob() {},
        onRemoveJob() {},
        onConfirmDuplicateJob() {},
        onApplyDefaults() { applyDefaultsCount += 1; },
        onCleanupAction() { cleanupRunCount += 1; },
        onArmCleanupAction: (_action, confirmationCount) => ({
          count: confirmationCount
        }),
        onConfirmCleanupAction: async () => {
          cleanupConfirmCount += 1;
          return true;
        },
        onDiscardUnconfirmedIntents() {},
        confirmationScope: "test-confirmation-scope",
        onArmClearQueue: () => {
          clearArmCount += 1;
          return true;
        },
        onConfirmClearQueue: async () => {
          clearConfirmCount += 1;
          if (delayClearConfirmation) {
            return new Promise<boolean>((resolve) => {
              resolveClearConfirmation = resolve;
            });
          }
          return clearShouldSucceed;
        },
        activeBackend: "local",
        backendOptions: [{ value: "local", label: "本地" }],
        onBackendChange() {},
        async onCommitReady() { commitReadyCount += 1; },
        sourceDialogPending: false,
        sourceDialogOpen: false,
        sourceDialogComponent: null,
        importSourceMode: sourceMode,
        autoImportAfterParse: false,
        importMaxItems: 200,
        weiboMaxItems: 10,
        onOpenImportSource: (mode) => {
          sourceSelections.push(mode);
          setSourceMode(mode);
        },
        onPreloadImportSource() {},
        onCloseImportSource() {},
        onSubmitImportSource() {}
      });
    }

    const root = createRoot(rootElement);
    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          null,
          React.createElement(
            AuthSessionProvider,
            null,
            React.createElement(Harness)
          )
        )
      ));
      await Promise.resolve();
    });

    const dialog = document.querySelector<HTMLElement>("[data-dialog-frame]");
    assert.ok(dialog);
    assert.equal(dialog.getAttribute("aria-label"), "导入图片");
    assert.match(
      dialog.querySelector(".ingestion-empty-state")?.textContent ?? "",
      /点击此处选择图片来源/u,
      "首次快照到达前应随窗口首帧显示默认入口"
    );
    for (const status of [
      "idle",
      "connecting",
      "loading",
      "disconnected"
    ] as const) {
      await React.act(async () => {
        setHarnessServerStatus?.(status);
        await Promise.resolve();
      });
      assert.ok(
        dialog.querySelector(".ingestion-empty-state"),
        `${status} 首帧必须保留默认入口`
      );
    }
    await React.act(async () => {
      setHarnessServerStatus?.("error");
      await Promise.resolve();
    });
    assert.equal(
      dialog.querySelector(".ingestion-empty-state"),
      null,
      "读取失败应以错误提示替代默认入口"
    );
    assert.equal(dialog.querySelector('input[type="file"]'), null);
    await React.act(async () => {
      setHarnessServerStatus?.("ready");
      await Promise.resolve();
    });
    assert.match(dialog.textContent ?? "", /点击此处选择图片来源/);
    assert.match(
      dialog.querySelector(".ingestion-empty-subtitle")?.textContent ?? "",
      /输入来源后立即创建并准备图片任务/u
    );
    const buttonByText = (label: string) => (
      [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === label
      )
    );
    assert.equal(activeElement, dialog.querySelector(".ingestion-close-button"));
    for (const label of ["链接", "清单", "微博"]) {
      const button = buttonByText(label);
      assert.ok(button);
      await React.act(async () => {
        button.dispatchEvent(new window.Event("click", {
          bubbles: true,
          cancelable: true
        }));
        await Promise.resolve();
      });
    }
    assert.deepEqual(sourceSelections, ["urls", "jsonl", "weibo"]);
    assert.equal(fetchCount, 0);

    await React.act(async () => {
      setHarnessMode?.("upload");
      setHarnessBusy?.(true);
      setHarnessServerStatus?.("loading");
      await Promise.resolve();
    });
    assert.match(
      dialog.querySelector(".ingestion-empty-state")?.textContent ?? "",
      /点击此处选择图片，或将图片拖到这里/u,
      "上传窗口不应在等待首份服务端快照时留下空白主体"
    );
    const localFileInput = dialog.querySelector<HTMLInputElement>(
      'input[type="file"]'
    );
    assert.ok(localFileInput);
    assert.equal(
      localFileInput.disabled,
      false,
      "本地上传忙碌阶段仍须保持选择图片入口稳定可用"
    );
    assert.equal(
      localFileInput.closest(".upload-picker")?.classList.contains(
        "is-disabled"
      ),
      false,
      "本地上传入口不得在提交瞬间切换禁用外观"
    );
    const pendingSnapshotJob = ingestionJob({
      id: "window-pending-snapshot",
      attemptKey: "window-pending-snapshot-attempt",
      sessionId: "S".repeat(43),
      imageId: "019f8457-063a-7037-a580-7a432dc7fd8e",
      serverAccepted: true,
      kind: "upload",
      status: "processing"
    });
    await React.act(async () => {
      setHarnessTotalItems?.(1);
      await Promise.resolve();
    });
    assert.match(
      dialog.querySelector(".ingestion-empty-state")?.textContent ?? "",
      /点击此处选择图片，或将图片拖到这里/u,
      "summary 先到而卡片尚未水合时必须继续保留默认入口"
    );
    assert.match(
      dialog.querySelector(".ingestion-task-summary")?.textContent ?? "",
      /共\s*1\s*张图片/u
    );
    await React.act(async () => {
      setHarnessJobs?.([pendingSnapshotJob]);
      await Promise.resolve();
    });
    assert.equal(
      dialog.querySelector(".ingestion-empty-state"),
      null,
      "服务端未完成任务到达后必须替换首帧默认入口"
    );
    assert.match(
      dialog.querySelector(".ingestion-job")?.textContent ?? "",
      /处理中/u
    );
    await React.act(async () => {
      setHarnessJobs?.([]);
      setHarnessTotalItems?.(null);
      setHarnessBusy?.(false);
      setHarnessMode?.("import");
      setHarnessServerStatus?.("ready");
      await Promise.resolve();
    });

    const applyTransitionJob = ingestionJob({
      id: "window-apply-transition",
      attemptKey: "window-apply-transition-attempt",
      kind: "upload",
      status: "queued"
    });
    await React.act(async () => {
      setHarnessJobs?.([applyTransitionJob]);
      await Promise.resolve();
    });
    const applyDefaults = buttonByText("应用到全部");
    assert.ok(applyDefaults);
    assert.equal(applyDefaults.disabled, false);
    await React.act(async () => {
      setHarnessJobs?.([{ ...applyTransitionJob, status: "processing" }]);
      setHarnessBusy?.(true);
      setHarnessTransientFlags?.({
        actionBusy: true,
        pendingAuthorityHandoff: true
      });
      await Promise.resolve();
    });
    assert.equal(
      applyDefaults.disabled,
      false,
      "交接中的未完成任务仍须保持应用动作可点击"
    );
    await React.act(async () => {
      setHarnessJobs?.([{
        ...applyTransitionJob,
        status: "commit-queued",
        commitIntent: createIngestionCommitIntent(
          applyTransitionJob,
          "019f8457-063a-702f-a580-7a432dc7fd8e"
        )
      }]);
      await Promise.resolve();
    });
    assert.equal(
      applyDefaults.disabled,
      false,
      "冻结提交阶段仍应保持按钮状态稳定，动作只影响可应用任务"
    );
    await React.act(async () => {
      setHarnessBusy?.(false);
      setHarnessTransientFlags?.({
        actionBusy: false,
        pendingAuthorityHandoff: false
      });
      await Promise.resolve();
    });

    const waitingSummaryJob = ingestionJob({
      id: "window-waiting-summary",
      attemptKey: "window-waiting-summary-attempt",
      status: "queued"
    });
    await React.act(async () => {
      setHarnessJobs?.([waitingSummaryJob]);
      await Promise.resolve();
    });
    const waitingSummary = dialog.querySelector(
      ".ingestion-summary-primary"
    )?.textContent ?? "";
    assert.match(waitingSummary, /共\s*1\s*张图片/u);
    assert.match(waitingSummary, /1\s*张等待中/u);
    assert.match(waitingSummary, /0\s*张处理中/u);

    const firstConfirmationJob = ingestionJob({
      id: "window-confirmation-first",
      attemptKey: "window-confirmation-first-attempt",
      status: "ready"
    });
    const laterConfirmationJob = ingestionJob({
      id: "window-confirmation-later",
      attemptKey: "window-confirmation-later-attempt",
      status: "ready"
    });
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob]);
      await Promise.resolve();
    });
    const readyPrimarySummary = dialog.querySelector(
      ".ingestion-summary-primary"
    )?.textContent ?? "";
    const readySecondarySummary = dialog.querySelector(
      ".ingestion-summary-secondary"
    )?.textContent ?? "";
    assert.match(readyPrimarySummary, /共\s*1\s*张图片/u);
    assert.match(readyPrimarySummary, /0\s*张等待中/u);
    assert.match(readyPrimarySummary, /0\s*张处理中/u);
    assert.match(readySecondarySummary, /1\s*张待提交/u);
    assert.match(readySecondarySummary, /0\s*张提交中/u);
    assert.match(readySecondarySummary, /0\s*张已完成/u);

    const clearUncommitted = buttonByText("清空未提交");
    assert.ok(clearUncommitted);
    const phaseDuplicateJob = ingestionJob({
      id: "window-phase-duplicate",
      attemptKey: "window-phase-duplicate-attempt",
      sessionId: "Q".repeat(43),
      imageId: "019f8457-063a-7036-a580-7a432dc7fd8e",
      serverAccepted: true,
      status: "ready",
      md5: windowDuplicateMd5,
      duplicateDecision: "undecided",
      duplicateCount: 1,
      duplicates: [windowDuplicateItem]
    });
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob, phaseDuplicateJob]);
      setHarnessBusy?.(true);
      setHarnessServerStatus?.("loading");
      setHarnessTransientFlags?.({
        actionBusy: true,
        pendingAuthorityHandoff: true
      });
      await Promise.resolve();
    });
    const clearDuplicates = buttonByText("清空重复待确认");
    const submitReady = dialog.querySelector<HTMLButtonElement>(
      ".workflow-submit-button"
    );
    const alwaysClickableCancel = dialog.querySelector<HTMLButtonElement>(
      ".ingestion-queue-clear-button"
    );
    assert.ok(clearDuplicates);
    assert.ok(submitReady);
    assert.ok(alwaysClickableCancel);
    const duplicateCancel = dialog.querySelector<HTMLButtonElement>(
      ".duplicate-panel .danger-button"
    );
    assert.ok(duplicateCancel);
    const sourceButtons = ["链接", "清单", "微博"].map((label) => {
      const button = buttonByText(label);
      assert.ok(button);
      return button;
    });
    assert.equal(clearDuplicates.disabled, false);
    assert.equal(clearUncommitted.disabled, false);
    assert.equal(submitReady.disabled, false);
    assert.equal(alwaysClickableCancel.disabled, false);
    assert.equal(
      duplicateCancel.disabled,
      false,
      "重复待确认卡片的取消按钮在队列操作期间仍须可点击"
    );
    assert.equal(applyDefaults.disabled, false);
    assert.equal(sourceButtons.every((button) => !button.disabled), true);
    assert.match(submitReady.textContent ?? "", /提交\s*1\s*张/u);
    await React.act(async () => {
      clearDuplicates.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      submitReady.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      for (const button of sourceButtons) {
        button.dispatchEvent(new window.Event("click", {
          bubbles: true,
          cancelable: true
        }));
      }
      await Promise.resolve();
    });
    assert.equal(cleanupRunCount, 1);
    assert.equal(commitReadyCount, 1);
    assert.equal(applyDefaultsCount, 0);
    assert.deepEqual(
      sourceSelections,
      ["urls", "jsonl", "weibo", "urls", "jsonl", "weibo"],
      "提交与队列动作 busy 不得让三类导入入口闪成 disabled"
    );
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob]);
      setHarnessBusy?.(false);
      setHarnessServerStatus?.("ready");
      setHarnessTransientFlags?.({
        actionBusy: false,
        pendingAuthorityHandoff: false
      });
      await Promise.resolve();
    });
    await React.act(async () => {
      clearUncommitted.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    let cleanupDialog = document.querySelector<HTMLElement>(".confirm-dialog");
    assert.ok(cleanupDialog);
    assert.match(cleanupDialog.textContent ?? "", /当前 1 张未提交图片/u);
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob, laterConfirmationJob]);
      await Promise.resolve();
    });
    cleanupDialog = document.querySelector<HTMLElement>(".confirm-dialog");
    assert.ok(cleanupDialog, "新增任务不得关闭已打开的清理确认");
    assert.match(
      cleanupDialog.textContent ?? "",
      /当前 1 张未提交图片/u,
      "确认范围与文案必须保持打开时冻结的任务数量"
    );
    await React.act(async () => {
      setHarnessJobs?.([
        { ...firstConfirmationJob, status: "done" },
        { ...laterConfirmationJob, status: "done" }
      ]);
      await Promise.resolve();
    });
    cleanupDialog = document.querySelector<HTMLElement>(".confirm-dialog");
    assert.ok(cleanupDialog);
    const frozenCleanupConfirm = cleanupDialog.querySelector<HTMLButtonElement>(
      'button[type="submit"]'
    );
    assert.ok(frozenCleanupConfirm);
    assert.match(
      frozenCleanupConfirm.querySelector(
        ".async-action-state:not(.is-hidden) .async-action-label"
      )?.textContent ?? "",
      /清空\s*1\s*张/u,
      "确认按钮应保留打开弹窗时冻结的任务数量"
    );
    assert.equal(
      frozenCleanupConfirm.disabled,
      false,
      "普通任务状态变化不得按当前计数禁用已冻结的清理确认"
    );
    const frozenCleanupForm = frozenCleanupConfirm.closest("form");
    assert.ok(frozenCleanupForm);
    await React.act(async () => {
      frozenCleanupForm.dispatchEvent(new window.Event("submit", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
      await clock.advanceBy(499);
      assert.ok(
        document.querySelector(".confirm-dialog"),
        "最短反馈期限前清理确认保持打开"
      );
      await clock.advanceBy(1);
    });
    assert.equal(
      document.querySelector(".confirm-dialog") === null,
      true,
      "成功清理后应关闭确认弹窗"
    );
    assert.equal(cleanupConfirmCount, 1);
    await React.act(async () => {
      setHarnessJobs?.([firstConfirmationJob, laterConfirmationJob]);
      await Promise.resolve();
    });

    const clearQueueButton = dialog.querySelector<HTMLButtonElement>(
      ".ingestion-queue-clear-button"
    );
    assert.ok(clearQueueButton);
    await React.act(async () => {
      clearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(clearQueueButton.textContent?.trim(), "清空");
    assert.equal(clearQueueButton.classList.contains("is-armed"), true);
    await React.act(async () => {
      setHarnessJobs?.([
        firstConfirmationJob,
        laterConfirmationJob,
        ingestionJob({
          id: "window-confirmation-newest",
          attemptKey: "window-confirmation-newest-attempt",
          status: "ready"
        })
      ]);
      await Promise.resolve();
    });
    assert.equal(
      clearQueueButton.textContent?.trim(),
      "清空",
      "新增任务不得重置整队列二次确认"
    );
    await React.act(async () => {
      setHarnessServerStatus?.("loading");
      await Promise.resolve();
      clearQueueButton.dispatchEvent(new window.Event("blur", {
        bubbles: false
      }));
      await Promise.resolve();
    });
    assert.equal(
      clearQueueButton.textContent?.trim(),
      "清空",
      "权威快照交接导致的禁用和失焦不得解除二次确认"
    );
    await React.act(async () => {
      setHarnessServerStatus?.("ready");
      setHarnessJobs?.([
        firstConfirmationJob,
        laterConfirmationJob,
        ingestionJob({
          id: "window-confirmation-newest",
          attemptKey: "window-confirmation-newest-attempt",
          status: "ready"
        })
      ].map((job) => ({ ...job, status: "done" as const })));
      await Promise.resolve();
    });
    assert.equal(
      clearQueueButton.textContent?.trim(),
      "清空",
      "冻结范围内任务转为已完成也不得改写二次确认意图"
    );
    assert.equal(clearQueueButton.classList.contains("danger-button"), true);
    await React.act(async () => {
      clearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(clearQueueButton.textContent?.trim(), "取消");
    assert.equal(clearArmCount, 1, "确认时不得按最新队列重新冻结一次范围");
    assert.equal(clearConfirmCount, 1);

    const incarnationSessionId = "Z".repeat(43);
    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        id: "window-old-incarnation",
        attemptKey: "window-old-incarnation-attempt",
        batchKey: "window-incarnation-batch",
        sessionId: incarnationSessionId,
        imageId: "019f8457-063a-7030-a580-7a432dc7fd8e",
        serverAccepted: true,
        status: "received",
        preview: "blob:window-old-incarnation",
        previewFull: "blob:window-old-incarnation"
      })]);
      await Promise.resolve();
    });
    const oldPreviewOpener = dialog.querySelector<HTMLElement>(
      ".ingestion-job-thumbnail[role='button']"
    );
    assert.ok(oldPreviewOpener);
    await React.act(async () => {
      oldPreviewOpener.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.ok(document.querySelector(".image-preview-modal"));

    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        id: "window-next-incarnation",
        attemptKey: "window-next-incarnation-attempt",
        batchKey: "window-incarnation-batch",
        sessionId: incarnationSessionId,
        imageId: "019f8457-063a-7031-a580-7a432dc7fd8e",
        serverAccepted: true,
        status: "received",
        preview: "https://static.example/new-incarnation.webp",
        previewFull: "https://static.example/new-incarnation-full.webp"
      })]);
      await Promise.resolve();
    });
    const nextPreviewOpener = dialog.querySelector<HTMLElement>(
      ".ingestion-job-thumbnail[role='button']"
    );
    assert.ok(nextPreviewOpener);
    const transferredPreview = document.querySelector<HTMLElement>(
      ".image-preview-modal"
    );
    assert.ok(
      transferredPreview,
      "同 session 新 image 接管后必须把已打开预览切换到新 incarnation"
    );
    const previewClose = transferredPreview.querySelector<HTMLButtonElement>(
      ".image-preview-close"
    );
    assert.ok(previewClose);
    await React.act(async () => {
      previewClose.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(document.querySelector(".image-preview-modal"), null);
    assert.equal(
      activeElement,
      nextPreviewOpener,
      "旧预览关闭后必须把焦点转交给新 incarnation 卡片"
    );

    const focusSessionId = "F".repeat(43);
    const focusImageId = "019f8457-063a-7032-a580-7a432dc7fd8e";
    const focusPlaceholder = ingestionJob({
      id: "local:continuous-focus",
      attemptKey: "continuous-focus-attempt",
      batchKey: "continuous-focus-batch",
      status: "ready",
      preview: "blob:continuous-focus"
    });
    await React.act(async () => {
      setHarnessJobs?.([focusPlaceholder]);
      await Promise.resolve();
    });
    const oldTitleInput = dialog.querySelector<HTMLInputElement>(
      ".ingestion-job input[placeholder='标题']"
    );
    assert.ok(oldTitleInput);
    await React.act(async () => {
      oldTitleInput.focus();
      oldTitleInput.dispatchEvent(new window.Event("focusin", {
        bubbles: true
      }));
      await Promise.resolve();
    });
    const firstBoundFocus = ingestionJob({
      ...focusPlaceholder,
      sessionId: focusSessionId,
      imageId: focusImageId,
      serverAccepted: true,
      preview: "https://static.example/first-bound-focus.webp"
    });
    await React.act(async () => {
      setHarnessJobs?.([firstBoundFocus]);
      await Promise.resolve();
    });
    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        ...firstBoundFocus,
        id: "server:next-incarnation-focus",
        attemptKey: "next-incarnation-focus-attempt",
        imageId: "019f8457-063a-7035-a580-7a432dc7fd8e"
      })]);
      await Promise.resolve();
    });
    const continuousTitleInput = dialog.querySelector<HTMLInputElement>(
      ".ingestion-job input[placeholder='标题']"
    );
    assert.ok(continuousTitleInput);
    assert.equal(
      activeElement,
      continuousTitleInput,
      "placeholder 同 DOM 接管后再换 image 仍必须转交字段焦点"
    );

    const eventFirstCanonical = ingestionJob({
      id: "server:event-first-focus",
      attemptKey: "event-first-focus-attempt",
      batchKey: "event-first-focus-batch",
      sessionId: focusSessionId,
      imageId: focusImageId,
      serverAccepted: true,
      status: "ready",
      preview: "https://static.example/event-first-focus.webp"
    });
    await React.act(async () => {
      setHarnessJobs?.([eventFirstCanonical]);
      await Promise.resolve();
    });
    const eventFirstTitleInput = dialog.querySelector<HTMLInputElement>(
      ".ingestion-job input[placeholder='标题']"
    );
    assert.ok(eventFirstTitleInput);
    await React.act(async () => {
      eventFirstTitleInput.focus();
      eventFirstTitleInput.dispatchEvent(new window.Event("focusin", {
        bubbles: true
      }));
      await Promise.resolve();
    });
    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        ...eventFirstCanonical,
        id: "local:http-late-focus",
        attemptKey: "http-late-focus-attempt"
      })]);
      await Promise.resolve();
    });
    const transferredTitleInput = dialog.querySelector<HTMLInputElement>(
      ".ingestion-job input[placeholder='标题']"
    );
    assert.ok(transferredTitleInput);
    assert.equal(
      activeElement,
      transferredTitleInput,
      "event-first canonical 合并到 HTTP placeholder 后必须转交字段焦点"
    );

    const detailSessionId = "D".repeat(43);
    const detailImageId = "019f8457-063a-7033-a580-7a432dc7fd8e";
    const detailCanonical = ingestionJob({
      id: "server:event-first-detail",
      attemptKey: "event-first-detail-attempt",
      batchKey: "event-first-detail-batch",
      sessionId: detailSessionId,
      imageId: detailImageId,
      serverAccepted: true,
      serverVersion: 1,
      status: "ready",
      md5: windowDuplicateMd5,
      duplicateDecision: "undecided",
      duplicateCount: 1,
      duplicates: [windowDuplicateItem]
    });
    await React.act(async () => {
      setHarnessJobs?.([detailCanonical]);
      await Promise.resolve();
    });
    const duplicateStatusLabel = dialog.querySelector<HTMLElement>(
      ".ingestion-status-label"
    );
    assert.equal(duplicateStatusLabel?.textContent, "【待确认】");
    assert.equal(
      duplicateStatusLabel?.classList.contains("is-duplicate-pending"),
      true,
      "重复待确认标签必须复用重复提示标题的语义警告色"
    );
    const oldDetailOpener = dialog.querySelector<HTMLButtonElement>(
      ".duplicate-item"
    );
    assert.ok(oldDetailOpener);
    await React.act(async () => {
      oldDetailOpener.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.ok(document.querySelector(".image-detail-modal"));
    await React.act(async () => {
      setHarnessJobs?.([ingestionJob({
        ...detailCanonical,
        id: "local:http-late-detail",
        attemptKey: "http-late-detail-attempt"
      })]);
      await Promise.resolve();
    });
    const detailClose = document.querySelector<HTMLButtonElement>(
      ".image-detail-modal button[aria-label='关闭图片详情']"
    );
    assert.ok(detailClose);
    await React.act(async () => {
      detailClose.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    const transferredDetailOpener = dialog.querySelector<HTMLButtonElement>(
      ".duplicate-item"
    );
    assert.ok(transferredDetailOpener);
    assert.equal(document.querySelector(".image-detail-modal"), null);
    assert.equal(
      activeElement,
      transferredDetailOpener,
      "event-first canonical 合并后详情关闭必须归焦到 placeholder 卡片"
    );

    await React.act(async () => {
      setHarnessBusy?.(true);
      await Promise.resolve();
    });

    const waitForPageScrollRestore = () => new Promise<void>((resolve) => {
      window.addEventListener("imageshow:page-scroll-restored", () => resolve(), {
        once: true
      });
    });
    const escapeScrollRestored = waitForPageScrollRestore();
    const escapeEvent = new window.Event("keydown", {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperty(escapeEvent, "key", { value: "Escape" });
    await React.act(async () => {
      document.dispatchEvent(escapeEvent);
      await Promise.resolve();
    });
    assert.equal(prepareCloseCount, 1);
    assert.equal(finishPreparedCloseCount, 1);
    assert.equal(fallbackCloseCount, 0);
    assert.equal(closeCount, 1);
    assert.equal(closeOptions[0], undefined);
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(activeElement, returnTarget);
    await escapeScrollRestored;

    await React.act(async () => {
      setHarnessOpen?.(true);
      await Promise.resolve();
    });
    const reopenedDialog = document.querySelector<HTMLElement>(
      "[data-dialog-frame]"
    );
    const closeButton = reopenedDialog?.querySelector<HTMLButtonElement>(
      ".ingestion-close-button"
    );
    assert.ok(closeButton);
    assert.equal(closeButton.disabled, false, "忙碌阶段仍必须允许隐藏窗口");
    const buttonScrollRestored = waitForPageScrollRestore();
    await React.act(async () => {
      closeButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(prepareCloseCount, 2);
    assert.equal(finishPreparedCloseCount, 2);
    assert.equal(fallbackCloseCount, 0);
    assert.equal(closeCount, 2);
    assert.equal(closeOptions[1], undefined);
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    await buttonScrollRestored;

    await React.act(async () => {
      setHarnessOpen?.(true);
      await Promise.resolve();
    });
    const staleDialog = document.querySelector<HTMLElement>(
      "[data-dialog-frame]"
    );
    const staleClearQueueButton = staleDialog?.querySelector<HTMLButtonElement>(
      ".ingestion-queue-clear-button"
    );
    const staleCloseButton = staleDialog?.querySelector<HTMLButtonElement>(
      ".ingestion-close-button"
    );
    assert.ok(staleClearQueueButton);
    assert.ok(staleCloseButton);
    delayClearConfirmation = true;
    await React.act(async () => {
      staleClearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    await React.act(async () => {
      staleClearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.ok(resolveClearConfirmation);

    const staleScrollRestored = waitForPageScrollRestore();
    await React.act(async () => {
      staleCloseButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(prepareCloseCount, 3);
    assert.equal(finishPreparedCloseCount, 3);
    assert.equal(fallbackCloseCount, 0);
    assert.equal(closeCount, 3);
    assert.equal(closeOptions[2], undefined);
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    await staleScrollRestored;

    await React.act(async () => {
      setHarnessOpen?.(true);
      await Promise.resolve();
    });
    const reopenedAfterStaleConfirmation = document.querySelector<HTMLElement>(
      "[data-dialog-frame]"
    );
    assert.ok(reopenedAfterStaleConfirmation);
    delayClearConfirmation = false;
    await React.act(async () => {
      resolveClearConfirmation?.(true);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    resolveClearConfirmation = undefined;
    assert.equal(
      document.querySelector("[data-dialog-frame]"),
      reopenedAfterStaleConfirmation,
      "已卸载窗口的迟到清空结果不得关闭后来重开的窗口"
    );
    assert.equal(prepareCloseCount, 3);
    assert.equal(finishPreparedCloseCount, 3);
    assert.equal(fallbackCloseCount, 0);
    assert.equal(closeCount, 3);

    const finalDialog = reopenedAfterStaleConfirmation;
    const finalClearQueueButton = finalDialog.querySelector<HTMLButtonElement>(
      ".ingestion-queue-clear-button"
    );
    assert.ok(finalClearQueueButton);
    clearShouldSucceed = true;
    const clearScrollRestored = waitForPageScrollRestore();
    await React.act(async () => {
      finalClearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(finalClearQueueButton.textContent?.trim(), "清空");
    await React.act(async () => {
      finalClearQueueButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
      await clock.advanceBy(499);
      assert.equal(
        document.querySelector("[data-dialog-frame]"),
        finalDialog,
        "最短反馈期限前整队列窗口保持打开"
      );
      await clock.advanceBy(1);
      await Promise.resolve();
    });
    assert.equal(
      prepareCloseCount,
      3,
      "显式 afterClose 必须跳过默认 completed 清理准备"
    );
    assert.equal(finishPreparedCloseCount, 3);
    assert.equal(fallbackCloseCount, 1);
    assert.equal(closeCount, 4);
    assert.equal(
      closeOptions[3]?.skipCompletedCleanup,
      true,
      "整队列清空成功后的关闭不得再追加 completed 清理"
    );
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(activeElement, returnTarget);
    await clearScrollRestored;

    await React.act(async () => root.unmount());
    client.clear();
  } finally {
    deregisterCssHooks();
    window.HTMLElement.prototype.focus = originalFocus;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 内容接入入口只在模态边界接管前锁定页面且五类激活与失败都正确交接", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><button id=opener>打开导入</button><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  let reduceMotion = true;
  Object.assign(window, {
    requestAnimationFrame,
    cancelAnimationFrame,
    matchMedia: (query: string) => ({
      matches: reduceMotion && query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true
    }),
    scrollTo() {},
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 720
  });

  let activeElement: HTMLElement | null = null;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => activeElement
  });
  const originalFocus = window.HTMLElement.prototype.focus;
  const originalBlur = window.HTMLElement.prototype.blur;
  window.HTMLElement.prototype.focus = function focus() {
    activeElement = this;
  };
  window.HTMLElement.prototype.blur = function blur() {
    if (activeElement === this) activeElement = null;
  };

  let fetchCount = 0;
  let storageResponse: Promise<Response> | undefined;
  const fetchStub = async () => {
    fetchCount += 1;
    if (storageResponse) return storageResponse;
    throw new Error("内容接入激活生命周期测试不应发起请求");
  };
  class SilentEventSource {
    static instances = new Set<SilentEventSource>();
    readonly url: string;

    constructor(url: string) {
      this.url = url;
      SilentEventSource.instances.add(this);
    }

    addEventListener() {}

    close() {
      SilentEventSource.instances.delete(this);
    }
  }
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    fetch: fetchStub,
    EventSource: SilentEventSource,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    const [{ Ingestion }, { IngestionLauncher }] = await Promise.all([
      import("../../../packages/web/src/pages/admin/ingestion/Ingestion.tsx"),
      import("../../../packages/web/src/pages/admin/ingestion/IngestionLauncher.tsx")
    ]).finally(() => cssHooks.deregister());
    const container = document.getElementById("root");
    const opener = document.getElementById("opener") as HTMLButtonElement;
    assert.ok(container);
    assert.ok(opener);

    const client = new QueryClient({
      defaultOptions: {
        queries: {
          gcTime: Number.POSITIVE_INFINITY,
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnWindowFocus: false
        }
      }
    });
    client.setQueryData(queryKeys.settings, {
      settings: {
        ingestion: {
          list_page_size: 20,
          max_file_size_mb: 100,
          max_long_edge: 32000
        },
        upload: {
          max_items: 200,
          browser_concurrency: 2
        },
        import: {
          keep_original_link: [],
          auto_import: false,
          max_items: 200
        },
        weibo: { max_items: 10 }
      }
    });
    client.setQueryData(queryKeys.ingestionVocabulary, {
      themes: [],
      tags: [],
      authors: []
    });
    client.setQueryData(queryKeys.storageOptions, {
      backends: [{
        slug: "local",
        display_name: "本地存储",
        enabled: true,
        is_default: true
      }]
    });

    function ImportSourceProbe({
      initialMode,
      onClose,
      onSubmit
    }: {
      initialMode: string;
      onClose: () => void;
      onSubmit: (submission: unknown) => void;
    }) {
      return React.createElement(
        "div",
        { "data-import-source-mode": initialMode },
        initialMode === "jsonl" ? React.createElement("button", {
          type: "button",
          "data-submit-jsonl-error": true,
          onClick() {
            onSubmit({
              mode: "jsonl",
              manifest: {
                items: [],
                errors: [{
                  line: 7,
                  raw: "invalid jsonl row",
                  error: "受控清单错误"
                }]
              }
            });
            onClose();
          }
        }, "提交错误清单") : null
      );
    }

    const opened: number[] = [];
    const settled: number[] = [];
    const loadErrors: unknown[] = [];
    let rejectSourceLoad = false;
    const loadImportSourceModule = async () => {
      if (rejectSourceLoad) throw new Error("controlled source load failure");
      return { ImportSourceDialog: ImportSourceProbe } as never;
    };
    const root = createRoot(container);
    const renderActivation = async (
      sequence: number,
      kind: "workflow" | "files" | "urls" | "jsonl" | "weibo"
    ) => {
      await React.act(async () => {
        root.render(React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(Ingestion, {
            settings: client.getQueryData<{ settings: Parameters<typeof Ingestion>[0]["settings"] }>(queryKeys.settings)!.settings,
            activation: { sequence, kind, opener },
            activationEnabled: true,
            loadImportSourceModule,
            onActivationOpened: (openedSequence) => {
              opened.push(openedSequence);
            },
            onActivationSettled: (settledSequence) => {
              settled.push(settledSequence);
            },
            onDone() {},
            onLoadError: (error) => loadErrors.push(error)
          })
        ));
        await Promise.resolve();
      });
    };
    const waitFor = async (condition: () => boolean, message: string) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (condition()) return;
      }
      assert.fail(message);
    };

    const activationKinds = [
      "workflow",
      "files",
      "urls",
      "jsonl",
      "weibo"
    ] as const;
    for (const [index, kind] of activationKinds.entries()) {
      const sequence = index + 1;
      await renderActivation(sequence, kind);
      await waitFor(
        () => document.querySelector("[data-dialog-frame]") !== null,
        `${kind} 激活后未打开工作流`
      );
      assert.equal(
        SilentEventSource.instances.size,
        1,
        `${kind} 显示时只能订阅当前队列`
      );
      assert.equal(
        opened.filter((item) => item === sequence).length,
        1,
        `${kind} 工作流挂载后必须恰好交接一次模态权威`
      );
      assert.equal(
        settled.includes(sequence),
        false,
        `${kind} 打开后仍应保留活动意图直到工作流关闭`
      );
      if (kind === "urls" || kind === "jsonl" || kind === "weibo") {
        assert.equal(
          document.querySelector("[data-import-source-mode]")
            ?.getAttribute("data-import-source-mode"),
          kind
        );
      }
      if (kind === "jsonl") {
        const submitJsonlError = document.querySelector<HTMLButtonElement>(
          "[data-submit-jsonl-error]"
        );
        assert.ok(submitJsonlError);
        await React.act(async () => {
          submitJsonlError.dispatchEvent(new window.Event("click", {
            bubbles: true,
            cancelable: true
          }));
          await Promise.resolve();
        });
        await waitFor(
          () => (document.querySelector("[data-dialog-frame]")?.textContent ?? "")
            .includes("1 行未创建任务"),
          "JSONL 行级错误未进入 import owner"
        );
      }
      if (kind === "weibo") {
        assert.match(
          document.querySelector("[data-dialog-frame]")?.textContent ?? "",
          /1 行未创建任务/u,
          "关闭并重开 import owner 后必须保留 JSONL 行级错误"
        );
      }

      const closeButton = document.querySelector<HTMLButtonElement>(
        ".ingestion-close-button"
      );
      assert.ok(closeButton);
      await React.act(async () => {
        closeButton.dispatchEvent(new window.Event("click", {
          bubbles: true,
          cancelable: true
        }));
        await Promise.resolve();
      });
      await waitFor(
        () => settled.includes(sequence),
        `${kind} 关闭后未释放页面锁`
      );
      assert.equal(document.querySelector("[data-dialog-frame]"), null);
      assert.equal(
        SilentEventSource.instances.size,
        0,
        `${kind} 隐藏后必须关闭当前队列订阅`
      );
      assert.equal(
        settled.filter((item) => item === sequence).length,
        1,
        `${kind} 页面锁只能释放一次`
      );
    }

    rejectSourceLoad = true;
    await renderActivation(activationKinds.length + 1, "weibo");
    await waitFor(
      () => settled.includes(activationKinds.length + 1),
      "来源模块加载失败后未退休活动意图"
    );
    assert.equal(
      opened.includes(activationKinds.length + 1),
      false,
      "来源模块加载失败时不得虚构已经取得的模态权威"
    );
    assert.equal(loadErrors.length, 1);
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(fetchCount, 0);

    reduceMotion = false;
    let backgroundEditClicks = 0;
    let rejectLauncherWorkflowLoad = false;
    const launcherModuleLoaders = {
      ingestion: async () => {
        await Promise.resolve();
        if (rejectLauncherWorkflowLoad) {
          throw new Error("controlled launcher workflow load failure");
        }
        return { Ingestion } as never;
      },
      importSource: loadImportSourceModule
    };
    function LauncherHarness() {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement("button", {
          id: "background-single-image-edit",
          type: "button",
          onClick: () => {
            backgroundEditClicks += 1;
          }
        }, "编辑图片"),
        React.createElement(IngestionLauncher, {
          settings: client.getQueryData<{ settings: Parameters<typeof IngestionLauncher>[0]["settings"] }>(queryKeys.settings)!.settings,
          showTriggers: true,
          disabled: false,
          onDone() {},
          onLoadError: (error) => loadErrors.push(error),
          moduleLoaders: launcherModuleLoaders
        })
      );
    }
    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(LauncherHarness)
      ));
      await Promise.resolve();
    });
    const uploadTrigger = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("上传图片"));
    assert.ok(uploadTrigger);
    client.removeQueries({ queryKey: queryKeys.storageOptions });
    let resolveStorage!: (response: Response) => void;
    storageResponse = new Promise((resolve) => { resolveStorage = resolve; });
    React.act(() => {
      uploadTrigger.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
    });
    assert.equal(
      document.querySelector("[data-dialog-frame]"),
      null,
      "同步点击阶段仍应覆盖按需模块尚未挂载弹窗的窗口"
    );
    assert.equal(
      container.inert,
      true,
      "按需模块尚未挂载弹窗时必须先取得页面根交互锁"
    );
    assert.equal(
      (document.getElementById(
        "background-single-image-edit"
      ) as HTMLButtonElement).disabled,
      false,
      "启动互斥不得再提交背景按钮的禁用外观"
    );
    assert.equal(
      uploadTrigger.disabled,
      false,
      "被点击的内容接入入口也不得闪现禁用态"
    );
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(fetchCount, 1, "首次打开只请求一次共享存储选项");
    assert.equal(document.querySelector("[data-dialog-frame]"), null,
      "存储尚未返回时不能提前打开工作流并采用临时 local");
    await React.act(async () => resolveStorage(Response.json({ backends: [{
      slug: "cos", display_name: "COS", enabled: true, is_default: true
    }] })));
    await waitFor(
      () => document.querySelector("[data-dialog-frame]") !== null,
      "工作流挂载后未把启动锁交给模态边界"
    );
    assert.equal(fetchCount, 1, "工作流挂载复用同一查询，不重复加载存储");
    assert.match(document.querySelector('[aria-label="新任务存储位置"]')?.textContent ?? "", /COS/);
    const backgroundEdit = document.getElementById(
      "background-single-image-edit"
    ) as HTMLButtonElement;
    assert.equal(
      backgroundEdit.disabled,
      false,
      "弹窗显示期间背景按钮不应继续呈现为业务禁用"
    );
    assert.equal(
      container.inert,
      true,
      "按钮恢复正常外观后，页面仍必须由模态边界统一设为 inert"
    );
    assert.equal(
      uploadTrigger.disabled,
      false,
      "入口按钮也不得在半透明遮罩后持续显示禁用态"
    );

    const launcherCloseButton = document.querySelector<HTMLButtonElement>(
      ".ingestion-close-button"
    );
    assert.ok(launcherCloseButton);
    await React.act(async () => {
      launcherCloseButton.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    const closingFrame = document.querySelector<HTMLElement>(
      "[data-dialog-frame]"
    );
    assert.ok(closingFrame);
    assert.equal(closingFrame.classList.contains("is-closing"), true);
    assert.equal(backgroundEdit.disabled, false);
    assert.equal(
      container.inert,
      true,
      "淡出期间仍由现存 DialogFrame 阻止底层操作"
    );
    await React.act(async () => {
      closingFrame.dispatchEvent(new window.Event("animationend", {
        bubbles: true
      }));
      await Promise.resolve();
    });
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.notEqual(container.inert, true);
    await React.act(async () => {
      backgroundEdit.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await Promise.resolve();
    });
    assert.equal(
      backgroundEditClicks,
      1,
      "弹窗卸载后的首次单图编辑操作必须立即生效"
    );
    await waitFor(
      () => !document.documentElement.classList.contains(
        "page-scroll-restoring"
      ),
      "弹窗关闭后的页面滚动位置未完成恢复"
    );

    const loadErrorCountBeforeLauncherFailure = loadErrors.length;
    rejectLauncherWorkflowLoad = true;
    uploadTrigger.focus();
    React.act(() => {
      uploadTrigger.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
    });
    assert.equal(container.inert, true);
    assert.equal(
      activeElement,
      null,
      "启动根锁应先把焦点移出即将 inert 的页面"
    );
    await waitFor(
      () => loadErrors.length === loadErrorCountBeforeLauncherFailure + 1
        && !container.inert,
      "Launcher 加载失败后未解除页面根锁"
    );
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(
      activeElement,
      uploadTrigger,
      "未挂载弹窗的加载失败必须在根锁清理后归焦启动入口"
    );
    await waitFor(
      () => !document.documentElement.classList.contains(
        "page-scroll-restoring"
      ),
      "Launcher 加载失败后的页面滚动位置未完成恢复"
    );

    rejectLauncherWorkflowLoad = false;
    client.removeQueries({ queryKey: queryKeys.storageOptions });
    storageResponse = Promise.resolve(Response.json({ error: "存储查询失败" }, { status: 503 }));
    const errorsBeforeStorageFailure = loadErrors.length;
    await React.act(async () => uploadTrigger.click());
    await waitFor(() => loadErrors.length === errorsBeforeStorageFailure + 1 && !container.inert,
      "存储查询失败必须释放入口锁并允许重试");
    assert.equal(document.querySelector("[data-dialog-frame]"), null);
    assert.equal(activeElement, uploadTrigger);
    storageResponse = Promise.resolve(Response.json({ backends: [{
      slug: "cos", display_name: "COS", enabled: true, is_default: true
    }] }));
    await React.act(async () => uploadTrigger.click());
    await waitFor(() => document.querySelector("[data-dialog-frame]") !== null,
      "存储查询失败后重试应打开工作流");

    await React.act(async () => root.unmount());
    await waitFor(() => !document.documentElement.classList.contains("page-scroll-restoring"),
      "最终卸载应先完成页面滚动恢复，再释放测试 DOM");
    client.clear();
  } finally {
    window.HTMLElement.prototype.focus = originalFocus;
    window.HTMLElement.prototype.blur = originalBlur;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 导入组合按钮共同预载且来源选择在菜单退场前取得页面启动锁", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: query.includes("min-width"),
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true
    }),
    requestAnimationFrame: (callback: FrameRequestCallback) => (
      setTimeout(() => callback(Date.now()), 0) as unknown as number
    ),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    innerWidth: 1280,
    innerHeight: 720
  });
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previousGlobals = new Map(
    Object.keys(installedGlobals).map((key) => (
      [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    ))
  );
  for (const [key, value] of Object.entries(installedGlobals)) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value
    });
  }

  try {
    const { createRoot } = await import("react-dom/client");
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    const { IngestionTriggers } = await import(
      "../../../packages/web/src/pages/admin/ingestion/IngestionTriggers.tsx"
    ).finally(() => cssHooks.deregister());
    const container = document.getElementById("root");
    assert.ok(container);
    let workflowPreloads = 0;
    let sourcePreloads = 0;
    let sourceActivations = 0;
    function Harness() {
      return React.createElement(IngestionTriggers, {
        pending: false,
        onPreloadWorkflow: () => {
          workflowPreloads += 1;
        },
        onPreloadImportSource: () => {
          sourcePreloads += 1;
        },
        onOpenWorkflow() {},
        onOpenUrls() {
          sourceActivations += 1;
        },
        onOpenJsonl() {},
        onOpenWeibo() {},
        onOpenFiles() {}
      });
    }
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    const mainButton = container.querySelector<HTMLButtonElement>(
      ".import-source-main"
    );
    const menuButton = container.querySelector<HTMLButtonElement>(
      ".import-source-menu-trigger"
    );
    const uploadButton = [...container.querySelectorAll<HTMLButtonElement>(
      ".ingestion-trigger"
    )].find((button) => button.textContent?.includes("上传图片"));
    assert.ok(mainButton);
    assert.ok(menuButton);
    assert.ok(uploadButton);
    const dispatch = async (
      target: HTMLElement,
      type: string,
      pointerType?: string
    ) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      if (pointerType) {
        Object.defineProperty(event, "pointerType", { value: pointerType });
      }
      await React.act(async () => {
        target.dispatchEvent(event);
        await Promise.resolve();
      });
    };

    await dispatch(mainButton, "pointerover", "mouse");
    assert.deepEqual(
      { workflowPreloads, sourcePreloads },
      { workflowPreloads: 1, sourcePreloads: 1 }
    );
    await dispatch(menuButton, "focusin");
    assert.deepEqual(
      { workflowPreloads, sourcePreloads },
      { workflowPreloads: 2, sourcePreloads: 2 }
    );
    await dispatch(mainButton, "pointerdown", "touch");
    assert.deepEqual(
      { workflowPreloads, sourcePreloads },
      { workflowPreloads: 3, sourcePreloads: 3 }
    );
    await dispatch(uploadButton, "focusin");
    assert.deepEqual(
      { workflowPreloads, sourcePreloads },
      { workflowPreloads: 4, sourcePreloads: 3 }
    );

    await dispatch(menuButton, "click");
    const urlItem = [...document.querySelectorAll<HTMLButtonElement>(
      '[role="menuitem"]'
    )].find((button) => button.textContent?.includes("链接导入"));
    assert.ok(urlItem);
    await dispatch(urlItem, "click");
    assert.equal(
      sourceActivations,
      1,
      "来源激活不得延迟到菜单退出动画完成后"
    );
    const closingMenu = document.querySelector<HTMLElement>(
      ".import-source-menu.is-closing"
    );
    assert.ok(closingMenu);
    await dispatch(closingMenu, "animationend");
    assert.equal(sourceActivations, 1, "菜单退场不得重复触发来源激活");

    await React.act(async () => root.unmount());
  } finally {
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/内容接入] 浏览器上传 lane 统一约束页面工作并响应动态容量与取消", async (t) => {
  const gate = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    });
    return { promise, resolve };
  };
  const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const waitFor = async (predicate: () => boolean, message: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      await nextTurn();
    }
    assert.fail(message);
  };

  await t.test("后续选择不能在既有凭据与 raw 交接之间插入预览", async (subtest) => {
    const lane = new BrowserUploadLane(1);
    const sequence = new BrowserUploadBatchSequencer();
    const rawRelease = gate();
    const starts: string[] = [];
    const signal = new AbortController().signal;
    subtest.after(() => rawRelease.resolve());
    const runLane = (
      name: string,
      work: () => Promise<void> = async () => {}
    ) => lane.run(
      signal,
      async () => {
        starts.push(name);
        await work();
      }
    );

    const first = sequence.run(async () => {
      await runLane("first-preview");
      await runLane("first-credential");
      await runLane("first-raw", () => rawRelease.promise);
    });
    const second = sequence.run(async () => {
      await Promise.all([
        runLane("second-preview-1"),
        runLane("second-preview-2")
      ]);
    });

    await waitFor(
      () => starts.includes("first-raw"),
      "first credential did not hand off to raw"
    );
    assert.deepEqual(starts, [
      "first-preview",
      "first-credential",
      "first-raw"
    ]);
    rawRelease.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(starts, [
      "first-preview",
      "first-credential",
      "first-raw",
      "second-preview-1",
      "second-preview-2"
    ]);
  });

  await t.test("预览、凭据和 raw 共用容量且提额按 FIFO 补位", async (subtest) => {
    const lane = new BrowserUploadLane(2);
    const releases = [gate(), gate(), gate(), gate()];
    const starts: string[] = [];
    let active = 0;
    let maximumActive = 0;
    subtest.after(() => releases.forEach((release) => release.resolve()));
    const run = (name: string, release: ReturnType<typeof gate>) => lane.run(
      new AbortController().signal,
      async () => {
        starts.push(name);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          await release.promise;
        } finally {
          active -= 1;
        }
      }
    );
    const runs = [
      run("preview", releases[0]),
      run("raw", releases[1]),
      run("credential", releases[2]),
      run("next", releases[3])
    ];
    await waitFor(() => starts.length === 2, "initial page capacity was not filled");
    assert.deepEqual(starts, ["preview", "raw"]);
    lane.setLimit(3);
    await waitFor(() => starts.length === 3, "raised page capacity did not drain");
    assert.deepEqual(starts, ["preview", "raw", "credential"]);
    assert.equal(maximumActive, 3);
    releases[0].resolve();
    await waitFor(() => starts.length === 4, "FIFO page waiter did not resume");
    releases.slice(1).forEach((release) => release.resolve());
    await Promise.all(runs);
  });

  await t.test("降额让活动工作完成后再发新许可", async (subtest) => {
    const lane = new BrowserUploadLane(2);
    const releases = [gate(), gate(), gate()];
    const starts: number[] = [];
    subtest.after(() => releases.forEach((release) => release.resolve()));
    const runs = releases.map((release, index) => lane.run(
      new AbortController().signal,
      async () => {
        starts.push(index);
        await release.promise;
      }
    ));
    await waitFor(() => starts.length === 2, "initial page work did not start");
    lane.setLimit(1);
    releases[0].resolve();
    await runs[0];
    await nextTurn();
    assert.deepEqual(starts, [0, 1]);
    releases[1].resolve();
    await waitFor(() => starts.length === 3, "lowered page lane never resumed");
    releases[2].resolve();
    await Promise.all(runs);
  });

  await t.test("等待与许可交接取消均不启动工作并释放容量", async (subtest) => {
    const lane = new BrowserUploadLane(1);
    const firstRelease = gate();
    const waitingController = new AbortController();
    const handoffError = new Error("page cancellation at permit handoff");
    let handoffAbortReads = 0;
    const handoffSignal = {
      get aborted() {
        handoffAbortReads += 1;
        return handoffAbortReads >= 4;
      },
      reason: handoffError,
      addEventListener() {},
      removeEventListener() {}
    } as unknown as AbortSignal;
    const starts: string[] = [];
    subtest.after(() => firstRelease.resolve());
    const first = lane.run(new AbortController().signal, async () => {
      starts.push("first");
      await firstRelease.promise;
    });
    const waiting = lane.run(waitingController.signal, async () => {
      starts.push("cancelled-waiter");
    });
    const handoff = lane.run(handoffSignal, async () => {
      starts.push("cancelled-handoff");
    });
    await waitFor(() => starts.length === 1, "first page work did not start");
    const waitingError = new Error("waiting upload cancelled");
    waitingController.abort(waitingError);
    await assert.rejects(waiting, (error) => error === waitingError);
    firstRelease.resolve();
    await first;
    await assert.rejects(handoff, (error) => error === handoffError);
    assert.deepEqual(starts, ["first"]);
    const workError = new Error("page work failed");
    await assert.rejects(
      lane.run(new AbortController().signal, async () => {
        throw workError;
      }),
      (error) => error === workError
    );
    await lane.run(new AbortController().signal, async () => undefined);
  });

  await t.test("后续凭据批次读取归一化后的当前容量", () => {
    const lane = new BrowserUploadLane(4.9);
    assert.equal(lane.limit, 4);
    lane.setLimit(2);
    assert.equal(lane.limit, 2);
    lane.setLimit(Number.NaN);
    assert.equal(lane.limit, 1);
  });
});
test("[Web/内容接入] 导入菜单键盘与来源标签保持真实 DOM 焦点和读屏关联", async (t) => {
  const h = await createConfigStreamHarness(t);
  const dom = h.document.defaultView!;
  let active: HTMLElement | null = h.document.body;
  Object.defineProperty(h.document, "activeElement", { configurable: true, get: () => active });
  const priorFocus = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "focus");
  const priorAttach = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "attachEvent");
  const priorDetach = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "detachEvent");
  (dom.HTMLElement.prototype as any).attachEvent = () => {};
  (dom.HTMLElement.prototype as any).detachEvent = () => {};
  const priorBlur = Object.getOwnPropertyDescriptor(dom.HTMLElement.prototype, "blur");
  dom.HTMLElement.prototype.focus = function () { active = this; this.dispatchEvent(new dom.Event("focusin", { bubbles: true })); };
  dom.HTMLElement.prototype.blur = function () { if (active === this) active = h.document.body; };
  const extra = {
    Event: dom.Event, MutationObserver: dom.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout,
    scrollTo() {}, scrollY: 0, innerWidth: 1440, innerHeight: 900,
    getComputedStyle: () => ({ getPropertyValue: () => "", display: "block", visibility: "visible", position: "static", overflowY: "visible" }),
    matchMedia: (media: string) => ({ media, matches: media.includes("prefers-reduced-motion") || media.includes("min-width"), addEventListener() {}, removeEventListener() {} })
  };
  const previous = new Map(Object.keys(extra).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key,value] of Object.entries(extra)) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  const key = async (node: Element, value: string) => h.React.act(async () => {
    const event = dispatchDomEvent(h.window, node, "keydown", { key: value });
    await Promise.resolve();
    return event;
  });
  try {
    const { ImportSplitButton } = await import("../../../packages/web/src/pages/admin/ingestion/import/ImportSplitButton.tsx");
    let selected = ""; let opener: Element | undefined;
    const choose = (name: string) => (element: HTMLButtonElement) => { selected = name; opener = element; };
    const base = { pending:false, onPreloadWorkflow() {}, onPreloadImportSource() {}, onOpenWorkflow() {}, onOpenUrls:choose("urls"), onOpenJsonl:choose("jsonl"), onOpenWeibo:choose("weibo") };
    const renderMenu = async (pending=false) => h.render(h.React.createElement("div", null, h.React.createElement(ImportSplitButton, {...base,pending}), h.React.createElement("input", {id:"outside-menu"})));
    await renderMenu();
    const trigger = () => h.document.querySelector<HTMLButtonElement>('[title="更多导入方式"]')!;
    const items = () => [...h.document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    for (const [index,mode] of [[0,"urls"],[1,"jsonl"],[2,"weibo"]] as const) {
      await h.React.act(async () => trigger().focus()); await key(trigger(),"ArrowDown"); await h.flush();
      assert.equal(h.document.activeElement, items()[0]);
      await key(items()[0],"End"); assert.equal(h.document.activeElement, items()[2]);
      await key(items()[2],"ArrowDown"); assert.equal(h.document.activeElement, items()[0]);
      await key(items()[0],"ArrowUp"); assert.equal(h.document.activeElement, items()[2]);
      await h.React.act(async () => items()[index].click());
      assert.equal(selected,mode); assert.equal(opener,trigger());
    }
    const outside = h.document.getElementById("outside-menu")!;
    await h.React.act(async () => outside.focus());
    await h.React.act(async () => {
      dispatchDomEvent(h.window, trigger(), "pointerover", {
        pointerType: "mouse"
      });
      await Promise.resolve();
    });
    await h.flush();
    assert.equal(h.document.activeElement,outside);
    await h.React.act(async () => { const event = new dom.Event("keydown",{bubbles:true}); (event as any).key="Escape"; h.document.dispatchEvent(event); });
    assert.equal(h.document.activeElement,outside);
    await key(trigger(),"ArrowUp"); await h.flush();
    await h.React.act(async () => outside.focus()); assert.equal(items().length,0);
    await renderMenu(true); await key(trigger(),"ArrowDown"); assert.equal(items().length,0);
    await h.render(null);
    const { ImportSourceDialog } = await import("../../../packages/web/src/pages/admin/ingestion/import/ImportSourceDialog.tsx");
    await h.render(h.React.createElement(ImportSourceDialog,{initialMode:"urls",autoImportAfterParse:false,maxItems:200,weiboMaxItems:10,onClose(){},onSubmit(){}}));
    const tabs = () => [...h.document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    for(const [value,index] of [["ArrowLeft",2],["ArrowRight",0],["End",2],["Home",0],["ArrowRight",1]] as const){
      const selectedTab=tabs().find(tab=>tab.getAttribute("aria-selected")==="true")!;
      await key(selectedTab,value);
      assert.equal(h.document.activeElement,tabs()[index]);
      assert.equal(tabs().filter(tab=>tab.getAttribute("tabindex")==="0").length,1);
      const panel=h.document.querySelector('[role="tabpanel"]')!;
      assert.equal(panel.getAttribute("aria-labelledby"),tabs()[index].id);
      assert.equal(tabs()[index].getAttribute("aria-controls"),panel.id);
    }
    await h.React.act(async () => tabs()[0].click());
    assert.equal(h.document.activeElement,h.document.querySelector("textarea"));

    // 解析请求尚未完成时父层重渲染，自动导入必须采用最新提交回调。
    for (const mode of ["weibo", "jsonl"] as const) {
      await h.render(null);
      const jobs: IngestionJob[] = [];
      let closed = 0;
      const renderSource = (storageSlug: string, theme: string) => h.render(
        h.React.createElement(ImportSourceDialog, {
          initialMode: mode, autoImportAfterParse: true, maxItems: 200, weiboMaxItems: 10,
          onClose() { closed += 1; },
          onSubmit(submission) {
            assert.notEqual(submission.mode, "urls");
            if (submission.mode === "urls") return;
            jobs.push(...createManifestImportJobs(
              submission.mode === "weibo" ? submission.result.manifest.items : submission.manifest.items,
              { device: "auto", brightness: "auto", theme, author: "", tags: [] },
              storageSlug, mode, false
            ));
          }
        })
      );
      await renderSource("local", "old");
      const textarea = h.document.querySelector<HTMLTextAreaElement>("textarea")!;
      await h.React.act(async () => {
        inputText(h.window, textarea, mode === "weibo"
          ? "https://weibo.com/123/Abc"
          : '{"original":"https://example.com/image.jpg"}');
        await Promise.resolve();
      });
      const requestIndex = h.pending.length;
      await h.React.act(async () => h.document.querySelector<HTMLButtonElement>(".import-source-submit-button")!.click());
      assert.equal(h.pending.length, requestIndex + 1);
      assert.equal(jobs.length, 0);
      await renderSource("cos", "current");
      const manifest = { items: [{ original: "https://example.com/image.jpg", line: 1, batch_position: 0 }], errors: [] };
      await h.respond(requestIndex, mode === "weibo" ? { manifest, errors: [], posts: [] } : manifest);
      assert.equal(jobs.length, 1, "自动导入只提交一次");
      assert.equal(jobs[0].storageSlug, "cos");
      assert.equal(jobs[0].draft.theme, "current");
      assert.equal(closed, 1);
    }
  } finally {
    await h.render(null); await h.flush(); await h.flush();
    if(priorAttach) Object.defineProperty(dom.HTMLElement.prototype,"attachEvent",priorAttach); else delete (dom.HTMLElement.prototype as any).attachEvent;
    if(priorDetach) Object.defineProperty(dom.HTMLElement.prototype,"detachEvent",priorDetach); else delete (dom.HTMLElement.prototype as any).detachEvent;
    if(priorFocus) Object.defineProperty(dom.HTMLElement.prototype,"focus",priorFocus);
    if(priorBlur) Object.defineProperty(dom.HTMLElement.prototype,"blur",priorBlur);
    for(const [key,descriptor] of previous){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete(globalThis as any)[key];}
  }
});
