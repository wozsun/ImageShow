import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  uploadIntentPath,
  type IngestionQueueSummaryDto
} from "../../../../packages/shared/src/browser.ts";
import type { IngestionJob } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import { webUuidV7 } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-identity.ts";
import { reduceIngestionQueue } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import {
  ingestionJob,
  createConfigStreamHarness
} from "../../support/web-test-context.ts";

test("[Web/内容接入] 全部重试依据完整队列并冻结目标直到分批结果收敛", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { useIngestionRetry } =
    await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionRetry.ts");
  const { useIngestionQueueActions } =
    await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts");
  const failedLocal = ingestionJob({
    id: "browser-failed",
    kind: "upload",
    status: "failed",
    failureStage: "create",
    file: new File(["image"], "image.webp", { type: "image/webp" })
  });
  let local: IngestionJob[] = [];
  let known = [
    ingestionJob({
      id: "visible-failed",
      status: "failed",
      failureStage: "prepare",
      serverAccepted: true,
      sessionId: "A".repeat(43),
      imageId: webUuidV7(),
      serverVersion: 2
    })
  ];
  const baseline: IngestionQueueSummaryDto = {
    total: 31,
    unfinished: 31,
    waiting: 0,
    running: 0,
    ready: 0,
    duplicate_pending: 0,
    committing: 0,
    resolving: 0,
    completed: 0,
    failed: 31
  };
  let releaseRecovery!: () => void;
  let recoveryCount = 0;
  let localRetries: string[][] = [];
  const server = {
    status: "ready",
    summary: baseline,
    actionScope: "scope",
    actionWatermark: "watermark",
    connectionGeneration: 1,
    recoverAfterSuccessfulAction: () => {
      recoveryCount += 1;
      return new Promise<void>((resolve) => {
        releaseRecovery = resolve;
      });
    },
    recoverAuthority: async () => {}
  };
  const queue = {
    queueType: "import",
    get totalItems() {
      return server.summary.total + local.length;
    },
    get localJobs() {
      return local;
    },
    get jobs() {
      return [...local, ...known];
    },
    jobsRef: {
      get current() {
        return [...local, ...known];
      }
    },
    pendingAuthorityHandoff: false,
    hasPendingDraftUpdates: () => false,
    flushPendingUpdates: async () => {},
    server,
    captureBrowserActionJobs: (predicate: (job: IngestionJob) => boolean) =>
      local.filter(predicate),
    actions: undefined as ReturnType<typeof useIngestionQueueActions> | undefined
  };
  let owner!: ReturnType<typeof useIngestionRetry>;
  function Probe() {
    queue.actions = useIngestionQueueActions(
      "import",
      server as never,
      h.React.useRef(false),
      () => {}
    );
    owner = useIngestionRetry({
      queue: queue as never,
      retryBrowserJobs: async (targets) => {
        localRetries.push(targets.map((job) => job.id));
      },
      commitJobs: async () => false
    });
    return null;
  }
  const render = () => h.render(h.React.createElement(Probe));
  await render();
  assert.equal(owner.canRetryAll, true, "当前只驻留一张，但全局 31 项均失败，可以跨页全部重试");
  for (const change of [
    () => {
      server.summary = { ...baseline, ready: 1, failed: 30 };
    },
    () => {
      server.status = "loading";
    },
    () => {
      local = [{ ...failedLocal, file: undefined }];
    },
    () => {
      local = [{ ...failedLocal, failureStage: "cancel" }];
    },
    () => {
      known = [{ ...known[0], status: "ready", duplicateDecision: "undecided", duplicateCount: 1 }];
    },
    () => {
      local = [{ ...failedLocal, status: "cancelled" }];
    }
  ]) {
    server.summary = baseline;
    server.status = "ready";
    local = [];
    known = [{ ...known[0], status: "failed", duplicateDecision: "upload", duplicateCount: 0 }];
    change();
    await render();
    assert.equal(owner.canRetryAll, false);
  }
  server.summary = { ...baseline, total: 0, unfinished: 0, failed: 0 };
  local = [];
  known = [];
  await render();
  assert.equal(owner.canRetryAll, false, "空队列保留提交语义");
  local = [failedLocal];
  await render();
  assert.equal(owner.canRetryAll, true, "浏览器仍持有文件的失败允许重试");
  server.summary = baseline;
  local = [];
  await render();
  let work!: Promise<void>;
  await h.React.act(async () => {
    work = owner.retryAll();
    await Promise.resolve();
  });
  await h.flush();
  await owner.retryAll();
  assert.equal(h.pending.length, 1, "连续点击只启动一轮");
  assert.equal(owner.retryingAll, true);
  const first = JSON.parse(String(h.pending[0].body));
  assert.equal(first.action, "retry_failed");
  assert.equal(first.queue, "import");
  local = [{ ...failedLocal, id: "added-after-click" }];
  await render();
  await h.respond(0, {
    processed: 20,
    changed: 20,
    failed: 0,
    items: [],
    continuation: "next-page"
  });
  assert.equal(h.pending.length, 2);
  const second = JSON.parse(String(h.pending[1].body));
  assert.equal(second.action_request_id, first.action_request_id);
  assert.equal(second.action_watermark, first.action_watermark);
  assert.equal(second.continuation, "next-page");
  await h.respond(1, {
    processed: 11,
    changed: 10,
    failed: 1,
    items: [
      {
        session_id: "B".repeat(43),
        image_id: webUuidV7(),
        status: "failed",
        message: "存储暂不可用"
      }
    ]
  });
  assert.equal(recoveryCount, 1);
  assert.equal(owner.retryBusy, true, "分批写响应已完成，权威队列未回读时继续锁定");
  assert.deepEqual(localRetries, [[]], "执行期间新增任务不进入本轮");
  await h.React.act(async () => {
    releaseRecovery();
    await work;
  });
  assert.equal(owner.retryBusy, false);
  assert.equal(owner.retryingAll, false);
  assert.equal(queue.actions?.notice, "存储暂不可用");
});

