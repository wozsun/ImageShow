import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";

test("[Web/后台访问] ready cache 检查面板区分当前数量与完整重建进度时间", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { ReadyImageCachePanel } =
    await import("../../../../packages/web/src/pages/admin/check/ReadyImageCachePanel.tsx");
  const { readyImageProjectionUsage } =
    await import("../../../../packages/web/src/pages/admin/check/check-redis-inspection.ts");
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { ReadyImageCacheMaintenancePanel } =
    await import("../../../../packages/web/src/pages/admin/check/CheckMaintenanceCapability.tsx").finally(
      () => cssHooks.deregister()
    );
  const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
  Object.defineProperty(globalThis, "React", {
    configurable: true,
    writable: true,
    value: React
  });
  try {
    const projection = {
      readable: true,
      rebuilding: false,
      synchronized: true,
      state: "ready",
      reason: "ready",
      authoritative_revision: "17",
      applied_revision: "17",
      item_count: 123,
      processed: null,
      total: null,
      last_updated_at: "2026-08-11T00:00:04.000Z",
      full_rebuild_started_at: "2026-08-11T00:00:01.000Z",
      full_rebuild_completed_at: "2026-08-11T00:00:02.500Z",
      full_rebuild_duration_ms: 1_500,
      last_full_rebuild_core_memory_bytes: 4_404_019,
      last_full_rebuild_measured_at: "2026-08-11T00:00:02.400Z",
      recent_errors: {
        core: {
          category: "core" as const,
          code: "controlled_error",
          message: "受控的最近错误",
          occurred_at: "2026-08-11T00:00:03.000Z"
        },
        derived: null
      }
    };
    const query = {
      data: {
        postgresql: {
          status: "ok",
          data: {
            connection: "connected",
            version: "18",
            latency_ms: 1,
            ready_images: 123,
            total_images: 123,
            authoritative_revision: "17",
            abnormal_jobs: 0
          },
          error: null
        },
        redis: {
          status: "ok",
          data: {
            connection: "connected",
            version: "8",
            configured_db: 0,
            latency_ms: 1,
            memory: {
              scope: "redis_instance",
              used_memory_bytes: 456,
              used_memory_rss_bytes: 789,
              fragmentation_ratio: 1
            },
            image_projection: projection
          },
          error: null
        }
      },
      dataUpdatedAt: 1,
      error: null,
      isError: false,
      isFetching: false,
      isSuccess: true,
      refetch: async () => ({ isSuccess: true })
    };
    const readOnlyHtml = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        React.createElement(ReadyImageCachePanel, {
          query: query as never
        })
      )
    );
    assert.doesNotMatch(readOnlyHtml, /重建图片投影/);

    const html = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        React.createElement(ReadyImageCacheMaintenancePanel, {
          query: query as never
        })
      )
    );

    for (const visible of [
      "状态",
      "图片数量",
      "123",
      "最后更新时间",
      "完整重建开始时间",
      "完整重建完成时间",
      "完整重建耗时",
      "1.5 秒",
      "数据库 revision 指纹",
      "Redis revision 指纹",
      "核心投影",
      "123 个图片成员",
      "4.2 MB",
      "派生缓存",
      "受控的最近错误",
      "重建图片投影"
    ]) {
      assert.match(html, new RegExp(visible));
    }
    assert.doesNotMatch(html, /完整重建进度/);
    assert.doesNotMatch(html, /123\s*\/\s*123/);
    assert.match(html, /最近完整重建快照/);
    assert.match(html, /完成 Redis 检测后显示当前派生缓存占用/);

    const detectingHtml = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        React.createElement(ReadyImageCachePanel, {
          query: query as never,
          projectionUsageNotice: "正在后台自动检测当前 Redis 占用。"
        })
      )
    );
    assert.match(detectingHtml, /正在后台自动检测当前 Redis 占用/);
    assert.match(detectingHtml, /aria-busy="true"/);

    const deepHtml = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        React.createElement(ReadyImageCachePanel, {
          query: query as never,
          projectionUsage: {
            measured_at: "2026-08-11T00:00:05.000Z",
            core: {
              key_count: 8,
              memory_bytes: 8_192
            },
            derived: {
              key_count: 3,
              member_count: 41,
              memory_bytes: 2_048
            }
          }
        })
      )
    );
    assert.match(deepHtml, /8 个键/);
    assert.match(deepHtml, /123 个图片成员/);
    assert.doesNotMatch(deepHtml, /456 个图片/);
    assert.match(deepHtml, /8.0 KB/);
    assert.match(deepHtml, /3 个键/);
    assert.match(deepHtml, /41 个结果成员/);
    assert.match(deepHtml, /2.0 KB/);
    assert.match(deepHtml, /最近一次完整 Redis 深检快照/);

    const deepResult = {
      ok: true,
      deep_inspection: {
        complete: true,
        source: "deep",
        measured_at: "2026-08-11T00:00:05.000Z",
        image_projection_usage: {
          core: {
            key_count: 8,
            member_count: 456,
            memory_bytes: 8_192
          },
          derived: {
            key_count: 3,
            member_count: 41,
            memory_bytes: 2_048
          }
        }
      }
    };
    assert.deepEqual(readyImageProjectionUsage(deepResult, "redis"), {
      measured_at: "2026-08-11T00:00:05.000Z",
      core: { key_count: 8, memory_bytes: 8_192 },
      derived: { key_count: 3, member_count: 41, memory_bytes: 2_048 }
    });
    assert.deepEqual(
      readyImageProjectionUsage(
        {
          redis: { status: "ok", data: deepResult }
        },
        "all"
      ),
      readyImageProjectionUsage(deepResult, "redis")
    );
    assert.equal(
      readyImageProjectionUsage(
        {
          ...deepResult,
          deep_inspection: {
            ...deepResult.deep_inspection,
            complete: false
          }
        },
        "redis"
      ),
      null
    );

    const rebuildingProjection = {
      ...projection,
      readable: false,
      rebuilding: true,
      synchronized: false,
      state: "rebuilding",
      reason: "rebuilding",
      item_count: 41,
      processed: 41,
      total: 123,
      full_rebuild_completed_at: null,
      full_rebuild_duration_ms: null
    };
    const rebuildingHtml = renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        React.createElement(ReadyImageCachePanel, {
          query: {
            ...query,
            data: {
              ...query.data,
              redis: {
                ...query.data.redis,
                data: {
                  ...query.data.redis.data,
                  image_projection: rebuildingProjection
                }
              }
            }
          } as never
        })
      )
    );
    assert.match(rebuildingHtml, /完整重建进度/);
    assert.match(rebuildingHtml, /41\s*\/\s*123/);
  } finally {
    if (previousReact) {
      Object.defineProperty(globalThis, "React", previousReact);
    } else {
      delete (globalThis as Record<string, unknown>).React;
    }
  }
});
test("[Web/后台访问] 自动 Redis 占用检测在 Strict Mode 单飞并在重新进入时重测", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { useAdminRedisInspection } =
    await import("../../../../packages/web/src/pages/admin/check/check-redis-inspection.ts");
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  let fetchCount = 0;
  let resolveFirstFetch!: (response: Response) => void;
  const firstFetch = new Promise<Response>((resolve) => {
    resolveFirstFetch = resolve;
  });
  const responseBody = JSON.stringify({
    ok: true,
    deep_inspection: {
      complete: true,
      source: "deep",
      measured_at: "2026-08-11T00:00:05.000Z",
      image_projection_usage: {
        core: { key_count: 8, member_count: 123, memory_bytes: 8_192 },
        derived: { key_count: 0, member_count: 0, memory_bytes: 0 }
      }
    }
  });
  const fetchStub = (input: RequestInfo | URL) => {
    assert.equal(String(input), "/api/admin/check/redis");
    fetchCount += 1;
    return fetchCount === 1
      ? firstFetch
      : Promise.resolve(
          new Response(responseBody, {
            status: 200,
            headers: { "content-type": "application/json" }
          })
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

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const container = document.getElementById("root");
  assert.ok(container);
  function Probe() {
    const query = useAdminRedisInspection();
    return React.createElement(
      "span",
      null,
      query.isSuccess ? "complete" : "pending"
    );
  }
  const renderProbe = () =>
    React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Probe)
      )
    );
  const settleUntil = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      if (predicate()) return;
    }
    assert.fail("Redis inspection query did not settle");
  };

  try {
    const firstRoot = createRoot(container);
    await React.act(async () => {
      firstRoot.render(renderProbe());
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(fetchCount, 1);

    await React.act(async () => {
      resolveFirstFetch(
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/json" }
        })
      );
    });
    await settleUntil(() => container.textContent === "complete");
    assert.equal(container.textContent, "complete");
    assert.equal(fetchCount, 1);
    await React.act(async () => firstRoot.unmount());

    const secondRoot = createRoot(container);
    await React.act(async () => {
      secondRoot.render(renderProbe());
    });
    await settleUntil(() => container.textContent === "complete" && fetchCount === 2);
    assert.equal(container.textContent, "complete");
    assert.equal(fetchCount, 2);
    await React.act(async () => secondRoot.unmount());
  } finally {
    client.clear();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/后台访问] 存储维护直接合并存储对象与持久彻底删除任务预览", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("https://imageshow.test/admin/check")
  });
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number,
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    scrollTo() {},
    innerWidth: 1280,
    innerHeight: 720
  });
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const getClientRectsDescriptor = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "getClientRects"
  );
  Object.defineProperty(window.HTMLElement.prototype, "getClientRects", {
    configurable: true,
    value: () => []
  });
  const storageResult = {
    ok: true,
    missing_objects: [],
    missing_thumbs: [],
    pending_thumbnail_repairs: [],
    orphan_objects: [],
    orphan_thumbs: [],
    stale_ingestion_raw_files: { count: 0, oldest_modified_at: null },
    stale_ingestion_part_files: { count: 0, oldest_modified_at: null },
    stale_ingestion_prepared_files: { count: 0, oldest_modified_at: null },
    ingestion_temp_space: { total_bytes: 0, retained_bytes: 0, complete: true },
    incomplete_ingestion_temp_scan: [],
    incomplete_listings: [],
    unavailable_backends: []
  };
  const trashResult = {
    ok: true,
    deleted_count: 5,
    unqueued_count: 2,
    purge_pending_count: 3,
    job_counts: { pending: 0, running: 1, retrying: 0, exhausted: 2 },
    jobs: [],
    issues: [
      {
        kind: "succeeded_target_remaining",
        count: 2,
        sample_ids: []
      },
      {
        kind: "stalled_job",
        count: 1,
        sample_ids: []
      }
    ],
    candidates: []
  };
  let trashResponse: unknown = trashResult;
  const requestPaths: string[] = [];
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
    fetch: async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/logs/client-errors")) {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      requestPaths.push(path);
      const data = path.endsWith("/check/storage")
        ? storageResult
        : path.endsWith("/check/trash")
          ? trashResponse
          : null;
      assert.ok(data, `unexpected request: ${path}`);
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
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
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { CheckStorageMaintenanceActions } =
    await import("../../../../packages/web/src/pages/admin/check/CheckMaintenanceCapability.tsx").finally(
      () => cssHooks.deregister()
    );
  const checkNames: string[] = [];
  const published: unknown[] = [];
  let showStorageCount = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const click = async (target: HTMLElement) => {
    await React.act(async () => {
      target.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await settle();
    });
  };

  try {
    await React.act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(CheckStorageMaintenanceActions, {
            canMaintainStorage: true,
            canMigrateStorage: false,
            running: "",
            onPublishResult(value: unknown) {
              published.push(value);
            },
            async onRunCheck(name: string) {
              checkNames.push(name);
              return null;
            },
            onRunningChange() {},
            onShowStorage() {
              showStorageCount += 1;
            }
          })
        )
      );
      await settle();
    });

    const topLevelButtons = [...container.querySelectorAll<HTMLButtonElement>("button")];
    const maintenanceButton = topLevelButtons.find((button) =>
      button.textContent?.includes("存储维护")
    );
    assert.ok(maintenanceButton);
    await click(maintenanceButton);
    assert.deepEqual(
      requestPaths.toSorted(),
      [
        "/api/admin/check/storage",
        "/api/admin/check/trash"
      ].toSorted()
    );
    assert.deepEqual(checkNames, []);
    assert.equal(showStorageCount, 1);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0], {
      storage: storageResult,
      trash: trashResult
    });
    assert.equal(document.querySelector('[role="menu"]'), null);
    const maintenanceDialog = document.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="存储维护"]'
    );
    assert.ok(maintenanceDialog);
    assert.match(document.body.textContent ?? "", /持久彻底删除任务/);
    assert.match(document.body.textContent ?? "", /将重试耗尽任务2/);
    assert.match(document.body.textContent ?? "", /将重试异常成功任务2/);
    assert.match(document.body.textContent ?? "", /停滞任务只报告/);

    const cancelButton = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')
    ].find((button) => button.textContent?.trim() === "取消");
    assert.ok(cancelButton);
    await click(cancelButton);
    await React.act(async () => {
      maintenanceDialog.dispatchEvent(
        new window.Event("animationend", {
          bubbles: true
        })
      );
      await settle();
    });
    assert.equal(document.querySelector('[role="dialog"]') === null, true);

    trashResponse = { ...trashResult, job_counts: undefined };
    await click(maintenanceButton);
    assert.equal(
      document.querySelector('[role="dialog"]') === null,
      true,
      "缺失任务计数的响应必须走预览失败分支，而不是在渲染时崩溃"
    );
    assert.deepEqual(published.at(-1), {
      ok: false,
      error: "存储维护预览失败，请稍后重试"
    });
  } finally {
    await React.act(async () => root.unmount());
    await React.act(async () => settle());
    client.clear();
    if (getClientRectsDescriptor) {
      Object.defineProperty(
        window.HTMLElement.prototype,
        "getClientRects",
        getClientRectsDescriptor
      );
    } else {
      delete (window.HTMLElement.prototype as unknown as Record<string, unknown>).getClientRects;
    }
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/后台访问] 检查页保留完整 Redis 快照并串行化自动检测与全部检查", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { MemoryRouter } = await import("react-router");
  const { AuthSessionProvider } =
    await import("../../../../packages/web/src/hooks/useAuthSession.tsx");
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { CheckPage } =
    await import("../../../../packages/web/src/pages/admin/check/CheckPage.tsx").finally(() =>
      cssHooks.deregister()
    );
  const { document, window } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>'
  );

  const projection = (rebuilding = false) => ({
    readable: !rebuilding,
    rebuilding,
    synchronized: rebuilding ? false : true,
    state: rebuilding ? "rebuilding" : "ready",
    reason: rebuilding ? "rebuilding" : "ready",
    authoritative_revision: "17",
    applied_revision: rebuilding ? "16" : "17",
    item_count: 124,
    processed: rebuilding ? 62 : null,
    total: rebuilding ? 124 : null,
    last_updated_at: "2026-08-11T00:00:04.000Z",
    full_rebuild_started_at: "2026-08-11T00:00:01.000Z",
    full_rebuild_completed_at: rebuilding
      ? null
      : "2026-08-11T00:00:02.500Z",
    full_rebuild_duration_ms: rebuilding ? null : 1_500,
    last_full_rebuild_core_memory_bytes: 4_404_019,
    last_full_rebuild_measured_at: "2026-08-11T00:00:02.400Z",
    recent_errors: { core: null, derived: null }
  });
  const statusResult = (rebuilding = false) => ({
    postgresql: {
      status: "ok",
      data: {
        connection: "connected",
        version: "18",
        latency_ms: 1,
        ready_images: 124,
        total_images: 124,
        authoritative_revision: "17",
        abnormal_jobs: 0
      },
      error: null
    },
    redis: {
      status: "ok",
      data: {
        connection: "connected",
        version: "8",
        configured_db: 0,
        latency_ms: 1,
        memory: {
          scope: "redis_instance",
          used_memory_bytes: 456,
          used_memory_rss_bytes: 789,
          fragmentation_ratio: 1
        },
        image_projection: projection(rebuilding)
      },
      error: null
    }
  });
  const redisResult = (
    measuredAt: string,
    memoryBytes: number,
    complete = true
  ) => ({
    ok: true,
    deep_inspection: {
      complete,
      source: "deep",
      measured_at: measuredAt,
      image_projection_usage: {
        core: {
          key_count: 8,
          member_count: 124,
          memory_bytes: memoryBytes
        },
        derived: { key_count: 0, member_count: 0, memory_bytes: 0 }
      }
    }
  });
  const allResult = {
    ok: true,
    postgresql: { status: "ok", data: {} },
    redis: {
      status: "ok",
      data: redisResult("2026-08-11T00:00:07.000Z", 16_384)
    },
    storage: { status: "ok", data: {} },
    trash: { status: "ok", data: {} }
  };
  const trashResult = {
    deleted_count: 1,
    unqueued_count: 1,
    purge_pending_count: 0,
    job_counts: { pending: 0, running: 0, retrying: 0, exhausted: 0 },
    jobs: [],
    issues: [],
    candidates: [
      {
        id: "00000000-0000-7000-8000-000000000001",
        object_key: "01/00000000-0000-7000-8000-000000000001.webp",
        deleted_at: "2026-08-11T00:00:03.000Z",
        purge_pending: false
      }
    ]
  };
  let resolveStatus!: (response: Response) => void;
  let resolveAutomaticRedis!: (response: Response) => void;
  let resolvePartialRedis!: (response: Response) => void;
  let resolveAll!: (response: Response) => void;
  const statusResponse = new Promise<Response>((resolve) => {
    resolveStatus = resolve;
  });
  const automaticRedisResponse = new Promise<Response>((resolve) => {
    resolveAutomaticRedis = resolve;
  });
  const partialRedisResponse = new Promise<Response>((resolve) => {
    resolvePartialRedis = resolve;
  });
  const allResponse = new Promise<Response>((resolve) => {
    resolveAll = resolve;
  });
  let redisRequests = 0;
  let allRequests = 0;
  let trashRequests = 0;
  const jsonResponse = (value: unknown) =>
    new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  const fetchStub = (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/admin/check/status") return statusResponse;
    if (path === "/api/admin/check/redis") {
      redisRequests += 1;
      if (redisRequests === 1) return automaticRedisResponse;
      if (redisRequests === 2) return partialRedisResponse;
      throw new Error(`unexpected Redis inspection ${redisRequests}`);
    }
    if (path === "/api/admin/check/all") {
      allRequests += 1;
      return allResponse;
    }
    if (path === "/api/admin/check/trash") {
      trashRequests += 1;
      return Promise.resolve(jsonResponse(trashResult));
    }
    throw new Error(`unexpected request ${path}`);
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

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } }
  });
  client.setQueryData(["me"], {
    authenticated: true,
    username: "review",
    role: "image",
    permissions: [],
    csrf_token: "test-token",
    application_version: "current-build",
    preferences: {},
    preferences_etag: 'W/"review-preferences"',
    version_settings: {}
  });
  const container = document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const button = (label: string) => {
    const match = [...container.querySelectorAll("button")].find((candidate) =>
      candidate.textContent?.includes(label)
    );
    assert.ok(match, `missing ${label} button`);
    return match as HTMLButtonElement;
  };
  const click = async (target: HTMLButtonElement) => {
    await React.act(async () => {
      target.dispatchEvent(new window.Event("click", { bubbles: true }));
      await settle();
    });
  };

  try {
    await React.act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/admin/check"] },
            React.createElement(
              AuthSessionProvider,
              null,
              React.createElement(CheckPage)
            )
          )
        )
      );
      await settle();
    });

    assert.equal(button("全部").disabled, true);
    assert.equal(allRequests, 0);
    assert.equal(redisRequests, 0);
    assert.equal(
      [...container.querySelectorAll("button")].some((candidate) =>
        candidate.textContent?.includes("彻底删除维护")
      ),
      false,
      "图片管理员不应加载或显示超级管理员彻底删除维护入口"
    );
    await React.act(async () => {
      resolveStatus(jsonResponse(statusResult()));
      await settle();
    });
    assert.equal(redisRequests, 1);
    assert.equal(button("全部").disabled, true);

    await React.act(async () => {
      resolveAutomaticRedis(jsonResponse(redisResult(
        "2026-08-11T00:00:05.000Z",
        8_192
      )));
      await settle();
    });
    assert.equal(button("全部").disabled, false);
    assert.match(container.textContent ?? "", /8\.0 KB/);

    await click(button("Redis"));
    assert.equal(redisRequests, 2);
    assert.equal(button("全部").disabled, true);
    await React.act(async () => {
      resolvePartialRedis(jsonResponse(redisResult(
        "2026-08-11T00:00:06.000Z",
        4_096,
        false
      )));
      await settle();
    });
    await click(button("状态"));
    assert.match(container.textContent ?? "", /8\.0 KB/);
    assert.ok(
      [...container.querySelectorAll("[title]")].some(
        (element) =>
          element.getAttribute("title")?.includes("本次检测未完成") &&
          element.getAttribute("title")?.includes("最近一次完整 Redis 深检快照")
      )
    );

    await click(button("全部"));
    assert.equal(allRequests, 1);
    await React.act(async () => {
      client.setQueryData(["admin-check-status"], statusResult(true));
      await Promise.resolve();
      client.setQueryData(["admin-check-status"], statusResult(false));
      await settle();
    });
    assert.equal(redisRequests, 2);

    await React.act(async () => {
      resolveAll(jsonResponse(allResult));
      await settle();
    });
    assert.equal(redisRequests, 2);
    assert.match(container.textContent ?? "", /16\.0 KB/);

    await click(button("回收站"));
    assert.equal(trashRequests, 1);
    assert.match(container.textContent ?? "", /未排队数量/);
  } finally {
    await React.act(async () => root.unmount());
    client.clear();
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
