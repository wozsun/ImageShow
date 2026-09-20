import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  ingestionStatusPath,
  ingestionUpdatePath
} from "../../../../packages/shared/src/browser.ts";
import type {
  IngestionJob
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import {
  reduceIngestionQueue
} from "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts";
import {
  ingestionJob,
  adminImageListItem
} from "../../support/web-test-context.ts";
import {
  dispatchDomEvent,
  inputText
} from "../../support/dom-events.ts";
import {
  installControlledClock
} from "../../support/controlled-clock.ts";

test("[Web/内容接入] ready 草稿空主题规范化、串行写回并以语义 no-op 收敛响应丢失", async () => {
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
      "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts"
    );
    const { useStoredIngestionDraftSync } = await import(
      "../../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const sessionId = "D".repeat(43);
    const imageId = "00000000-0000-7004-8000-00000000008e";
    let state = {
      page: 1,
      jobs: [ingestionJob({
        kind: "import",
        manifestSource: "weibo",
        draft: { ...ingestionJob().draft, theme: "default-theme" },
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
      sync!.updateJobDraft("job-1", { title: "响应丢失仍保留", theme: "" });
      await sync!.flushPendingUpdates();
    });
    assert.equal(fetchCalls, 2);
    assert.deepEqual(requests[0], requests[1], "响应丢失必须重放同一草稿写入");
    assert.equal(((requests[0]!.items as Array<{ metadata: { theme: unknown } }>)[0]!).metadata.theme, null);
    assert.equal(jobsRef.current[0]?.draft.theme, null, "清空自动带入的主题必须以 null 同步并保留在本地草稿");
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
      "../../../../packages/web/src/pages/admin/ingestion/queue/cards/IngestionJobCard.tsx"
    );
    const initialJob = ingestionJob({
      id: "deferred-card",
      attemptKey: "deferred-attempt",
      status: "ready",
      serverAccepted: true,
      serverVersion: 1,
      sessionId: "T".repeat(43),
      imageId: "00000000-0000-7004-8000-00000000008e"
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
        imageId: "00000000-0000-7004-8000-000000000099",
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
      "../../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-queue-state.ts"
    );
    const { useStoredIngestionDraftSync } = await import(
      "../../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const { IngestionJobCard } = await import(
      "../../../../packages/web/src/pages/admin/ingestion/queue/cards/IngestionJobCard.tsx"
    );
    const job = ingestionJob({
      status: "ready",
      serverAccepted: true,
      serverAcceptedOrder: 1,
      serverVersion: 1,
      sessionId: "R".repeat(43),
      imageId: "00000000-0000-7004-8000-00000000008e"
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
      "../../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
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
      "../../../../packages/web/src/pages/admin/ingestion/queue/useStoredIngestionDraftSync.ts"
    );
    const sessionId = "O".repeat(43);
    const imageId = "00000000-0000-7040-8000-00000000008e";
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
