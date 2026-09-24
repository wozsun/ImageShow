import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  ingestionDuplicatesPath,
  ingestionUpdatePath
} from "../../../../packages/shared/src/browser.ts";
import type { IngestionJob } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import {
  clearCsrfToken,
  setCsrfToken
} from "../../../../packages/web/src/lib/api/client.ts";
import { webUuidV7 } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-identity.ts";
import { reduceIngestionQueue } from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import {
  ingestionJob,
  adminImageListItem
} from "../../support/web-test-context.ts";

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
    setCsrfToken("duplicate-details-single-flight-token");
    const { createRoot } = await import("react-dom/client");
    const { invalidateIngestionDuplicateDetails, useIngestionDuplicateDetails } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionDuplicateDetails.ts");
    const jobsFor = (count: number) =>
      md5s.slice(0, count).map((md5, index) =>
        ingestionJob({
          id: `duplicate-details-single-flight-${index}`,
          status: "ready",
          md5,
          duplicateDecision: "undecided",
          duplicateCount: 1,
          serverVersion: index + 1,
          serverAccepted: true
        })
      );
    const libraryItems = md5s.map((md5) =>
      adminImageListItem({
        id: webUuidV7(),
        md5
      })
    );
    const responseFor = (indexes: readonly number[]) =>
      new Response(
        JSON.stringify({
          ok: true,
          items: indexes.map((index) => ({
            md5: md5s[index]!,
            match_count: 1,
            duplicates: [libraryItems[index]!]
          }))
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" }
        }
      );
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
    return new Response(
      JSON.stringify({
        ok: true,
        items: [
          {
            md5,
            match_count: fetchCalls,
            duplicates: [completedItem]
          }
        ]
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
    setCsrfToken("duplicate-completed-invalidation-token");
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { useIngestionQueue } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionQueue.ts");
    const { useIngestionDuplicateDetails } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionDuplicateDetails.ts");
    const jobs = [
      ingestionJob({
        id: "duplicate-completed-invalidation",
        status: "ready",
        md5,
        duplicateDecision: "undecided",
        duplicateCount: 1,
        duplicates: [completedItem],
        serverVersion: 3,
        serverAccepted: true
      })
    ];
    let observeCompleted: (() => void) | undefined;
    function Probe() {
      const queue = useIngestionQueue(20, "upload", false);
      observeCompleted = () =>
        queue.observeCompletedIngestions([
          {
            pair: {
              session_id: "D".repeat(43),
              image_id: completedItem.id
            },
            item: completedItem
          }
        ]);
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
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(Probe)
        )
      );
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
    return new Response(
      JSON.stringify({
        ok: true,
        items: [{ md5, match_count: 0, duplicates: [] }]
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
    setCsrfToken("duplicate-zero-cas-token");
    const { createRoot } = await import("react-dom/client");
    const { useIngestionDuplicateDetails } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionDuplicateDetails.ts");
    const duplicate = adminImageListItem({ id: webUuidV7(), md5 });
    const jobs = [
      ingestionJob({
        id: "duplicate-zero-cas",
        status: "ready",
        md5,
        duplicateDecision: "undecided",
        duplicateCount: 1,
        duplicates: [duplicate],
        serverVersion: 3,
        serverAccepted: true
      })
    ];
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
  const oldImageId = "00000000-0000-7036-8000-00000000008e";
  let resolveUpdate: ((response: Response) => void) | undefined;
  let updateCalls = 0;
  const requiredRevisions: number[] = [];
  const fetchStub = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ) => {
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
    setCsrfToken("duplicate-incarnation-token");
    const { createRoot } = await import("react-dom/client");
    const { useStoredIngestionDraftSync } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts");
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
      imageId: "00000000-0000-7037-8000-00000000008e",
      serverVersion: 1,
      duplicateDecision: "undecided",
      duplicateCount: 4
    });
    jobsRef.current = [newJob];
    state = { jobs: jobsRef.current, page: 1 };
    await React.act(async () => {
      resolveUpdate!(
        new Response(
          JSON.stringify({
            ok: true,
            items: [
              {
                session_id: oldSessionId,
                image_id: oldImageId,
                status: "changed",
                version: 2,
                last_semantic_revision: 2,
                duplicate_count: 0,
                duplicate_decision: "confirmed"
              }
            ]
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        )
      );
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
    const { useIngestionCommit } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionCommit.ts");

    const uploadJob = ingestionJob({
      id: "upload-duplicate-single-flight",
      sessionId: "G".repeat(43),
      imageId: "00000000-0000-7041-8000-00000000008e",
      serverAccepted: true,
      serverVersion: 1,
      status: "ready",
      duplicateDecision: "undecided",
      duplicateCount: 1
    });
    const importOwnerJob = ingestionJob({
      id: "import-duplicate-independent",
      sessionId: "I".repeat(43),
      imageId: "00000000-0000-7042-8000-00000000008e",
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
              uploadJobsRef.current = [
                {
                  ...uploadJobsRef.current[0]!,
                  duplicateDecision: "confirmed"
                }
              ];
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
          ingestionJobsRef.current = [
            {
              ...ingestionJobsRef.current[0]!,
              duplicateDecision: "confirmed"
            }
          ];
          return true;
        },
        flushPendingUpdates: async () => undefined,
        observeCompletedIngestions: () => undefined,
        onDone: () => undefined
      });
      return React.createElement(
        "output",
        null,
        JSON.stringify({
          uploadBusy: uploadCommit.busy,
          importBusy: importCommit.busy
        })
      );
    }
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Probe));
      await Promise.resolve();
    });
    const view = () =>
      JSON.parse(container.textContent || "{}") as {
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
    const { useIngestionCommit } =
      await import("../../../../packages/web/src/pages/admin/ingestion/queue/useIngestionCommit.ts");
    const oldAttempt = ingestionJob({
      id: "reused-job-id",
      attemptKey: "old-attempt",
      status: "ready",
      serverAccepted: true,
      serverVersion: 1,
      sessionId: "O".repeat(43),
      imageId: "00000000-0000-7043-8000-00000000008e"
    });
    const newAttempt = ingestionJob({
      ...oldAttempt,
      attemptKey: "new-attempt",
      sessionId: "N".repeat(43),
      imageId: "00000000-0000-7044-8000-00000000008e"
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
