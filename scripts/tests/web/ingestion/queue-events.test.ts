import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ingestionCommitPath,
  ingestionStatusPath,
  type IngestionVocabularyDto
} from "../../../../packages/shared/src/browser.ts";
import {
  invalidateVocabularyData,
  invalidateImageDataAfterIngestion,
  invalidateImageDataAfterMetadataSave
} from "../../../../packages/web/src/lib/api/query-invalidation.ts";
import {
  queryKeys
} from "../../../../packages/web/src/lib/api/query-keys.ts";
import {
  recordAdminImageListValidation
} from "../../../../packages/web/src/lib/api/admin-image-list-validation.ts";
import {
  createIngestionCommitIntent
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import {
  ingestionStatusEventPatch
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-status-state.ts";
import {
  commitSelectedIngestions
} from "../../../../packages/web/src/pages/admin/ingestion/queue/ingestion-commit-batch.ts";
import {
  baselineFromIngestionSnapshot,
  ingestionQueueBaselineCoversSelection,
  mergeIngestionQueueMutation
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/server-ingestion-queue-state.ts";
import {
  ingestionJob,
  adminImageListItem
} from "../../support/web-test-context.ts";

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
    image_id: "00000000-0000-7005-8000-00000000008e",
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
    accepted_order: 1,
    metadata: {
      device: "auto" as const,
      brightness: "auto" as const,
      theme: null,
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
      : `019f8457-063a-72${String(index).padStart(2, "0")}-a580-00000000008e`,
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
    waiting: 0,
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
    image_id: "00000000-0000-7005-8000-00000000008e",
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
    accepted_order: 1,
    metadata: {
      device: "auto" as const,
      brightness: "auto" as const,
      theme: null,
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
        waiting: 0,
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
    "00000000-0000-7005-8000-00000000008e",
    "00000000-0000-7006-8000-00000000008e"
  ];
  const attemptIds = [
    "00000000-0000-7007-8000-00000000008e",
    "00000000-0000-7008-8000-00000000008e"
  ];
  const commitRequestIds = [
    "00000000-0000-7009-8000-00000000008e",
    "00000000-0000-700a-8000-00000000008e"
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
      attemptKey: "00000000-0000-7014-8000-00000000008e",
      sessionId: "R".repeat(43),
      imageId: "00000000-0000-7015-8000-00000000008e",
      status: "ready",
      serverVersion: 7,
      duplicateDecision: "upload"
    });
    const lostResponseJob = {
      ...lostResponseReady,
      commitIntent: createIngestionCommitIntent(
        lostResponseReady,
        "00000000-0000-7016-8000-00000000008e"
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
      attemptKey: "00000000-0000-700b-8000-00000000008e",
      sessionId: "C".repeat(43),
      imageId: "00000000-0000-700c-8000-00000000008e",
      status: "ready",
      serverVersion: 5,
      duplicateDecision: "upload"
    });
    const duplicateJob = {
      ...duplicateReady,
      commitIntent: createIngestionCommitIntent(
        duplicateReady,
        "00000000-0000-700d-8000-00000000008e"
      )
    };
    const duplicateCurrent = new Map([[duplicateJob.id, duplicateJob]]);
    const duplicateItem = adminImageListItem({
      id: "00000000-0000-700e-8000-00000000008e"
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
    themes: [{ slug: "null", display_name: "未设置" }],
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
  await invalidateVocabularyData(authorProfileClient);
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
  const { imageDataRevision } = await import("../../../../packages/web/src/lib/api/image-data-revision.ts");
  for (const listKey of [queryKeys.tags, queryKeys.themes, queryKeys.authors]) {
    const vocabularyClient = new QueryClient();
    for (const key of allKeys) vocabularyClient.setQueryData(key, {});
    const revision = imageDataRevision(vocabularyClient);
    await invalidateVocabularyData(vocabularyClient, listKey);
    const affected: readonly (readonly unknown[])[] = [listKey, queryKeys.galleryFacets,
      queryKeys.galleryStats, queryKeys.ingestionVocabulary];
    for (const key of allKeys) {
      assert.equal(invalidated(vocabularyClient, key), affected.includes(key), key[0]);
    }
    assert.equal(imageDataRevision(vocabularyClient), revision, "词表编辑保留图片窗口的读取水位");
    vocabularyClient.clear();
  }
});
test("[Web/内容接入] 元数据保存只在词条超出共享接入词表时刷新一次", async () => {
  const { QueryClient, QueryObserver } = await import("@tanstack/react-query");
  const vocabulary: IngestionVocabularyDto = {
    themes: [{ slug: "null", display_name: "未设置" }],
    authors: [{ slug: "known-author", display_name: "已有作者" }],
    tags: [{ slug: "known-tag", display_name: "已有标签" }]
  };
  for (const scenario of [
    { updates: [{ id: "one", title: "仅标题" }], reads: 0 },
    { updates: [{ id: "one", theme: null, author: "known-author", tags: ["known-tag"] }], reads: 0 },
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
