import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  ingestionActionPath,
  ingestionSnapshotPath,
  type IngestionQueueActionResultDto
} from "../../../../packages/shared/src/browser.ts";
import type { IngestionJob } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import { clearCsrfToken, setCsrfToken } from "../../../../packages/web/src/lib/api/client.ts";
import { getIngestionQueueSnapshot } from "../../../../packages/web/src/pages/admin/ingestion/queue/ingestion-http-client.ts";
import { ingestionJob, adminImageListItem } from "../../support/web-test-context.ts";

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
    id: "00000000-0000-7001-8000-00000000008e"
  });
  const connectionHold = { current: false };
  const fetchStub = async (_path: string, init?: RequestInit) => {
    assert.equal(connectionHold.current, true, "continuation 执行期间必须持有当前 owner 状态通道");
    fetchCalls += 1;
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    requests.push(body);
    if (fetchCalls === 1) {
      return new Response("upstream response lost", { status: 502 });
    }
    if (body.action === "clear_completed") {
      return new Response(
        JSON.stringify({
          ok: true,
          processed: 0,
          changed: 0,
          failed: 0,
          items: []
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
    }
    const continuation = body.continuation;
    const skipped = Boolean(continuation);
    return new Response(
      JSON.stringify({
        ok: true,
        processed: 1,
        changed: skipped ? 0 : 1,
        failed: 0,
        items: [
          {
            session_id: continuation ? "B".repeat(43) : "A".repeat(43),
            image_id: continuation
              ? "00000000-0000-7002-8000-00000000008e"
              : "00000000-0000-7001-8000-00000000008e",
            status: skipped ? "skipped" : "changed",
            ...(continuation ? {} : { completed_item: actionCompletedItem })
          }
        ],
        ...(continuation ? {} : { continuation: "signed-next-cursor" })
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
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
    Object.keys(installedGlobals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    )
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
    const { useIngestionQueueActions } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts");
    const server = {
      status: "ready",
      actionScope: "S".repeat(32),
      actionWatermark: "frozen-watermark",
      lastAcceptedOrder: 120,
      connectionGeneration: 7,
      refresh: () => {
        refreshes += 1;
      },
      recoverAuthority: async () => {
        refreshes += 1;
      }
    };
    let actions: ReturnType<typeof useIngestionQueueActions> | undefined;
    function Probe() {
      actions = useIngestionQueueActions("upload", server as never, connectionHold, (entries) => {
        assert.equal(refreshes, 0, "完成 DTO 必须在动作刷新前交给 owner");
        observedActionCompleted.push(...entries.map(({ pair }) => pair.image_id));
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
    assert.deepEqual(
      queuedResult && {
        processed: queuedResult.processed,
        changed: queuedResult.changed,
        failed: queuedResult.failed
      },
      { processed: 0, changed: 0, failed: 0 }
    );
    assert.equal(connectionHold.current, false);
    assert.deepEqual(
      result && {
        processed: result.processed,
        changed: result.changed,
        failed: result.failed
      },
      { processed: 2, changed: 1, failed: 0 }
    );
    assert.equal(actions.notice, "", "只有状态变化而无真实失败时不得显示协议动作汇总");
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

    const nonBlockingFrozen = actions.freeze("apply_metadata", { title: "不阻塞输入框" });
    assert.ok(nonBlockingFrozen);
    let releaseNonBlockingPreflight!: () => void;
    const nonBlockingPreflight = new Promise<void>((resolve) => {
      releaseNonBlockingPreflight = resolve;
    });
    let nonBlockingRun!: ReturnType<typeof actions.run>;
    await React.act(async () => {
      nonBlockingRun = actions!.run(nonBlockingFrozen, () => nonBlockingPreflight, {
        blockUi: false
      });
      await Promise.resolve();
    });
    assert.equal(connectionHold.current, true);
    assert.equal(actions.busy, false, "应用默认值的后台持久化不得禁用整窗卡片控件");
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
      return new Response(
        JSON.stringify({
          ok: false,
          code: "invalid_ingestion_token",
          error: "内容接入凭证已过期或时间无效"
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" }
        }
      );
    }
    if (url.pathname === ingestionSnapshotPath) {
      const queue = url.searchParams.get("queue");
      if (queue === "upload") uploadSnapshotRequests += 1;
      else importSnapshotRequests += 1;
      requestOrder.push(`snapshot:${queue}:${csrf}`);
      return new Response(
        JSON.stringify({
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
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
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
    Object.keys(installedGlobals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    )
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
    const { useIngestionQueueActions } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts");
    const uploadServer = {
      status: "ready",
      actionScope: "U".repeat(32),
      actionWatermark: "expired-upload-watermark",
      connectionGeneration: 1,
      refresh: () => {
        ordinaryRefreshes += 1;
      },
      recoverAuthority: async () => {
        const snapshot = await getIngestionQueueSnapshot(
          {
            queue: "upload",
            offset: 0,
            limit: 20,
            exclude_items: [],
            include_items: []
          },
          uploadServer.actionScope
        );
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
    assert.deepEqual(requestOrder, ["action:expired-csrf", "auth", "snapshot:upload:current-csrf"]);
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
  let completedActionResponseHandler:
    ((body: Record<string, unknown>) => Response | Promise<Response>) | null = null;
  const projectedCompletedCleanupImageIds: string[] = [];
  const locallyCommittedJobs: string[] = [];
  const clearedJobIds: string[] = [];
  const fetchStub = async (input: unknown, init: RequestInit = {}) => {
    const path = new URL(
      typeof input === "string" ? input : (input as Request).url,
      "http://localhost"
    ).pathname;
    assert.equal(path, ingestionActionPath);
    const actionBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    actionBodies.push(actionBody);
    const responseGate = nextActionResponseGate;
    if (responseGate) {
      nextActionResponseGate = null;
      await responseGate;
    }
    if (actionFailureMode) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "temporary_failure", message: "temporary failure" }
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" }
        }
      );
    }
    if (actionBody.action === "clear_completed" && completedActionResponseHandler)
      return completedActionResponseHandler(actionBody);
    return new Response(
      JSON.stringify({
        ok: true,
        processed: 0,
        changed: 0,
        failed: 0,
        items: []
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
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
    Object.keys(installedGlobals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
    )
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
    const { useIngestionQueueActions } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueueActions.ts");
    const { useIngestionQueueWorkflowActions } =
      await import("../../../../packages/web/src/pages/admin/ingestion/workflow/useIngestionQueueWorkflowActions.ts");
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
      refresh: () => {
        refreshes += 1;
      }
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
          captureBrowserActionJobs: (predicate: (job: IngestionJob) => boolean) =>
            jobsRef.current.filter(predicate),
          clearJobIds: (ids: ReadonlySet<string>) => {
            clearedJobIds.push(...ids);
            jobsRef.current = jobsRef.current.filter((job) => !ids.has(job.id));
          },
          releaseResolvedServerJobs: () => new Set<string>(),
          projectCompletedCleanupBatch: (result: IngestionQueueActionResultDto) => {
            const successful = result.items.filter(
              (item) => item.status === "changed" || item.status === "unchanged"
            );
            projectedCompletedCleanupImageIds.push(...successful.map((item) => item.image_id));
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
        onDone: () => {
          doneSignals += 1;
        }
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
    jobsRef.current = [
      {
        ...localJob,
        id: "local-ready-without-watermark",
        attemptKey: "local-ready-without-watermark-attempt",
        status: "ready"
      }
    ];
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
    jobsRef.current = [
      {
        ...localJob,
        id: "local-completed-at-close",
        attemptKey: "local-completed-at-close-attempt",
        status: "done"
      }
    ];
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
    completedActionResponseHandler = () =>
      new Response(
        JSON.stringify({
          ok: true,
          processed: 1,
          changed: 1,
          failed: 0,
          items: [
            {
              session_id: "D".repeat(43),
              image_id: "00000000-0000-70a1-8000-00000000008e",
              status: "changed"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
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
    jobsRef.current = [
      {
        ...localJob,
        id: "local-completed-before-action-failure",
        attemptKey: "local-completed-before-action-failure-attempt",
        status: "done"
      }
    ];
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
    assert.equal(postActionRecoveries, 1, "清理动作没有成功时不得启动成功后的收敛");
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
        attempt < 20 && (actionBodies.length < failedDeferredActionSettled + 1 || doneSignals < 3);
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
    assert.equal(doneSignals, 2, "失败前已清理的本地卡片与零变更 Server 重试不应重复发送完成通知");

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
    completedActionResponseHandler = () =>
      new Response(
        JSON.stringify({
          ok: true,
          processed: 1,
          changed: 1,
          failed: 0,
          items: [
            {
              session_id: "E".repeat(43),
              image_id: "00000000-0000-70a2-8000-00000000008e",
              status: "changed"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
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
    assert.equal(connectionHold.current, true, "动作成功后必须持有连接直至权威快照收敛");
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

    const pagedSuccessFirstImageId = "00000000-0000-70b1-8000-00000000008e";
    const pagedSuccessSecondImageId = "00000000-0000-70b2-8000-00000000008e";
    let releasePagedSuccessSecond!: () => void;
    const pagedSuccessSecondGate = new Promise<void>((resolve) => {
      releasePagedSuccessSecond = resolve;
    });
    let pagedSuccessSecondStarted = false;
    completedActionResponseHandler = async (body) => {
      if (!body.continuation) {
        return new Response(
          JSON.stringify({
            ok: true,
            processed: 100,
            changed: 1,
            failed: 0,
            items: [
              {
                session_id: "F".repeat(43),
                image_id: pagedSuccessFirstImageId,
                status: "changed"
              }
            ],
            continuation: "completed-page-two-success"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      pagedSuccessSecondStarted = true;
      await pagedSuccessSecondGate;
      return new Response(
        JSON.stringify({
          ok: true,
          processed: 1,
          changed: 1,
          failed: 0,
          items: [
            {
              session_id: "G".repeat(43),
              image_id: pagedSuccessSecondImageId,
              status: "changed"
            }
          ]
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
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
    const pagedSuccessProjectionStart = projectedCompletedCleanupImageIds.length;
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
        attempt < 30 &&
        (connectionHold.current || postActionRecoveries === pagedSuccessRecoveryStart);
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.deepEqual(projectedCompletedCleanupImageIds.slice(pagedSuccessProjectionStart), [
      pagedSuccessFirstImageId,
      pagedSuccessSecondImageId
    ]);
    assert.equal(postActionRecoveries, pagedSuccessRecoveryStart + 1);
    assert.equal(doneSignals, pagedSuccessDoneStart + 1);
    assert.equal(connectionHold.current, false);

    const pagedFailureFirstImageId = "00000000-0000-70b3-8000-00000000008e";
    let releasePagedFailureSecond!: () => void;
    const pagedFailureSecondGate = new Promise<void>((resolve) => {
      releasePagedFailureSecond = resolve;
    });
    let pagedFailureContinuationCalls = 0;
    completedActionResponseHandler = async (body) => {
      if (!body.continuation) {
        return new Response(
          JSON.stringify({
            ok: true,
            processed: 100,
            changed: 1,
            failed: 0,
            items: [
              {
                session_id: "H".repeat(43),
                image_id: pagedFailureFirstImageId,
                status: "changed"
              }
            ],
            continuation: "completed-page-two-failure"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      pagedFailureContinuationCalls += 1;
      await pagedFailureSecondGate;
      return new Response(
        JSON.stringify({
          ok: false,
          error: {
            code: "temporary_failure",
            message: "controlled second page failure"
          }
        }),
        {
          status: 503,
          headers: { "content-type": "application/json" }
        }
      );
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
    const pagedFailureProjectionStart = projectedCompletedCleanupImageIds.length;
    const pagedFailureRecoveryStart = postActionRecoveries;
    const pagedFailureRefreshStart = refreshes;
    const pagedFailureDoneStart = doneSignals;
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      for (let attempt = 0; attempt < 20 && pagedFailureContinuationCalls === 0; attempt += 1)
        await new Promise((resolve) => setTimeout(resolve, 0));
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
        attempt < 30 && (connectionHold.current || pagedFailureContinuationCalls < 2);
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 0));
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

    const pagedAuthFirstImageId = "00000000-0000-70b4-8000-00000000008e";
    let pagedAuthContinuationCalls = 0;
    completedActionResponseHandler = (body) => {
      if (!body.continuation) {
        return new Response(
          JSON.stringify({
            ok: true,
            processed: 100,
            changed: 1,
            failed: 0,
            items: [
              {
                session_id: "J".repeat(43),
                image_id: pagedAuthFirstImageId,
                status: "changed"
              }
            ],
            continuation: "completed-page-two-invalid-token"
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      pagedAuthContinuationCalls += 1;
      return new Response(
        JSON.stringify({
          ok: false,
          code: "invalid_ingestion_token",
          error: "内容接入凭证已过期或时间无效"
        }),
        {
          status: 401,
          headers: { "content-type": "application/json" }
        }
      );
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
    const pagedAuthProjectionStart = projectedCompletedCleanupImageIds.length;
    const pagedAuthRecoveryStart = postActionRecoveries;
    const pagedAuthRefreshStart = refreshes;
    const pagedAuthSessionStart = authRecoveries;
    const pagedAuthDoneStart = doneSignals;
    await React.act(async () => {
      workflow!.runCleanupAction("completed");
      for (
        let attempt = 0;
        attempt < 30 && (connectionHold.current || authRecoveries === pagedAuthSessionStart);
        attempt += 1
      )
        await new Promise((resolve) => setTimeout(resolve, 0));
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
