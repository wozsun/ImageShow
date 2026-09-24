import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { IngestionJob } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import { webUuidV7 } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-identity.ts";
import {
  canApplyIngestionAttributeDefaults,
  ingestionAttributeDefaultsPatch,
  ingestionJobAttributesEditable
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-attribute-policy.ts";
import {
  browserDisplayPrefixJobs,
  planIngestionQueuePage,
  prepareIngestionQueueDisplay,
  createIngestionCommitIntent,
  ingestionJobCanBeCancelled,
  ingestionJobCanBeRemovedLocally,
  ingestionJobCanLeaveQueue,
  ingestionJobCanStartCommit,
  ingestionQueuePageCount,
  reduceIngestionQueue,
  summarizeIngestionJobs
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import { ingestionStatusEventPatch } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-state.ts";
import {
  ingestionJobStatusDetail,
  ingestionJobStatusLabel
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-detail.ts";
import {
  emptyServerIngestionQueueView,
  parseServerIngestionQueueEvent
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-queue-view.ts";
import {
  draftSyncTarget,
  matchesDraftTarget
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/stored-ingestion-draft-model.ts";
import {
  completedIngestionOwnerPatch,
  completedIngestionReceiptOwnerPatch,
  ingestionJobFromServerItem,
  ingestionJobFromKnownCompletedStatus,
  ingestionJobAwaitsActionCoverage,
  ingestionJobHasServerAuthority,
  ingestionHandoffRetryDecision,
  serverIngestionJobsForCombinedPage
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-job.ts";
import { resetJobForPrepareRetry } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job-retry.ts";
import { createUrlImportJobs } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/import-job-source.ts";
import { createManifestImportJobs } from "../../../../packages/web/src/pages/admin/ingestion/import/manifest-jobs.ts";
import { buildUploadIntentItemInput } from "../../../../packages/web/src/pages/admin/ingestion/upload/upload-jobs.ts";
import {
  cleanupActionType,
  preserveUnresolvedLocalOutcomes,
  retainUnresolvedLocalJobs
} from "../../../../packages/web/src/pages/admin/ingestion/workflow/ingestion-workflow-action-model.ts";
import { ingestionJob, adminImageListItem } from "../../support/web-test-context.ts";

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
  assert.deepEqual(
    parseServerIngestionQueueEvent(
      JSON.stringify({
        type: "ready",
        queue: "upload",
        revision: 4,
        action_scope: "scope-four"
      }),
      "ready",
      "upload"
    ),
    {
      type: "ready",
      queue: "upload",
      revision: 4,
      action_scope: "scope-four"
    }
  );
  assert.throws(
    () =>
      parseServerIngestionQueueEvent(
        JSON.stringify({ type: "ready", queue: "import" }),
        "ready",
        "upload"
      ),
    /内容接入队列事件格式无效/u
  );

  const imageId = "00000000-0000-7001-8000-00000000008e";
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
  assert.equal(
    matchesDraftTarget(
      {
        ...authoritative,
        imageId: imageId.toUpperCase()
      },
      target
    ),
    true
  );
  assert.equal(
    draftSyncTarget({
      ...authoritative,
      serverAccepted: false
    }),
    null
  );

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
  assert.deepEqual(
    retainUnresolvedLocalJobs([local, nextAttempt], {
      unresolved: [{ id: nextAttempt.id, attemptKey: nextAttempt.attemptKey }]
    }),
    [nextAttempt]
  );
  assert.deepEqual(
    preserveUnresolvedLocalOutcomes(
      {
        unresolved: [{ id: nextAttempt.id, attemptKey: nextAttempt.attemptKey }]
      },
      {
        unresolved: [
          {
            id: nextAttempt.id,
            attemptKey: nextAttempt.attemptKey,
            outcome: { succeeded: false }
          }
        ]
      }
    ).unresolved[0]?.outcome,
    { succeeded: false }
  );
  assert.equal(cleanupActionType("duplicates"), "clear_duplicate_pending");
  assert.equal(cleanupActionType("uncommitted"), "clear_uncommitted");
  assert.equal(cleanupActionType("completed"), "clear_completed");
});
test("[Web/内容接入] 导入与批量默认标签追加去重且保留来源单值和冻结提交", () => {
  const defaults = {
    device: "pc" as const,
    brightness: "light" as const,
    theme: "default-theme",
    author: "default-author",
    tags: ["shared", "preset"]
  };
  for (const sourceType of ["jsonl", "weibo"] as const) {
    for (const tags of [undefined, [], ["2026", "shared", "2026"]]) {
      const [job] = createManifestImportJobs(
        [
          {
            line: 1,
            batch_position: 0,
            original: "https://example.com/image.jpg",
            theme: "source-theme",
            author: "source-author",
            tags
          }
        ],
        defaults,
        "local",
        sourceType,
        true
      );
      assert.ok(job);
      const expected = tags?.length ? ["2026", "shared", "preset"] : defaults.tags;
      assert.deepEqual(job.draft.tags, expected);
      assert.equal(job.draft.theme, "source-theme");
      assert.equal(job.draft.author, "source-author");
      if (tags?.length) assert.deepEqual(tags, ["2026", "shared", "2026"], "合并不能改写来源数组");
      for (const status of ["queued", "ready"] as const) {
        const editable = { ...job, status };
        const patch = ingestionAttributeDefaultsPatch(editable, {
          ...defaults,
          tags: ["preset", "later"]
        });
        assert.deepEqual(patch.tags, [...expected, "later"]);
        const applied = { ...editable, draft: { ...editable.draft, ...patch } };
        assert.deepEqual(
          ingestionAttributeDefaultsPatch(applied, {
            ...defaults,
            tags: ["preset", "later"]
          }).tags,
          patch.tags,
          "重复应用保持幂等"
        );
        assert.equal(
          ingestionAttributeDefaultsPatch(applied, {
            ...defaults,
            tags: []
          }).tags,
          undefined,
          "空默认标签不能擦除已有标签"
        );
      }
      assert.deepEqual(
        ingestionAttributeDefaultsPatch(
          {
            ...job,
            status: "committing"
          },
          defaults
        ),
        {},
        "冻结提交不再修改草稿"
      );
    }
  }
  assert.deepEqual(defaults.tags, ["shared", "preset"]);
});

test("[Web/内容接入] 内容接入队列以 pair、version 与 progress_seq 单调合并服务端状态", () => {
  assert.deepEqual(
    summarizeIngestionJobs([
      ingestionJob({ id: "waiting-download", status: "queued" }),
      ingestionJob({ id: "waiting-prepare", status: "received" }),
      ingestionJob({ id: "active-download", status: "downloading" }),
      ingestionJob({ id: "active-prepare", status: "processing" })
    ]),
    {
      readyCount: 0,
      unfinishedCount: 4,
      duplicateJobs: 0,
      waitingJobs: 1,
      runningJobs: 2,
      commitQueuedJobs: 0,
      committingJobs: 0,
      finalizedJobs: 0,
      doneJobs: 0,
      failedJobs: 0
    },
    "等待 worker 准入的任务不得计入处理中"
  );

  const sessionId = "A".repeat(43);
  const imageId = "00000000-0000-7002-8000-00000000008e";
  const attemptKey = "00000000-0000-7003-8000-00000000008e";
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
    accepted_order: 1,
    metadata: base.draft,
    storage_slug: "local"
  };
  const waitingForNormalization = ingestionJobFromServerItem(prepareWaitingItem, base);
  assert.equal(waitingForNormalization.status, "received");
  assert.equal(ingestionJobStatusLabel(waitingForNormalization), "待处理");
  assert.equal(ingestionJobStatusDetail(waitingForNormalization), "原图素材已接收，等待处理");
  assert.equal(
    summarizeIngestionJobs([waitingForNormalization]).waitingJobs,
    0,
    "完整 raw 待处理不计入等待数量"
  );
  assert.equal(summarizeIngestionJobs([waitingForNormalization]).runningJobs, 0);
  assert.equal(summarizeIngestionJobs([waitingForNormalization]).unfinishedCount, 1);
  const normalizationStarted = ingestionJobFromServerItem(
    {
      ...prepareWaitingItem,
      phase: "normalizing",
      message: "校验格式、压缩原图并生成缩略图",
      progress_seq: 1
    },
    waitingForNormalization
  );
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
      accepted_order: 1,
      metadata: base.draft,
      storage_slug: "local"
    }
  });
  assert.ok(progress);
  const advanced = reduceIngestionQueue(
    { jobs: [base], page: 1 },
    {
      type: "patch",
      id: base.id,
      patch: progress
    }
  );
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
      accepted_order: 1,
      metadata: base.draft,
      storage_slug: "local"
    }
  });
  assert.ok(stale);
  assert.equal(
    reduceIngestionQueue(advanced, {
      type: "patch",
      id: base.id,
      patch: stale
    }),
    advanced
  );
  assert.equal(
    ingestionStatusEventPatch(base, {
      session_id: "B".repeat(43),
      image_id: imageId,
      status: "missing"
    }),
    null
  );
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
    frozenUploadInput,
    "raw 结果未知必须复用冻结正文与原幂等身份"
  );
  assert.equal(resetJobForPrepareRetry(frozenUploadJob).attemptKey, attemptKey);
  const confirmedUploadRetry = resetJobForPrepareRetry({ ...frozenUploadJob, serverVersion: 1 });
  assert.equal(confirmedUploadRetry.uploadIntentItemInput, undefined);
  assert.notEqual(confirmedUploadRetry.attemptKey, attemptKey);
  const retriedServerJob = resetJobForPrepareRetry(
    ingestionJob({
      ...frozenUploadJob,
      serverAccepted: true,
      serverSemanticRevision: 11,
      serverAcceptedOrder: 19
    })
  );
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
    resetJobForPrepareRetry(
      ingestionJob({
        attemptKey,
        status: "failed",
        failureStage: "create",
        importAcceptItemInput: frozenImportInput
      })
    ).importAcceptItemInput,
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
  const defaultsAppliedInFlight = reduceIngestionQueue(
    {
      jobs: [inFlightPlaceholder],
      page: 1
    },
    {
      type: "apply-defaults",
      defaults: inFlightDefaults,
      attempts: new Map([[inFlightPlaceholder.id, attemptKey]])
    }
  ).jobs[0]!;
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
  assert.equal(
    ingestionJobCanBeRemovedLocally(
      ingestionJob({
        ...ready,
        status: "done",
        serverAccepted: true,
        serverStatus: "completed"
      })
    ),
    false,
    "Server completed 回执只能通过清空已完成持久删除"
  );
  assert.equal(
    ingestionJobCanBeRemovedLocally(
      ingestionJob({
        ...ready,
        status: "done",
        serverAccepted: false
      })
    ),
    true,
    "PG 已接管且 Redis 回执缺失的本地完成卡仍可移除"
  );
  assert.equal(ingestionQueuePageCount(51, 20), 3);
  const intent = createIngestionCommitIntent(ready, "00000000-0000-7004-8000-00000000008e");
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
  assert.equal(
    ingestionJobCanBeCancelled(
      ingestionJob({
        ...failedFrozenCommit,
        serverStatus: undefined
      })
    ),
    false,
    "结果未知的本地提交失败不得被当成可安全移除"
  );

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
  assert.equal(
    ingestionJobAwaitsActionCoverage(
      {
        ...acceptedBeforeChannel,
        serverAcceptedOrder: 1
      },
      9
    ),
    true,
    "旧 DTO 的 accepted_order 不得越过更新的 HTTP 接管围栏"
  );
  const canonical = ingestionJobFromServerItem(
    {
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
      accepted_order: 1,
      metadata: localPlaceholder.draft,
      storage_slug: "local"
    },
    localPlaceholder
  );
  const handedOff = reduceIngestionQueue(
    {
      jobs: [localPlaceholder],
      page: 1
    },
    {
      type: "replace-server-page",
      jobs: [canonical]
    }
  );
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
    accepted_order: 2,
    metadata: {
      ...unboundLocal.draft,
      title: "accept 请求里的旧草稿"
    },
    storage_slug: "local"
  });
  const lateBinding = reduceIngestionQueue(
    {
      jobs: [unboundLocal, earlyCanonical],
      page: 1
    },
    {
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
    }
  );
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

  const oldIncarnationImageId = "00000000-0000-7008-8000-00000000008e";
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
  const replacedIncarnation = reduceIngestionQueue(
    {
      jobs: [newIncarnationPlaceholder, oldIncarnation],
      page: 1
    },
    {
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
    }
  );
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

  const staleSnapshotDuringDraftFence = ingestionJobFromServerItem(
    {
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
      accepted_order: 2,
      metadata: {
        ...unboundLocal.draft,
        title: "旧快照中的草稿"
      },
      storage_slug: "local"
    },
    {
      ...lateBinding.jobs[0]!,
      serverVersion: 5,
      serverSemanticRevision: 11,
      serverDraftPending: true,
      draft: {
        ...unboundLocal.draft,
        title: "HTTP 已确认的新草稿"
      }
    },
    10
  );
  assert.equal(staleSnapshotDuringDraftFence.serverVersion, 5);
  assert.equal(staleSnapshotDuringDraftFence.serverSemanticRevision, 11);
  assert.equal(staleSnapshotDuringDraftFence.serverDraftPending, true);
  assert.equal(
    staleSnapshotDuringDraftFence.draft.title,
    "HTTP 已确认的新草稿",
    "草稿围栏解除前，旧快照不得回退版本或覆盖新草稿"
  );

  const completedReplayBeforeSnapshot = reduceIngestionQueue(
    {
      jobs: [localPlaceholder],
      page: 1
    },
    {
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
    }
  ).jobs[0]!;
  assert.equal(
    ingestionJobAwaitsActionCoverage(completedReplayBeforeSnapshot, 999),
    true,
    "未知 Redis 水位的 completed 重放必须等待一次新权威快照"
  );
  const completedReplayDuringActiveSnapshot = ingestionJobFromServerItem(
    {
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
      accepted_order: 1,
      metadata: localPlaceholder.draft,
      storage_slug: "local"
    },
    completedReplayBeforeSnapshot,
    11
  );
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
  const completedReplayAfterSnapshot = ingestionJobFromServerItem(
    {
      session_id: sessionId,
      image_id: imageId,
      queue: "upload",
      status: "completed",
      version: 6,
      progress_seq: 0,
      last_semantic_revision: 12,
      accepted_order: 1,
      completed_at: 2,
      completed_item: adminImageListItem({ id: imageId })
    },
    completionDisplaySource,
    12
  );
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
  assert.equal(ingestionJobAwaitsActionCoverage(completedReplayAfterSnapshot, 12), false);

  const recoveredCompleted = ingestionJobFromServerItem(
    {
      session_id: sessionId,
      image_id: imageId,
      queue: "import",
      status: "completed",
      version: 6,
      progress_seq: 0,
      last_semantic_revision: 12,
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
    },
    ingestionJob({
      batchPosition: 6,
      browserDisplayReleased: true
    })
  );
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
    image_id: "00000000-0000-7091-8000-00000000008e",
    queue: "import",
    source_type: "weibo",
    resolved_image_time: "2026-08-23T01:02:03.456Z",
    status: "queued",
    phase: "queued",
    message: "queued",
    version: 1,
    progress_seq: 0,
    last_semantic_revision: 1,
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
    image_id: "00000000-0000-7092-8000-00000000008e",
    queue: "import",
    status: "completed",
    version: 2,
    progress_seq: 0,
    last_semantic_revision: 2,
    accepted_order: 3,
    completed_at: 2,
    completed_item: adminImageListItem({
      id: "00000000-0000-7092-8000-00000000008e"
    })
  });
  assert.equal(
    restoredCompletedWithoutOwner.browserDisplayReleased,
    true,
    "窗口重开水合的完成卡片不得再经历一次浏览器批次释放"
  );

  const acceptedWithoutSnapshot = reduceIngestionQueue(
    {
      jobs: [localPlaceholder],
      page: 1
    },
    {
      type: "bind-server",
      id: localPlaceholder.id,
      binding: {
        sessionId,
        imageId,
        status: "received",
        message: "服务器已接管"
      }
    }
  ).jobs[0]!;
  assert.equal(
    ingestionJobHasServerAuthority(acceptedWithoutSnapshot),
    true,
    "accept 成功必须立即转交业务权威，不能等待 accepted_order"
  );
  assert.equal(acceptedWithoutSnapshot.serverAcceptedOrder, undefined);

  const handoffBatchKey = webUuidV7();
  const sourceOrderedBatch = Array.from({ length: 5 }, (_, position) =>
    ingestionJob({
      id: `source-order-${position}`,
      attemptKey: `source-order-attempt-${position}`,
      batchKey: handoffBatchKey,
      batchPosition: position,
      serverAccepted: false,
      status: "uploading"
    })
  );
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
        imageId: `019f8457-063a-7${String(position).padStart(3, "0")}-a580-00000000008e`,
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: position + 1,
        serverHandoffDisplayPage: 1,
        status: "received"
      }
    });
  }
  const acceptedBySnapshotOrder = [1, 4].map((position) =>
    partiallyAccepted.jobs.find((job) => job.id === `source-order-${position}`)!
  );
  partiallyAccepted = reduceIngestionQueue(partiallyAccepted, {
    type: "replace-server-page",
    jobs: acceptedBySnapshotOrder
  });
  assert.deepEqual(
    browserDisplayPrefixJobs(partiallyAccepted.jobs).map((job) => job.batchPosition),
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
    browserDisplayPrefixJobs(partiallyAccepted.jobs).map((job) => job.batchPosition),
    [0, 1, 2, 3, 4],
    "后续页未覆盖 pair 时也不得丢失当前文档的已接管展示项"
  );
  const partialPagePlan = planIngestionQueuePage(
    prepareIngestionQueueDisplay(partiallyAccepted.jobs),
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
    imageId: `019f8457-063a-71${String(position).padStart(2, "0")}-a580-00000000008e`,
    serverAccepted: true,
    serverHandoffPending: false,
    status: "received" as const
  }));
  const fullyAcceptedPlan = planIngestionQueuePage(
    prepareIngestionQueueDisplay(fullyAcceptedBatch),
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
  const retainedBatch = reduceIngestionQueue(
    {
      jobs: fullyAcceptedBatch,
      page: 1
    },
    {
      type: "replace-server-page",
      jobs: [...fullyAcceptedBatch]
    }
  );
  assert.deepEqual(
    browserDisplayPrefixJobs(retainedBatch.jobs).map((job) => job.batchPosition),
    [0, 1, 2, 3, 4],
    "当前文档必须在完整接管后继续保序，避免快照参数扩张尾请求"
  );
  assert.ok(
    retainedBatch.jobs.every(
      (job) => job.browserDisplayReleased !== true && job.batchPosition !== undefined
    ),
    "只有窗口重开后的 Server-only 任务才应释放浏览器展示顺序"
  );

  const paginationBatchKey = webUuidV7();
  const paginationJobs = Array.from({ length: 23 }, (_, position) => {
    const positionHex = position.toString(16).padStart(3, "0");
    return ingestionJob({
      id: `pagination-owner-${position}`,
      attemptKey: `pagination-attempt-${position}`,
      batchKey: paginationBatchKey,
      batchPosition: position,
      sessionId: `pagination-session-${position}`,
      imageId: `019f8457-063a-7${positionHex}-a580-00000000008e`,
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
  const compactCompletionPatch = completedIngestionReceiptOwnerPatch(compactCompletionOwner, {
    session_id: compactCompletionOwner.sessionId!,
    image_id: compactCompletionOwner.imageId!,
    status: "completed",
    version: 6,
    progress_seq: 0,
    last_semantic_revision: 6,
    accepted_order: 23
  });
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
    ingestionJobFromServerItem(
      {
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
        accepted_order: 23,
        metadata: compactCompletionOwner.draft,
        storage_slug: "local"
      },
      compactCompletedJob
    ),
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
  const allCompletionPatches = new Map(
    paginationJobs.map((job) => [job.id, completedPatchFor(job)] as const)
  );
  allCompletionPatches.set(paginationJobs[22]!.id, compactCompletionPatch);
  let completedPaginationState = reduceIngestionQueue(
    {
      jobs: paginationJobs,
      page: 1
    },
    {
      type: "patch-many",
      patches: allCompletionPatches
    }
  );
  assert.equal(completedPaginationState.jobs.length, 23);
  assert.ok(completedPaginationState.jobs.every((job) => job.status === "done"));
  completedPaginationState = reduceIngestionQueue(completedPaginationState, {
    type: "set-page",
    page: 2,
    pageSize: 20,
    totalItems: 23
  });
  const completedSecondPageFirstRender = planIngestionQueuePage(
    prepareIngestionQueueDisplay(completedPaginationState.jobs),
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
    ingestionJobFromServerItem(
      {
        session_id: failedSecondPageOwner.sessionId!,
        image_id: failedSecondPageOwner.imageId!,
        queue: "import",
        source_type: "url",
        resolved_image_time: "2026-08-23T01:02:03.456Z",
        status: "failed",
        phase: "commit-failed",
        message: "逐项提交失败",
        error: { message: "逐项提交失败" },
        version: 6,
        progress_seq: 0,
        last_semantic_revision: 6,
        accepted_order: 22,
        metadata: failedSecondPageOwner.draft,
        storage_slug: "local"
      },
      failedSecondPageOwner
    )
  );
  let partialPaginationState = reduceIngestionQueue(
    {
      jobs: paginationJobs,
      page: 1
    },
    {
      type: "patch-many",
      patches: partialCompletionPatches
    }
  );
  assert.ok(
    partialPaginationState.jobs.slice(0, 20).every((job) => job.status === "committing"),
    "顶部汇总不得被用来批量猜测未收到逐项事实的卡片"
  );
  partialPaginationState = reduceIngestionQueue(partialPaginationState, {
    type: "set-page",
    page: 2,
    pageSize: 20,
    totalItems: 23
  });
  assert.deepEqual(
    planIngestionQueuePage(
      prepareIngestionQueueDisplay(partialPaginationState.jobs),
      partialPaginationState.page,
      20,
      100
    ).visibleDisplayPrefixJobs.map((job) => job.status),
    ["done", "failed", "done"],
    "离页逐项成功与失败必须保持各自权威结果"
  );

  const completedOwner = completedPaginationState.jobs[20]!;
  const staleSnapshotOwner = ingestionJobFromServerItem(
    {
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
      accepted_order: 21,
      metadata: completedOwner.draft,
      storage_slug: "local"
    },
    completedOwner
  );
  assert.equal(
    staleSnapshotOwner,
    completedOwner,
    "完成事件先于分页 snapshot 时，旧 active DTO 必须被单调围栏"
  );
  const racedSnapshotState = reduceIngestionQueue(completedPaginationState, {
    type: "replace-server-page",
    jobs: [staleSnapshotOwner]
  });
  assert.equal(racedSnapshotState.jobs.length, 23);
  assert.equal(racedSnapshotState.jobs.find((job) => job.id === completedOwner.id)?.status, "done");
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
  const finalizedBeforeEvent = reduceIngestionQueue(
    {
      jobs: [responseRaceOwner],
      page: 1
    },
    {
      type: "patch",
      id: responseRaceOwner.id,
      patch: finalizedResponsePatch
    }
  );
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
  const eventAfterProgressedResponse = reduceIngestionQueue(
    {
      jobs: [progressedResponseOwner],
      page: 1
    },
    {
      type: "patch",
      id: progressedResponseOwner.id,
      patch: completedPatchFor(progressedResponseOwner, 6)
    }
  );
  assert.equal(eventAfterProgressedResponse.jobs[0]?.status, "done");
  assert.equal(eventAfterProgressedResponse.jobs[0]?.serverVersion, 7);
  assert.equal(
    eventAfterProgressedResponse.jobs[0]?.serverProgressSeq,
    4,
    "较旧完成事实必须取胜，但不能倒退浏览器已观察到的 Redis 时钟"
  );
  const completedSnapshotAfterNewerActive = ingestionJobFromServerItem(
    {
      session_id: responseRaceOwner.sessionId!,
      image_id: responseRaceOwner.imageId!,
      queue: "import",
      status: "completed",
      version: 6,
      progress_seq: 0,
      last_semantic_revision: 6,
      accepted_order: 1,
      completed_at: 2,
      completed_item: adminImageListItem({ id: responseRaceOwner.imageId! })
    },
    progressedResponseOwner
  );
  assert.equal(completedSnapshotAfterNewerActive.status, "done");
  assert.equal(completedSnapshotAfterNewerActive.serverVersion, 7);
  assert.equal(completedSnapshotAfterNewerActive.serverProgressSeq, 4);
  const eventBeforeResponse = reduceIngestionQueue(
    {
      jobs: [responseRaceOwner],
      page: 1
    },
    {
      type: "patch",
      id: responseRaceOwner.id,
      patch: completedPatchFor(responseRaceOwner, 6)
    }
  );
  assert.equal(
    reduceIngestionQueue(eventBeforeResponse, {
      type: "patch",
      id: responseRaceOwner.id,
      patch: finalizedResponsePatch
    }),
    eventBeforeResponse,
    "迟到的提交 HTTP 状态不得把 completed 卡片回退为 finalized"
  );

  const displayOldIncarnation = fullyAcceptedBatch[0]!;
  const replacementIncarnation = ingestionJob({
    ...displayOldIncarnation,
    id: displayOldIncarnation.id,
    imageId: "00000000-0000-7200-8000-00000000008e",
    batchPosition: undefined,
    browserDisplayReleased: true
  });
  const staleReplaced = reduceIngestionQueue(
    {
      jobs: [displayOldIncarnation, sourceOrderedBatch[1]!],
      page: 1
    },
    {
      type: "replace-server-page",
      jobs: [replacementIncarnation],
      stalePairKeys: new Set([
        `${displayOldIncarnation.sessionId}\0${displayOldIncarnation.imageId!.toLowerCase()}`
      ])
    }
  );
  assert.equal(staleReplaced.jobs.length, 2);
  assert.equal(staleReplaced.jobs[0]?.id, sourceOrderedBatch[1]!.id);
  assert.equal(staleReplaced.jobs[1]?.imageId, replacementIncarnation.imageId);
  assert.equal(staleReplaced.jobs[1]?.batchPosition, undefined);

  const fullPageAcceptedPositions = new Set([0, 3, 19, 21, 25, 39]);
  const fullPageBatch = Array.from({ length: 40 }, (_, position) =>
    ingestionJob({
      id: `full-page-${position}`,
      attemptKey: `full-page-attempt-${position}`,
      batchKey: handoffBatchKey,
      batchPosition: position,
      sessionId: fullPageAcceptedPositions.has(position)
        ? `full-page-session-${position}`
        : undefined,
      imageId: fullPageAcceptedPositions.has(position) ? `full-page-image-${position}` : undefined,
      serverAccepted: fullPageAcceptedPositions.has(position),
      status: fullPageAcceptedPositions.has(position) ? "received" : "uploading"
    })
  );
  const firstFullPagePlan = planIngestionQueuePage(
    prepareIngestionQueueDisplay(fullPageBatch),
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
  const secondFullPagePlan = planIngestionQueuePage(
    prepareIngestionQueueDisplay(fullPageBatch),
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

  const partialSecondPagePlan = planIngestionQueuePage(
    prepareIngestionQueueDisplay(fullPageBatch.slice(0, 25)),
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

  const takeoverJobs = Array.from({ length: 30 }, (_, index) =>
    ingestionJob({
      id: `takeover-${index}`,
      sessionId: `session-${index}`,
      imageId: `image-${index}`,
      serverAccepted: true,
      status: "received"
    })
  );
  assert.deepEqual(
    serverIngestionJobsForCombinedPage(takeoverJobs, [], 0),
    [],
    "本地前缀填满页面时，逐项 takeover 不得把 Server 占位追加到当前页"
  );
  assert.deepEqual(
    serverIngestionJobsForCombinedPage(takeoverJobs, [], 1, new Set(["session-0\0image-0"])).map(
      (job) => job.id
    ),
    ["takeover-0"],
    "响应先于 snapshot 时须在现有 Server 槽位保留原占位卡"
  );
  assert.deepEqual(
    serverIngestionJobsForCombinedPage(
      takeoverJobs,
      [
        { session_id: "session-8", image_id: "image-8" },
        { session_id: "session-3", image_id: "image-3" }
      ],
      1
    ).map((job) => job.id),
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
      imageId: `019f8457-063a-7${index.toString(16).padStart(3, "0")}` + "-a580-00000000008e",
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
      accepted_order: index + 1,
      metadata: job.draft,
      storage_slug: "local"
    };
  };
  const projectedOwners = provisionalOwners.map((job, index) =>
    index < 18 ? ingestionJobFromServerItem(activeEventFor(job, index), job) : job
  );
  const retainedProvisionalOwners = projectedOwners.filter(
    (job) => job.serverHandoffPending === true && job.serverHandoffProvisionalTotal === true
  );
  assert.equal(
    retainedProvisionalOwners.length,
    25,
    "bounded snapshot 接管汇总前，任意来源的逐项事件不得逐张撤掉临时总数"
  );
  assert.ok(
    projectedOwners.every((job) => job.serverHandoffDisplayPage === 1),
    "逐项事件也不得撤掉尚未被 snapshot 覆盖的展示页租约"
  );
  assert.deepEqual(
    summarizeIngestionJobs(retainedProvisionalOwners),
    {
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
    },
    "处理阶段只应在等待与处理中之间逐项迁移，总数必须保持 25"
  );
  assert.deepEqual(
    planIngestionQueuePage(
      prepareIngestionQueueDisplay(projectedOwners),
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