test("[Web/内容接入] 提交响应先于队列摘要时等待原读取所有者收敛", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { useIngestionQueueActions } =
    await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts");
  const { useIngestionQueueSubmitActions } =
    await import("../../../../packages/web/src/pages/admin/ingestion/workflow/useIngestionQueueSubmitActions.ts");
  let releaseRead!: () => void;
  let reads = 0;
  const server = {
    status: "ready",
    actionScope: "scope",
    actionWatermark: "watermark",
    connectionGeneration: 1,
    summary: { ready: 18 },
    recoverAuthority: async () => {},
    recoverAfterSuccessfulAction: () => {
      reads++;
      return new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
    }
  };
  const queue = {
    server,
    captureBrowserActionJobs: () => [],
    actions: undefined as ReturnType<typeof useIngestionQueueActions> | undefined
  };
  let workflow!: ReturnType<typeof useIngestionQueueSubmitActions>;
  function Probe() {
    const actions = useIngestionQueueActions(
      "import",
      server as never,
      h.React.useRef(false),
      () => {}
    );
    queue.actions = actions;
    workflow = useIngestionQueueSubmitActions({
      queue: queue as never,
      defaults: { device: "auto", brightness: "auto", theme: "", author: "", tags: [] },
      commitJobs: async () => false,
      onDone: () => {},
      captureServerAction: (action, required) =>
        ({ required, frozen: required ? actions.freeze(action) : null }) as never
    });
    return null;
  }
  await h.render(h.React.createElement(Probe));
  let done = false;
  let work!: Promise<void>;
  await h.React.act(async () => {
    work = workflow.commitReadyJobs().then(() => {
      done = true;
    });
  });
  await h.flush();
  assert.equal(queue.actions?.busy, true);
  await h.respond(0, { processed: 18, changed: 18, failed: 0, items: [] });
  assert.equal(reads, 1);
  assert.equal(server.summary.ready, 18, "模拟尚未到达的 SSE 摘要");
  assert.equal(done, false);
  assert.equal(queue.actions?.busy, true);
  await h.React.act(async () => {
    server.summary.ready = 0;
    releaseRead();
    await work;
  });
  assert.equal(done, true);
  assert.equal(queue.actions?.busy, false);
});

