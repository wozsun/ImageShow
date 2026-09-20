import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  ingestionActionScopeHeader,
  ingestionCancelPath,
  ingestionSnapshotPath,
  ingestionStatusPath,
  ingestionUpdatePath,
  importAcceptPath,
  uploadCredentialHeader,
  uploadIntentPath,
  uploadRawPath
} from "../../../../packages/shared/src/browser.ts";
import type {
  IngestionJob
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import {
  clearCsrfToken,
  setCsrfToken
} from "../../../../packages/web/src/lib/api/client.ts";
import {
  webUuidV7
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-identity.ts";
import {
  reduceIngestionQueue
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import {
  cancelServerIngestionJob,
  cancelServerIngestionJobs
} from "../../../../packages/web/src/pages/admin/ingestion/queue/ingestion-cancel.ts";
import {
  acceptImports,
  createUploadIntents,
  getIngestionQueueSnapshot,
  getIngestionStatuses,
  uploadRaw
} from "../../../../packages/web/src/pages/admin/ingestion/queue/ingestion-http-client.ts";
import {
  ingestionJob,
  adminImageListItem,
  createConfigStreamHarness
} from "../../support/web-test-context.ts";

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
    "00000000-0000-7004-8000-000000000092",
    "00000000-0000-7004-8000-000000000093",
    "00000000-0000-7004-8000-000000000094"
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
      "../../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
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
          image_id: "00000000-0000-7004-8000-000000000090",
          status: "completed",
          completed_item: adminImageListItem({
            id: "00000000-0000-7004-8000-000000000090"
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
        image_id: "00000000-0000-7004-8000-00000000008f",
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
      "../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionAuthorityHandoffs.ts"
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
        imageId: "00000000-0000-7004-8000-00000000008f",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: undefined
      });
      handoffs!.prepareBinding({
        sessionId: "H".repeat(43),
        imageId: "00000000-0000-7004-8000-00000000008f",
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
        imageId: "00000000-0000-7004-8000-00000000008f",
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
        imageId: "00000000-0000-7004-8000-000000000091",
        serverAccepted: true,
        serverHandoffPending: true,
        serverHandoffRevision: 99
      }, 2);
      handoffs!.prepareBinding({
        sessionId: "I".repeat(43),
        imageId: "00000000-0000-7004-8000-000000000091",
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
          image_id: "00000000-0000-7004-8000-000000000091",
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
        imageId: "00000000-0000-7004-8000-000000000090",
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
      "00000000-0000-7004-8000-000000000090",
      "00000000-0000-7004-8000-000000000090"
    ], "权威交接每次完成态 status 都必须交给 owner 统一去重");

    server.connectionGeneration = 4;
    server.revision = 200;
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const externalPairKey = `${"K".repeat(43)}\0${
      "00000000-0000-7004-8000-000000000092"
    }`;
    await React.act(async () => {
      handoffs!.prepareBinding({
        sessionId: "K".repeat(43),
        imageId: "00000000-0000-7004-8000-000000000092",
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
  const imageId = "00000000-0000-7003-8000-00000000008e";
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
      "../../../../packages/web/src/pages/admin/ingestion/workflow/useIngestionQueueWorkflowActions.ts"
    );
    const pair = {
      session_id: "C".repeat(43),
      image_id: "00000000-0000-7021-8000-00000000008e"
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
            actionRequestId: "00000000-0000-7022-8000-00000000008e",
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
          theme: "",
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
      image_id: "00000000-0000-7023-8000-00000000008e"
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
      image_id: "00000000-0000-7024-8000-00000000008e"
    };
    const partialUnknownPair = {
      session_id: "Q".repeat(43),
      image_id: "00000000-0000-7025-8000-00000000008e"
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
      "../../../../packages/web/src/pages/admin/ingestion/import/useImport.ts"
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
        maxItems: 200,
        defaults: {
          device: "pc",
          brightness: "dark",
          theme: "",
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
      items: jobs.map((_, index) => ({
        session_id: String(index).padStart(43, "S"),
        image_id: `019f8457-063a-7${String(index).padStart(3, "0")}-a580-00000000008e`,
        resolved_image_time: "2026-08-23T01:02:03.456Z",
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
      imageId: "00000000-0000-7024-8000-00000000008e",
      serverAccepted: true,
      serverVersion: 1,
      status: "failed",
      failureStage: "prepare"
    });
    jobsRef.current = [retryJob];
    await owner!.cancel(retryJob);
    assert.equal(
      acceptRequests,
      1,
      "取消返回 completed 时不得生成新 attempt 或重新 accept"
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
test("[Web/内容接入] 解析后 202 张按上限接管，明确拒绝与未知结果均可安全清空", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { useImport } = await import("../../../../packages/web/src/pages/admin/ingestion/import/useImport.ts");
  const jobsRef = { current: [] as IngestionJob[] };
  const updateJob = (id: string, patch: Partial<IngestionJob>) => {
    jobsRef.current = jobsRef.current.map(job => job.id === id ? { ...job, ...patch } : job);
  };
  const queue = {
    jobsRef, updateJob, observeCompletedIngestions() {},
    retryPrepareJob(previous: IngestionJob, job: IngestionJob) {
      const state = { page: 1, jobs: jobsRef.current };
      const next = reduceIngestionQueue(state, { type: "retry-prepare", previous, job });
      jobsRef.current = next.jobs;
      return next !== state;
    },
    appendJobs(jobs: IngestionJob[]) { jobsRef.current.push(...jobs); return true; },
    bindServerJob: updateJob, captureServerConnectionGeneration: () => 1
  };
  let owner!: ReturnType<typeof useImport>;
  function Probe() {
    owner = useImport({ queue: queue as never, maxItems: 200,
      defaults: { device: "auto", brightness: "auto", theme: "", author: "", tags: [] },
      keepOriginalLinkForUrlImports: true, storageSlug: "local" });
    return null;
  }
  await h.render(h.React.createElement(Probe));
  const batchKey = webUuidV7();
  const makeJobs = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ingestionJob({
    id: `${prefix}-${index}`, attemptKey: webUuidV7(), batchKey, batchPosition: index,
    downloadUrl: `https://example.com/${prefix}-${index}.jpg`
  }));
  const requestBody = (index: number) => JSON.parse(String(h.pending[index].body));
  const rejection = { ok: false, code: "import_batch_limit_exceeded", error: "单批最多 200 张" };
  await owner.addParsedImports(makeJobs("split", 202));
  assert.equal(h.pending.length, 1);
  assert.equal(requestBody(0).items.length, 200);
  await h.respond(0, rejection, 400);
  assert.equal(h.pending.length, 2);
  assert.deepEqual(requestBody(1).items.map((item: any) => item.batch_position), [200, 201]);
  assert.ok(requestBody(1).items.every((item: any) => item.batch_key === batchKey));
  await h.respond(1, rejection, 400);
  assert.equal(jobsRef.current.filter(job => job.importAcceptRejected).length, 202);
  const rejectedOutcomes = await owner.cancelMany([...jobsRef.current]);
  assert.equal([...rejectedOutcomes.values()].filter(outcome => outcome.succeeded).length, 202);
  assert.equal(h.pending.length, 2, "确定未接管的首次拒绝无需再次发送接管或取消请求");

  jobsRef.current = [];
  await owner.addParsedImports(makeJobs("pending", 202));
  const clearing = owner.cancelMany([...jobsRef.current]);
  assert.equal(jobsRef.current.filter(job => job.status === "cancelled").length, 2);
  await h.respond(2, rejection, 400);
  assert.equal([...((await clearing).values())].filter(outcome => outcome.succeeded).length, 202);
  assert.equal(h.pending.length, 3, "清空等待中的批次时，后续未发送的分片不得再启动");

  jobsRef.current = [];
  await owner.addParsedImports(makeJobs("unknown", 1));
  const frozenInput = requestBody(3).items[0];
  await h.respond(3, { ok: false, error: "response lost" }, 502);
  assert.equal(jobsRef.current[0].importAcceptRejected, false);
  // A later definite rejection cannot disprove an earlier unknown acceptance.
  const retryingUnknown = owner.retryMany([jobsRef.current[0]]);
  await h.respond(4, rejection, 400);
  await retryingUnknown;
  assert.equal(jobsRef.current[0].importAcceptRejected, false);
  const unknownCancellation = owner.cancelMany([...jobsRef.current]);
  assert.equal(h.pending.length, 6);
  assert.deepEqual(requestBody(5), { items: [frozenInput], cancel_if_missing: true });
  await h.respond(5, { ok: true, items: [{
    status: "discarded", session_id: "D".repeat(43), image_id: webUuidV7(),
    resolved_image_time: "2026-09-13T00:00:00.000Z", accepted_order: 1
  }] });
  assert.equal([...(await unknownCancellation).values()][0].succeeded, true);
  assert.equal(jobsRef.current[0].status, "cancelled");
});

test("[Web/内容接入] Upload 与 Import 接管只使用固定短路由和 1 + N 请求预算", async () => {
  const originalFetch = globalThis.fetch;
  const originalXhr = globalThis.XMLHttpRequest;
  const fetchCalls: Array<{ path: string; init: RequestInit }> = [];
  const sessionIds = ["A".repeat(43), "B".repeat(43)];
  const imageIds = [
    "00000000-0000-7001-8000-00000000008e",
    "00000000-0000-7002-8000-00000000008e"
  ];
  const metadata = {
    device: "auto" as const,
    brightness: "auto" as const,
    theme: null,
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
          credential: `credential-${index}`,
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