test("[Web/内容接入] 上传重试等待前批结束后复核原尝试及当前资格", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { useUpload } =
    await import("../../../../packages/web/src/pages/admin/ingestion/upload/useUpload.ts");
  const { useIngestionRetry } =
    await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionRetry.ts");
  const { buildUploadIntentItemInput } =
    await import("../../../../packages/web/src/pages/admin/ingestion/upload/upload-jobs.ts");
  let state = { page: 2, jobs: [] as IngestionJob[] };
  const queue = {
    jobsRef: {
      get current() {
        return state.jobs;
      }
    },
    retryPrepareJob(previous: IngestionJob, job: IngestionJob) {
      const next = reduceIngestionQueue(state, { type: "retry-prepare", previous, job });
      const changed = next !== state;
      state = next;
      return changed;
    },
    updateJob(id: string, patch: Partial<IngestionJob>) {
      state = reduceIngestionQueue(state, { type: "patch", id, patch });
    },
    bindServerJob(
      id: string,
      binding: Partial<IngestionJob> & { sessionId: string; imageId: string }
    ) {
      state = reduceIngestionQueue(state, { type: "bind-server", id, binding });
    },
    captureServerConnectionGeneration: () => 1,
    server: { status: "loading", summary: null }
  };
  let upload!: ReturnType<typeof useUpload>;
  let owner!: ReturnType<typeof useIngestionRetry>;
  function Probe() {
    upload = useUpload({
      queue: queue as never,
      defaults: { device: "auto", brightness: "auto", theme: "", author: "", tags: [] },
      storageSlug: "local",
      maxItems: 200,
      maxBytes: 1_000_000,
      maxLongEdge: 560,
      browserConcurrency: 1
    });
    owner = useIngestionRetry({
      queue: queue as never,
      retryBrowserJobs: upload.retryMany,
      commitJobs: async () => false
    });
    return null;
  }
  await h.render(h.React.createElement(Probe));
  const imageTime = "2020-06-17T02:30:45.000Z";
  for (const change of [
    "new-attempt",
    "same-attempt-received",
    "cancelled",
    "valid-unknown-raw"
  ] as const) {
    const blocker = ingestionJob({
      id: `blocker-${change}`,
      kind: "upload",
      status: "failed",
      failureStage: "create",
      file: new File(["blocker"], "blocker.png"),
      objectUrl: "blob:blocker",
      batchPosition: 0
    });
    const target = ingestionJob({
      id: `target-${change}`,
      kind: "upload",
      status: "failed",
      failureStage: "prepare",
      file: new File(["target"], "target.png"),
      objectUrl: "blob:target",
      batchPosition: 1,
      imageTime,
      sessionId: "T".repeat(43),
      imageId: webUuidV7()
    });
    target.uploadIntentItemInput = buildUploadIntentItemInput(target, 560);
    state = { page: 2, jobs: [blocker, target] };
    const first = h.pending.length;
    let blocking!: Promise<void>;
    let retry!: Promise<void>;
    await h.React.act(async () => {
      blocking = upload.retryMany([blocker]);
    });
    await h.flush();
    assert.equal(h.pending.length, first + 1);
    await h.React.act(async () => {
      retry = owner.retry(target);
      void owner.retry(target);
    });
    assert.equal(owner.isRetryPending(target), true);
    assert.equal(owner.isRetryPending(blocker), false, "单卡排队不锁定其他卡片");
    if (change !== "valid-unknown-raw") {
      queue.updateJob(target.id, {
        status: change === "cancelled" ? "cancelled" : "received",
        serverAccepted: change !== "cancelled",
        serverVersion: change === "cancelled" ? undefined : 1,
        attemptKey: change === "new-attempt" ? "new-attempt" : target.attemptKey
      });
    }
    await h.respond(first, { items: [{ status: "failed", message: "前批传输故障" }] });
    if (change === "valid-unknown-raw") {
      await h.flush();
      assert.equal(h.pending.length, first + 2);
      assert.equal(h.pending[first + 1].path, uploadIntentPath);
      const input = JSON.parse(String(h.pending[first + 1].body)).items[0];
      assert.equal(input.idempotency_key, target.attemptKey, "未知 raw 继续使用原幂等身份");
      await h.respond(first + 1, {
        items: [
          {
            status: "accepted",
            session_id: target.sessionId,
            image_id: target.imageId,
            resolved_image_time: imageTime,
            version: 1,
            last_semantic_revision: 2,
            accepted_order: 2
          }
        ]
      });
    }
    await h.React.act(async () => {
      await blocking;
      await retry;
    });
    const current = state.jobs[1];
    assert.equal(current.status, change === "cancelled" ? "cancelled" : "received");
    assert.equal(current.imageTime, imageTime);
    assert.equal(state.page, 2);
    assert.equal(owner.isRetryPending(target), false);
    assert.equal(h.pending.length, first + (change === "valid-unknown-raw" ? 2 : 1));
    assert.ok(
      h.pending.slice(first).every((request) => request.path === uploadIntentPath),
      "旧重试不会取消已接管任务"
    );
  }
});
