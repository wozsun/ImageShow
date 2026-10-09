import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import {
  adminPermissions,
  type AdminPreferences,
  type AdminImageListItemDto
} from "../../../../packages/shared/src/browser.ts";

import {
  ApiClientError,
  api,
  apiWithEtag,
  clearCsrfToken
} from "../../../../packages/web/src/lib/api/client.ts";
import { invalidateImageDataAfterMetadataSave } from "../../../../packages/web/src/lib/api/query-invalidation.ts";
import { queryKeys } from "../../../../packages/web/src/lib/api/query-keys.ts";

import { createPageLifetimeModuleLoader } from "../../../../packages/web/src/lib/page-lifetime-module-loader.ts";
import { createPublicRouteModuleLoader } from "../../../../packages/web/src/lib/public-route-modules.ts";
import { preloadIntentProps } from "../../../../packages/web/src/lib/ui/preload-intent.ts";

import { useImageAdminPageNavigation } from "../../../../packages/web/src/pages/admin/images/useImageAdminPageNavigation.ts";
import {
  adminImageListQuery,
  effectiveImageAdminPage,
  imageAdminPaginationScopeKey,
  imageAdminTotalPages,
  resolveImageAdminScopeTotal
} from "../../../../packages/web/src/pages/admin/images/image-admin-list-query.ts";
import { emptyImageAdminFilters } from "../../../../packages/web/src/pages/admin/images/ImageAdminFilters.tsx";
import { editableImage, galleryCard } from "../../support/web-test-context.ts";
import { inputText } from "../../support/dom-events.ts";

import { installControlledClock } from "../../support/controlled-clock.ts";

test("[Web/后台] API 拒绝损坏成功响应且保留已有查询快照和安全 HTTP 错误", async () => {
  const { QueryClient } = await import("@tanstack/react-query");
  const originalFetch = globalThis.fetch;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    for (const body of ["<html>proxy-private-body</html>", '{"site":', "", "   "]) {
      globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
      const assertSafeError = (error: unknown) => {
        assert.ok(error instanceof ApiClientError);
        assert.equal(error.status, 200);
        assert.equal(error.code, "invalid_json_response");
        assert.equal(error.message, "服务器响应不是有效的 JSON");
        assert.deepEqual(error.details, {});
        return true;
      };
      await assert.rejects(
        client.fetchQuery({
          queryKey: queryKeys.siteConfig,
          queryFn: () => api("/api/site-config")
        }),
        assertSafeError
      );
      assert.equal(client.getQueryData(queryKeys.siteConfig), undefined);
      assert.equal(client.getQueryState(queryKeys.siteConfig)?.status, "error");
      await assert.rejects(apiWithEtag("/api/site-config"), assertSafeError);
    }
    const prior = { site: { title: "可用快照" } };
    client.setQueryData(queryKeys.siteConfig, prior, { updatedAt: 123 });
    await assert.rejects(
      client.fetchQuery({
        queryKey: queryKeys.siteConfig,
        queryFn: () => api("/api/site-config"),
        staleTime: 0
      })
    );
    assert.strictEqual(client.getQueryData(queryKeys.siteConfig), prior);
    assert.equal(client.getQueryState(queryKeys.siteConfig)?.dataUpdatedAt, 123);
    for (const value of [{ ok: true, items: [] }, [1, 2], null]) {
      globalThis.fetch = (async () => Response.json(value)) as typeof fetch;
      assert.deepEqual(await api("/api/site-config"), value);
    }
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    assert.deepEqual(await api("/api/images", { method: "OPTIONS" }), {});
    globalThis.fetch = (async () =>
      new Response("<html>private proxy error</html>", { status: 502 })) as typeof fetch;
    await assert.rejects(api("/api/site-config"), (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.message, "HTTP 502");
      assert.equal(error.status, 502);
      assert.deepEqual(error.details, {});
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
    client.clear();
  }
});
test("[Web/后台] 条件读取只让 304 复用旧 ETag，新的 200 表示必须自带验证器", async () => {
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  const validators: Array<string | null> = [];
  let request = 0;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async (_input: unknown, init: RequestInit = {}) => {
      validators.push(new Headers(init.headers).get("if-none-match"));
      request += 1;
      if (request === 1) {
        return new Response(JSON.stringify({ ok: true, value: "new" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(null, { status: 304 });
    }
  });
  try {
    const replaced = await apiWithEtag<{ ok: true; value: string }>(
      "/api/admin/etag-contract",
      {},
      { etag: 'W/"old"', data: { ok: true, value: "old" } }
    );
    assert.deepEqual(replaced, {
      data: { ok: true, value: "new" },
      etag: ""
    });
    const unchanged = await apiWithEtag<{ ok: true; value: string }>(
      "/api/admin/etag-contract",
      {},
      { etag: 'W/"current"', data: { ok: true, value: "cached" } }
    );
    assert.deepEqual(unchanged, {
      data: { ok: true, value: "cached" },
      etag: 'W/"current"'
    });
    assert.deepEqual(validators, ['W/"old"', 'W/"current"']);
  } finally {
    if (previousFetch) {
      Object.defineProperty(globalThis, "fetch", previousFetch);
    } else {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  }
});
test("[Web/后台] 后台模块预加载只响应可执行意图并复用页面生命周期请求", async () => {
  let immediatePreloads = 0;
  const immediateBindings = preloadIntentProps(() => {
    immediatePreloads += 1;
  });
  immediateBindings.onPointerEnter?.();
  immediateBindings.onFocus?.();
  immediateBindings.onPointerDown?.();
  assert.equal(immediatePreloads, 3);

  let importCount = 0;
  let finishImport!: (value: { page: string }) => void;
  const pendingImport = new Promise<{ page: string }>((resolve) => {
    finishImport = resolve;
  });
  const loadModule = createPageLifetimeModuleLoader(() => {
    importCount += 1;
    return pendingImport;
  });
  const firstLoad = loadModule();
  const navigationLoad = loadModule();
  assert.strictEqual(navigationLoad, firstLoad);
  assert.equal(importCount, 1);
  finishImport({ page: "site" });
  assert.deepEqual(await firstLoad, { page: "site" });
  assert.strictEqual(loadModule(), firstLoad);

  let retryImportCount = 0;
  const attempts: Array<{
    resolve: (value: { page: string }) => void;
    reject: (error: Error) => void;
  }> = [];
  const routeWindowDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "window"
  );
  let pendingFailureReloads = 0;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        reload: () => {
          pendingFailureReloads += 1;
        }
      }
    }
  });
  try {
    const retryableLoader = createPublicRouteModuleLoader(() => {
      retryImportCount += 1;
      return new Promise<{ page: string }>((resolve, reject) => {
        attempts.push({ resolve, reject });
      });
    });
    retryableLoader.preload();
    retryableLoader.preload();
    void retryableLoader.load();
    assert.equal(retryImportCount, 1);
    attempts[0]!.reject(new Error("passive preload failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(retryableLoader.passivePreloadFailed(), true);
    assert.equal(retryImportCount, 1, "失败模块不能在当前文档重试");
    assert.equal(pendingFailureReloads, 1);
  } finally {
    if (routeWindowDescriptor) {
      Object.defineProperty(globalThis, "window", routeWindowDescriptor);
    }
  }

  let documentReloads = 0;
  let rejectCompletedPreload!: (error: Error) => void;
  let completedPreloadImports = 0;
  const completedFailureLoader = createPublicRouteModuleLoader(() => {
    completedPreloadImports += 1;
    return new Promise<{ page: string }>((_resolve, reject) => {
      rejectCompletedPreload = reject;
    });
  });
  const previousWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window"
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: {
      location: {
        reload: () => {
          documentReloads += 1;
        }
      }
    }
  });
  try {
    completedFailureLoader.preload();
    rejectCompletedPreload(new Error("completed passive preload failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const recovery = completedFailureLoader.load();
    assert.ok(recovery instanceof Promise);
    assert.equal(documentReloads, 1);
    assert.equal(
      completedPreloadImports,
      1,
      "已缓存失败不能在当前文档重试同一原生模块"
    );
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      delete (globalThis as Record<string, unknown>).window;
    }
  }
});

test("[Web/后台] 后台图片数字页由单一目标查询直达并隔离分页 scope", async (t) => {
  const filters = {
    ...emptyImageAdminFilters,
    device: "pc",
    brightness: "dark",
    theme: "night",
    tag: "blue",
    author: "alice"
  };
  const scope = imageAdminPaginationScopeKey("ready", filters, 60);
  const pageSizeScope = imageAdminPaginationScopeKey("ready", filters, 30);
  const deletedScope = imageAdminPaginationScopeKey("deleted", filters, 60);
  assert.notEqual(scope, pageSizeScope);
  assert.notEqual(scope, deletedScope);
  assert.equal(
    effectiveImageAdminPage(
      {
        scopeKey: scope,
        page: 100,
        total: 6_000,
        totalUpdatedAt: 1
      },
      scope
    ),
    100
  );
  assert.equal(
    effectiveImageAdminPage(
      {
        scopeKey: scope,
        page: 100,
        total: 6_000,
        totalUpdatedAt: 1
      },
      deletedScope
    ),
    1
  );
  assert.equal(imageAdminTotalPages(0, 60), 1);
  assert.equal(imageAdminTotalPages(6_000, 60), 100);
  for (const scenario of [
    {
      name: "无快照或数据时从零开始",
      input: {
        retainedTotal: null,
        retainedUpdatedAt: 0,
        queryData: undefined,
        queryUpdatedAt: 0,
        fetchedAfterMount: false,
        isSuccess: false
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: null,
        total: 0
      }
    },
    {
      name: "同时间戳旧热缓存不得覆盖快照",
      input: {
        retainedTotal: 6_000,
        retainedUpdatedAt: 100,
        queryData: { total: 3_000 },
        queryUpdatedAt: 100,
        fetchedAfterMount: false,
        isSuccess: true
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: null,
        total: 6_000
      }
    },
    {
      name: "更新时间较新的缓存可以覆盖快照",
      input: {
        retainedTotal: 6_000,
        retainedUpdatedAt: 100,
        queryData: { total: 7_200 },
        queryUpdatedAt: 101,
        fetchedAfterMount: false,
        isSuccess: true
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: 7_200,
        total: 7_200
      }
    },
    {
      name: "挂载后成功结果可以在相同时间戳胜出",
      input: {
        retainedTotal: 6_000,
        retainedUpdatedAt: 100,
        queryData: { total: 7_200 },
        queryUpdatedAt: 100,
        fetchedAfterMount: true,
        isSuccess: true
      },
      expected: {
        currentQueryHasObservedSuccessfulData: true,
        queryTotal: 7_200,
        total: 7_200
      }
    },
    {
      name: "失败重试保留相同时间戳快照",
      input: {
        retainedTotal: 6_000,
        retainedUpdatedAt: 100,
        queryData: { total: 3_000 },
        queryUpdatedAt: 100,
        fetchedAfterMount: true,
        isSuccess: false
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: null,
        total: 6_000
      }
    },
    {
      name: "首份可用缓存建立 scope 快照",
      input: {
        retainedTotal: null,
        retainedUpdatedAt: 0,
        queryData: { total: 180 },
        queryUpdatedAt: 50,
        fetchedAfterMount: false,
        isSuccess: false
      },
      expected: {
        currentQueryHasObservedSuccessfulData: false,
        queryTotal: 180,
        total: 180
      }
    }
  ]) {
    assert.deepEqual(
      resolveImageAdminScopeTotal(scenario.input),
      scenario.expected,
      scenario.name
    );
  }
  const options = adminImageListQuery(
    "ready",
    filters,
    scope,
    100,
    60
  );
  assert.deepEqual(options.queryKey, [
    ...queryKeys.adminImages,
    scope,
    100,
    60
  ]);
  const requested: string[] = [];
  const validators: string[] = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requested.push(String(input));
    validators.push(new Headers(init?.headers).get("if-none-match") ?? "");
    if (requested.length === 2) {
      return new Response(null, {
        status: 304,
        headers: { ETag: 'W/"admin-page"' }
      });
    }
    return new Response(
      JSON.stringify({
        ok: true,
        items: [],
        total: 6_000
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: 'W/"admin-page"'
        }
      }
    );
  };
  try {
    const { QueryClient } = await import("@tanstack/react-query");
    const client = new QueryClient();
    t.after(() => client.clear());
    const firstPage = await client.fetchQuery(options);
    assert.equal(firstPage.total, 6_000);
    assert.strictEqual(await client.fetchQuery(options), firstPage);
    assert.equal(requested.length, 1, "90 秒新鲜目标页不得重复请求");
    await client.invalidateQueries({
      queryKey: options.queryKey,
      exact: true,
      refetchType: "none"
    });
    assert.strictEqual(
      await client.fetchQuery(options),
      firstPage,
      "相同管理员列表应以 304 复用缓存对象"
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.equal(requested.length, 2);
  assert.deepEqual(validators, ["", 'W/"admin-page"']);
  const target = new URL(requested[0]!, "https://imageshow.test");
  assert.equal(target.searchParams.get("page"), "100");
  assert.equal(target.searchParams.get("limit"), "60");
  assert.equal(target.searchParams.get("cursor"), null);
  assert.equal(target.searchParams.get("device"), "pc");
  assert.equal(target.searchParams.get("brightness"), "dark");
  assert.equal(target.searchParams.get("theme"), "night");
  assert.equal(target.searchParams.get("tag"), "blue");
  assert.equal(target.searchParams.get("author"), "alice");
  assert.equal(target.searchParams.get("sort_by"), "image_time");
  assert.equal(target.searchParams.get("order"), "latest");
});

test("[Web/后台] 后台数字页 Hook 在 Strict Mode 下直达、重试并一次夹紧", async (t) => {
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

  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  let page50Attempts = 0;
  let page75Started = false;
  let page75Aborted = false;
  let page100Started = false;
  let resolvePage100: ((response: Response) => void) | null = null;
  let resolveUnsetPage: ((response: Response) => void) | null = null;
  let pageSizeRequestStarted = false;
  let resolvePageSizeRequest: ((response: Response) => void) | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "https://imageshow.test");
    requests.push(url.toString());
    const page = Number(url.searchParams.get("page"));
    if (url.searchParams.get("limit") === "30") {
      pageSizeRequestStarted = true;
      return new Promise<Response>((resolve) => {
        resolvePageSizeRequest = resolve;
      });
    }
    if (url.searchParams.get("status") === "ready" && page === 75) {
      page75Started = true;
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const aborted = () => {
          page75Aborted = true;
          reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) aborted();
        else signal?.addEventListener("abort", aborted, { once: true });
      });
    }
    if (url.searchParams.get("status") === "ready" && page === 100) {
      page100Started = true;
      return new Promise<Response>((resolve) => {
        resolvePage100 = resolve;
      });
    }
    if (url.searchParams.get("status") === "ready"
      && page === 50
      && page50Attempts++ === 0) {
      return new Response(
        JSON.stringify({
          ok: false,
          code: "controlled_failure",
          error: "controlled page failure",
          details: {}
        }),
        {
          status: 500,
          headers: { "Content-Type": "application/json" }
        }
      );
    }
    if (url.searchParams.get("theme") === "null") {
      return new Promise<Response>((resolve) => {
        resolveUnsetPage = resolve;
      });
    }
    const total = url.searchParams.get("status") === "ready" && page === 50
      ? 120
      : 6_000;
    return new Response(JSON.stringify({ ok: true, items: [], total }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          refetchOnWindowFocus: false
        }
      }
    });
    t.after(() => client.clear());
    let props: Parameters<typeof useImageAdminPageNavigation>[0] = {
      view: "ready" as const,
      filters: emptyImageAdminFilters,
      pageSize: 60
    };
    let latest!: ReturnType<typeof useImageAdminPageNavigation>;
    function Harness() {
      latest = useImageAdminPageNavigation(props);
      return React.createElement(
        "output",
        null,
        `${latest.pageNumber}:${latest.totalPages}`
      );
    }
    const tree = () =>
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(Harness)
        )
      );
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const waitFor = async (condition: () => boolean) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (condition()) return;
      }
      assert.fail("等待后台数字页 Hook 状态超时");
    };

    await React.act(async () => root.render(tree()));
    await waitFor(() => latest.total === 6_000 && !latest.isFetching);
    assert.equal(latest.hasCurrentPageData, true);
    assert.equal(requests.length, 1, "Strict Mode 初始查询必须单飞");

    const pageOneState = client.getQueryState([
      ...queryKeys.adminImages,
      latest.scopeKey,
      1,
      60
    ]);
    assert.ok(pageOneState);
    const page80Key = [...queryKeys.adminImages, latest.scopeKey, 80, 60];
    client.setQueryData(
      page80Key,
      { items: [{ id: "cached-page-80" }], total: 3_000 },
      { updatedAt: pageOneState.dataUpdatedAt }
    );
    await React.act(async () => latest.loadPage(80, false));
    assert.equal(latest.pageNumber, 80);
    assert.equal(latest.totalPages, 100, "同时间戳旧缓存不得覆盖当前 scope 总数");
    assert.equal(latest.total, 6_000);
    assert.equal(latest.hasCurrentPageData, true);
    assert.equal(latest.items[0]?.id, "cached-page-80");
    assert.equal(requests.length, 1, "90 秒内的目标页缓存必须零网络复用");
    client.setQueryData(
      page80Key,
      { items: [{ id: "updated-page-80" }], total: 7_200 },
      { updatedAt: pageOneState.dataUpdatedAt }
    );
    await waitFor(() => latest.total === 7_200);
    assert.equal(latest.totalPages, 120, "同时间戳的新成功结果必须覆盖旧快照");
    client.setQueryData(
      page80Key,
      { items: [{ id: "current-page-80" }], total: 6_000 },
      { updatedAt: pageOneState.dataUpdatedAt }
    );
    await waitFor(() => latest.items[0]?.id === "current-page-80");
    assert.equal(latest.totalPages, 100);
    assert.equal(latest.total, 6_000);

    await React.act(async () => latest.loadPage(100, false));
    await waitFor(() => page100Started && latest.pageNumber === 100);
    assert.equal(latest.pageNumber, 100);
    assert.equal(latest.totalPages, 100, "加载目标页时必须保留已知总页数");
    assert.equal(latest.total, 6_000, "加载目标页时必须保留已知总项数");
    assert.equal(latest.hasCurrentPageData, false);
    assert.equal(latest.items.length, 0, "不得把上一页 items 伪装成目标页内容");
    const finishPage100 = resolvePage100 as ((response: Response) => void) | null;
    assert.ok(finishPage100);
    await React.act(async () =>
      finishPage100(
        new Response(
          JSON.stringify({
            ok: true,
            items: [],
            total: 6_000
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      )
    );
    await waitFor(() => latest.pageNumber === 100 && !latest.isFetching);
    assert.equal(
      requests.filter((value) => new URL(value).searchParams.get("page") === "100").length,
      1
    );

    await React.act(async () => latest.loadPage(75, false));
    await waitFor(() => page75Started);
    assert.equal(latest.pageNumber, 75);
    assert.equal(latest.totalPages, 100);
    assert.equal(latest.total, 6_000);
    assert.equal(latest.items.length, 0);
    props = { ...props, filters: { ...emptyImageAdminFilters, theme: "null" } };
    await React.act(async () => root.render(tree()));
    await waitFor(() => resolveUnsetPage !== null && page75Aborted);
    assert.equal(latest.pageNumber, 1, "scope 变化的同一渲染必须立即使用第 1 页");
    assert.equal(latest.totalPages, 1, "新 scope 不得沿用旧总页数");
    assert.equal(latest.total, 0, "新 scope 不得沿用旧总项数");
    const finishUnsetPage = resolveUnsetPage as ((response: Response) => void) | null;
    assert.ok(finishUnsetPage);
    await React.act(async () =>
      finishUnsetPage(
        new Response(
          JSON.stringify({
            ok: true,
            items: [],
            total: 180
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      )
    );
    await waitFor(() => page75Aborted && latest.total === 180);
    assert.equal(latest.totalPages, 3);
    assert.equal(
      requests.some((value) => {
        const url = new URL(value);
        return url.searchParams.get("theme") === "null"
          && url.searchParams.get("page") !== "1";
      }),
      false
    );

    const beforeRouteReturn = requests.length;
    props = { ...props, filters: emptyImageAdminFilters };
    await React.act(async () => root.render(tree()));
    await waitFor(() => latest.pageNumber === 1 && latest.total === 6_000);
    assert.equal(
      requests.length,
      beforeRouteReturn,
      "返回 90 秒内的新鲜 scope 不得重新请求"
    );

    await React.act(async () => latest.loadPage(50, false));
    await waitFor(() => latest.pageNumber === 50 && latest.isError);
    assert.equal(latest.pageNumber, 50, "失败后必须保留目标页");
    assert.equal(latest.totalPages, 100, "失败后必须保留最近成功总页数");
    assert.equal(latest.total, 6_000, "失败后必须保留最近成功总项数");
    assert.equal(latest.hasCurrentPageData, false, "失败页不得伪造空列表数据");
    await React.act(async () => {
      await latest.refetch();
    });
    await waitFor(() => latest.pageNumber === 2
      && latest.total === 6_000
      && !latest.isFetching);
    const readyPages = requests
      .map((value) => new URL(value))
      .filter(
        (url) =>
          url.searchParams.get("status") === "ready"
          && url.searchParams.get("theme") !== "null"
      )
      .map((url) => url.searchParams.get("page"));
    assert.equal(readyPages.filter((page) => page === "50").length, 2);
    assert.equal(readyPages.filter((page) => page === "2").length, 1);
    assert.equal(
      readyPages.some(
        (page) => Number(page) > 2
          && page !== "50"
          && page !== "75"
          && page !== "100"
      ),
      false,
      "total 收缩只能直接夹到最终页，不能逐页回退"
    );

    const beforeStableRender = requests.length;
    await React.act(async () => root.render(tree()));
    assert.equal(requests.length, beforeStableRender);

    props = { ...props, pageSize: 30 };
    await React.act(async () => root.render(tree()));
    await waitFor(() => pageSizeRequestStarted);
    assert.equal(latest.pageNumber, 1);
    assert.equal(latest.totalPages, 1, "page size scope 不得沿用旧总页数");
    assert.equal(latest.total, 0, "page size scope 不得沿用旧总项数");
    assert.equal(latest.items.length, 0);
    const finishPageSizeRequest = resolvePageSizeRequest as ((response: Response) => void) | null;
    assert.ok(finishPageSizeRequest);
    await React.act(async () =>
      finishPageSizeRequest(
        new Response(
          JSON.stringify({
            ok: true,
            items: [],
            total: 6_000
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" }
          }
        )
      )
    );
    await waitFor(() => latest.total === 6_000 && !latest.isFetching);
    assert.equal(requests.length, beforeStableRender + 1);
    const resized = new URL(requests.at(-1)!);
    assert.equal(resized.searchParams.get("page"), "1");
    assert.equal(resized.searchParams.get("limit"), "30");

    await React.act(async () => root.unmount());
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/后台] 图片后台真实挂载保持排序偏好、弹窗页码、操作后夹紧及权限", async (t) => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const localStorageValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    }
  };
  const requestAnimationFrame = (callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 0) as unknown as number;
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("https://imageshow.test/admin/images")
  });
  Object.assign(window, {
    localStorage,
    matchMedia: (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true
    }),
    requestAnimationFrame,
    cancelAnimationFrame,
    scrollTo() {}
  });
  const clock = installControlledClock(t, window as unknown as Window, {
    minimumControlledDelayMs: 3_000,
    includeGlobalTimers: true,
    includeDateNow: false
  });
  const elementScrollTo = Object.getOwnPropertyDescriptor(
    window.HTMLElement.prototype,
    "scrollTo"
  );
  Object.defineProperty(window.HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value() {}
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
    HTMLButtonElement: window.HTMLButtonElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    localStorage,
    getComputedStyle: () => ({ overflowY: "auto", getPropertyValue: () => "", animationName: "none", animationDuration: "0s" }),
    requestAnimationFrame,
    cancelAnimationFrame,
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
  const previousConsoleError = console.error;
  const expectedListErrors: unknown[][] = [];
  const expectedMutationErrors: unknown[][] = [];
  const expectedEditorErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    const report =
      args[0] === "[ImageShow]" ? (args[1] as { context?: string } | undefined) : undefined;
    if (report?.context === "image_admin.list_load") {
      expectedListErrors.push(args);
      return;
    }
    if (report?.context === "image_admin.editor_load") {
      expectedEditorErrors.push(args);
      return;
    }
    if (report?.context === "image_admin.trash_or_purge") {
      expectedMutationErrors.push(args);
      return;
    }
    previousConsoleError(...args);
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider } =
      await import("../../../../packages/web/src/hooks/useAuthSession.tsx");
    const { AdminPreferencesProvider } =
      await import("../../../../packages/web/src/hooks/useAdminPreferences.tsx");
    const { ActionFeedbackProvider } =
      await import("../../../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx");
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    const { ImageAdmin } =
      await import("../../../../packages/web/src/pages/admin/images/ImageAdmin.tsx").finally(() =>
        cssHooks.deregister()
      );
    const { ADMIN_ICONS } =
      await import("../../../../packages/web/src/components/icon/admin-icons.generated.ts");
    const container = document.getElementById("root");
    assert.ok(container);

    const jsonResponse = (value: unknown) =>
      new Response(JSON.stringify({ ok: true, ...(value as Record<string, unknown>) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    const image = (serial: string): AdminImageListItemDto => ({...galleryCard(`00000000-0000-7000-8000-${serial}`),device: "pc", brightness: "dark", author: null, image_time: "2026-09-01T00:00:00.000Z",description: "",storage_label: "本地存储",source: null,status: "deleted",purge_pending: false,original: "",deleted_at: "2026-08-15T00:00:00.000Z",created_at: "2026-08-14T00:00:00.000Z",updated_at: "2026-08-15T00:00:00.000Z",base_url:"/images",variants:{large:{byte_size:1024},medium:{byte_size:800},small:{byte_size:200}}});
    const waitFor = async (condition: () => boolean, message: string) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10));
        });
        if (condition()) return;
      }
      assert.fail(message);
    };
    const click = async (target: HTMLElement) => {
      await React.act(async () => {
        target.dispatchEvent(new window.Event("click", { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const submitForm = async (target: HTMLFormElement) => {
      await React.act(async () => {
        target.dispatchEvent(
          new window.Event("submit", {
            bubbles: true,
            cancelable: true
          })
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const buttonWithText = (text: string) => {
      const target = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes(text)
      );
      assert.ok(target, `missing ${text} button`);
      return target;
    };

    const runMutationScenario = async (mode: "restore" | "purge" | "purge-unknown") => {
      const purgeMode = mode !== "restore";
      const mutationKind = purgeMode ? "purge" : "restore";
      const permissions = purgeMode
        ? [adminPermissions.imageTrashPurge]
        : [];
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false }
        }
      });
      client.setQueryData(queryKeys.me, {
        authenticated: true,
        username: `pagination-${mode}`,
        role: purgeMode ? "super" : "image",
        permissions,
        csrf_token: "pagination-test-token",
        application_version: "current-test",
        preferences: {},
        preferences_etag: 'W/"pagination-preferences"',
        version_settings: { enabled: true, link_enabled: true }
      });
      client.setQueryData(queryKeys.settings, {
        settings: {
          admin: { image_page_size: 1 },
          ingestion: { list_page_size: 1 }
        }
      });
      client.setQueryData(queryKeys.ingestionVocabulary, {
        themes: [],
        tags: [],
        authors: []
      });
      client.setQueryData(queryKeys.storageOptions, {
        backends: [
          {
            slug: "local",
            display_name: "本地存储",
            enabled: true,
            is_default: true
          }
        ]
      });

      const listRequests: number[] = [];
      let shrunk = false;
      let mutationRequests = 0;
      let pageTwoAttempts = 0;
      let pageTwoStarted = false;
      let resolvePageTwo: ((response: Response) => void) | null = null;
      let postMutationRefreshStarted = false;
      let resolvePostMutationRefresh: ((response: Response) => void) | null = null;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), "https://imageshow.test");
        if (url.pathname === "/api/admin/images") {
          const page = Number(url.searchParams.get("page"));
          listRequests.push(page);
          const total = shrunk ? 1 : 2;
          if (page === 2 && shrunk && !postMutationRefreshStarted) {
            postMutationRefreshStarted = true;
            return new Promise<Response>((resolve) => {
              resolvePostMutationRefresh = resolve;
            });
          }
          if (page === 2 && !shrunk && pageTwoAttempts++ === 0) {
            return new Response(
              JSON.stringify({
                ok: false,
                code: "controlled_failure",
                error: "controlled page failure",
                details: {}
              }),
              {
                status: 500,
                headers: { "Content-Type": "application/json" }
              }
            );
          }
          if (page === 2 && !shrunk && !pageTwoStarted) {
            pageTwoStarted = true;
            return new Promise<Response>((resolve) => {
              resolvePageTwo = resolve;
            });
          }
          return jsonResponse({
            items: page <= total
              ? [image(String(page).padStart(12, "0"))]
              : [],
            total
          });
        }
        if (url.pathname === "/api/admin/ingestion/vocabulary") {
          return jsonResponse({ themes: [], tags: [], authors: [] });
        }
        if (url.pathname === `/api/admin/images/${mutationKind}`) {
          assert.equal(init?.method, "POST");
          mutationRequests += 1;
          if (mode === "purge-unknown") {
            throw new Error("controlled unknown purge result");
          }
          shrunk = true;
          return mode === "restore"
            ? jsonResponse({
                requested: 1,
                restored: 1,
                ignored: 0,
                results: [
                  {
                    id: "00000000-0000-7000-8000-000000000002",
                    status: "restored"
                  }
                ]
              })
            : jsonResponse({
                requested: 1,
                queued: 1,
                already_queued: 0,
                deleted: 1,
                remaining: 0,
                ignored: 0
              });
        }
        if (url.pathname === "/api/admin/logs/client-errors") {
          return jsonResponse({});
        }
        throw new Error(`unexpected ImageAdmin request: ${url.pathname}`);
      };

      const root = createRoot(container);
      try {
        await React.act(async () => {
          root.render(
            React.createElement(
              QueryClientProvider,
              { client },
              React.createElement(
                MemoryRouter,
                { initialEntries: ["/admin/images?view=deleted"] },
                React.createElement(
                  AuthSessionProvider,
                  null,
                  React.createElement(
                    AdminPreferencesProvider,
                    {
                      username: `pagination-${mode}`,
                      serverPreferences: {},
                      serverPreferencesEtag: 'W/"pagination-preferences"',
                      serverPreferencesUpdatedAt: Date.now()
                    },
                    React.createElement(
                      ActionFeedbackProvider,
                      null,
                      React.createElement(ImageAdmin)
                    )
                  )
                )
              )
            )
          );
        });
        const showsPage = (current: number, total: number) =>
          container.querySelector<HTMLInputElement>('[aria-label="图片列表分页当前页"]')?.value === String(current)
          && Boolean(container.querySelector(".admin-pagination-status")?.textContent?.includes(`/ ${total} 页`));
        await waitFor(
          () => listRequests.length === 1 && showsPage(1, 2),
          `${mode} scenario initial page did not load`
        );
        await click(buttonWithText("下一页"));
        await waitFor(
          () =>
            [...container.querySelectorAll("button")].some((button) =>
              button.textContent?.includes("重试")
            ),
          `${mode} scenario page 2 failure did not render`
        );
        const pageStatus = container.querySelector<HTMLElement>(
          '.image-admin-head-copy > p[role="status"]'
        );
        assert.ok(pageStatus);
        assert.equal(
          pageStatus.textContent,
          "共 2 项",
          "失败且无页数据时不得伪造本页 0 项"
        );
        await click(buttonWithText("重试"));
        await waitFor(
          () => pageTwoStarted,
          `${mode} scenario page 2 request did not start`
        );
        assert.equal(
          pageStatus.textContent,
          "共 2 项 · 加载中",
          "加载期间只应显示稳定分页元数据和加载状态"
        );
        const finishPageTwo = resolvePageTwo as ((response: Response) => void) | null;
        assert.ok(finishPageTwo);
        await React.act(async () =>
          finishPageTwo(
            jsonResponse({
              items: [image("000000000002")],
              total: 2
            })
          )
        );
        await waitFor(
          () => pageStatus.textContent === "共 2 项 · 本页 1 项",
          `${mode} scenario page 2 did not load`
        );

        const purgeButton = container.querySelector<HTMLButtonElement>(
          'button[aria-label^="永久删除图片："]'
        );
        if (mode === "restore") {
          assert.equal(purgeButton, null, "图片管理员不得看到永久删除入口");
          assert.doesNotMatch(container.textContent ?? "", /清空回收站/);
        } else {
          assert.ok(purgeButton, "超级管理员必须看到永久删除入口");
          const listRequestsBeforeDialog = listRequests.length;
          await click(buttonWithText("清空回收站"));
          await waitFor(
            () => Boolean(document.querySelector("[data-dialog-frame]")),
            "purge confirmation did not open"
          );
          await click(buttonWithText("取消"));
          await waitFor(
            () => !document.querySelector("[data-dialog-frame]"),
            "purge confirmation did not close"
          );
          assert.equal(
            listRequests.length,
            listRequestsBeforeDialog,
            "关闭确认弹窗不得重取当前数字页"
          );
          assert.ok(showsPage(2, 2));
        }

        if (mode === "restore") {
          const restoreButton = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="恢复图片："]'
          );
          assert.ok(restoreButton);
          await click(restoreButton);
        } else {
          const firstPurge = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="永久删除图片："]'
          );
          assert.ok(firstPurge);
          await click(firstPurge);
          await waitFor(
            () => Boolean(document.querySelector("[data-dialog-frame]")),
            "single purge confirmation did not open"
          );
          assert.equal(mutationRequests, 0);
          const purgeDialog = document.querySelector<HTMLElement>("[data-dialog-frame]");
          assert.ok(purgeDialog);
          const permanentDelete = purgeDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="永久删除"]'
          );
          assert.ok(permanentDelete);
          assert.equal(
            permanentDelete.querySelector("path")?.getAttribute("d"),
            ADMIN_ICONS["delete-bin-line"]
          );
          const purgeForm = purgeDialog.querySelector<HTMLFormElement>("form");
          assert.ok(purgeForm);
          await submitForm(purgeForm);
          assert.equal(mutationRequests, 0, "首次弹窗确认只能进入二次确认态");
          await waitFor(
            () => Boolean(purgeDialog.querySelector('button[aria-label="确认删除"]')),
            "purge dialog did not enter final confirmation state"
          );
          const confirmedPurge = purgeDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="确认删除"]'
          );
          assert.ok(confirmedPurge);
          assert.equal(
            confirmedPurge.querySelector("path")?.getAttribute("d"),
            ADMIN_ICONS["delete-bin-2-line"]
          );
          await submitForm(purgeForm);
          await waitFor(
            () => Boolean(purgeDialog.querySelector('button[aria-label="正在删除"]')),
            "purge dialog did not enter pending state"
          );
          const pendingPurge = purgeDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="正在删除"]'
          );
          assert.ok(pendingPurge);
          assert.equal(
            pendingPurge.querySelector("path")?.getAttribute("d"),
            ADMIN_ICONS["delete-bin-5-line"]
          );
        }
        if (mode === "purge-unknown") {
          const unknownMessage =
            "操作结果未能确认，图片列表已刷新，但无法确认操作已经收口，请稍后再次刷新";
          await waitFor(
            () =>
              Boolean(
                document
                  .querySelector(".confirm-dialog-error")
                  ?.textContent?.includes(unknownMessage)
              ),
            "unknown purge result was not presented inside the dialog"
          );
          const purgeDialog = document.querySelector<HTMLElement>("[data-dialog-frame]");
          assert.ok(purgeDialog);
          const failedConfirm =
            purgeDialog.querySelector<HTMLButtonElement>("button.danger-button");
          assert.ok(failedConfirm);
          assert.equal(failedConfirm.disabled, true, "未知删除结果不得盲目重试");
          assert.equal(
            document.querySelector(".image-admin-feedback-region .action-feedback-error"),
            null,
            "未知删除结果不得在 inert 页面背后启动短反馈"
          );
          await React.act(async () => {
            await clock.advanceBy(3_200);
          });
          assert.ok(document.querySelector("[data-dialog-frame]"));
          assert.match(
            document.querySelector(".confirm-dialog-error")?.textContent ?? "",
            /操作结果未能确认/,
            "弹窗内错误不得按页面反馈时长自动消失"
          );
          assert.equal(mutationRequests, 1);
          await click(buttonWithText("取消"));
          await waitFor(
            () => !document.querySelector("[data-dialog-frame]"),
            "unknown purge dialog did not close explicitly"
          );
          const reopenPurge = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="永久删除图片："]'
          );
          assert.ok(reopenPurge);
          await click(reopenPurge);
          await waitFor(
            () => Boolean(document.querySelector("[data-dialog-frame]")),
            "purge dialog did not reopen after an unknown result"
          );
          const reopenedDialog = document.querySelector<HTMLElement>("[data-dialog-frame]");
          assert.ok(reopenedDialog);
          assert.equal(reopenedDialog.querySelector(".confirm-dialog-error"), null);
          const reopenedConfirm = reopenedDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="永久删除"]'
          );
          assert.ok(reopenedConfirm);
          assert.equal(reopenedConfirm.disabled, false);
          await click(buttonWithText("取消"));
          await waitFor(
            () => !document.querySelector("[data-dialog-frame]"),
            "reopened purge dialog did not close"
          );
          return;
        }
        const expectedResult = mode === "restore"
          ? "已恢复 1 张"
          : "已永久删除 1 张";
        await waitFor(
          () =>
            postMutationRefreshStarted &&
            (mode === "purge"
              || (container.textContent ?? "").includes(expectedResult)),
          `${mode} list refresh did not start at the expected result boundary`
        );
        assert.ok(
          document.getElementById("admin-image-select-00000000-0000-7000-8000-000000000002"),
          `${mode} must retain the affected card until the list refresh settles`
        );
        if (mode === "restore") {
          const visibleResult = document.querySelector<HTMLElement>(
            ".image-admin-feedback-region .action-feedback-success"
          );
          assert.ok(visibleResult);
          assert.equal(visibleResult.textContent?.includes(expectedResult), true);
          assert.doesNotMatch(visibleResult.textContent ?? "", /0 张未处理/);
        } else {
          assert.equal(
            (container.textContent ?? "").includes(expectedResult),
            false,
            "永久删除结果不得在仍覆盖页面的确认弹窗后方开始倒计时"
          );
          await React.act(async () => {
            await clock.advanceBy(3_200);
          });
          assert.ok(document.querySelector("[data-dialog-frame]"));
          assert.equal(
            (container.textContent ?? "").includes(expectedResult),
            false
          );
        }
        const finishPostMutationRefresh = resolvePostMutationRefresh as
          ((response: Response) => void) | null;
        assert.ok(finishPostMutationRefresh);
        await React.act(async () =>
          finishPostMutationRefresh(
            jsonResponse({
              items: [],
              total: 1
            })
          )
        );
        await waitFor(
          () =>
            mutationRequests === 1 &&
            showsPage(1, 1) &&
            listRequests.at(-1) === 1,
          `${mode} scenario did not clamp to the new last page`
        );
        assert.deepEqual(
          listRequests.slice(-2),
          [2, 1],
          `${mode} must refetch the target page once and clamp directly`
        );
        if (mode === "purge") {
          await waitFor(
            () =>
              !document.querySelector("[data-dialog-frame]") &&
              (container.textContent ?? "").includes(expectedResult),
            "purge result did not become visible after the slow dialog operation"
          );
          assert.ok(
            document.querySelector(".image-admin-feedback-region .action-feedback-success")
          );
        }
      } finally {
        await React.act(async () => root.unmount());
        client.clear();
        globalThis.fetch = previousFetch;
        container.replaceChildren();
      }
    };

    const runTrashScenario = async () => {
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false }
        }
      });
      client.setQueryData(queryKeys.me, {
        authenticated: true,
        username: "trash-interface",
        role: "image",
        permissions: [],
        csrf_token: "trash-interface-token",
        application_version: "current-test",
        preferences: {},
        preferences_etag: 'W/"trash-interface-preferences"',
        version_settings: { enabled: true, link_enabled: true }
      });
      client.setQueryData(queryKeys.settings, {
        settings: {
          admin: { image_page_size: 2 },
          ingestion: { list_page_size: 20 }
        }
      });
      client.setQueryData(queryKeys.storageOptions, {
        backends: [
          {
            slug: "local",
            display_name: "本地存储",
            enabled: true,
            is_default: true
          }
        ]
      });

      const readyItems = [
        "000000000011",
        "000000000012",
        "000000000013"
      ].map((serial) => ({
        ...image(serial),
        status: "ready" as const,
        deleted_at: null
      }));
      const initialReadyItems = readyItems.slice(0, 2);
      // 按 ID 指定的图片不在当前列表页上，只由快照接口返回。
      const offPageImageId = "00000000-0000-7000-8000-000000000014";
      const snapshotBodies: Array<{ ids: string[] }> = [];
      let readyListReads = 0;
      let vocabularyReads = 0;
      const trashedIds = new Set<string>();
      const trashBodies: Array<{ ids: string[] }> = [];
      const releaseTrashMutations: Array<() => void> = [];
      const pendingTrashRefreshes: Array<{
        resolve: () => void;
        reject: () => void;
      }> = [];
      let deferNextTrashRefresh = false;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), "https://imageshow.test");
        if (url.pathname === "/api/admin/images") {
          readyListReads++;
          const remaining = readyItems.filter((item) => !trashedIds.has(item.id));
          const response = jsonResponse({
            items: remaining.slice(0, 2),
            total: remaining.length
          });
          if (deferNextTrashRefresh) {
            deferNextTrashRefresh = false;
            return new Promise<Response>((resolve, reject) => {
              pendingTrashRefreshes.push({
                resolve: () => resolve(response),
                reject: () => reject(new Error("controlled trash list refresh failure"))
              });
            });
          }
          return response;
        }
        if (url.pathname === "/api/admin/ingestion/vocabulary") {
          vocabularyReads++;
          return jsonResponse({ themes: [], tags: [], authors: [] });
        }
        if (url.pathname === "/api/admin/images/snapshot") {
          assert.equal(init?.method, "POST");
          const body = JSON.parse(String(init?.body)) as { ids: string[] };
          snapshotBodies.push(body);
          return jsonResponse({
            items: body.ids
              .filter((id) => id === offPageImageId && !trashedIds.has(id))
              .map((id) => editableImage(id))
          });
        }
        if (url.pathname === "/api/admin/images/trash") {
          assert.equal(init?.method, "POST");
          const body = JSON.parse(String(init?.body)) as { ids: string[] };
          trashBodies.push(body);
          return new Promise<Response>((resolve) => {
            releaseTrashMutations.push(() => {
              for (const id of body.ids) trashedIds.add(id);
              deferNextTrashRefresh = true;
              resolve(
                jsonResponse({
                  requested: body.ids.length,
                  trashed: body.ids.length,
                  ignored: 0,
                  results: body.ids.map((id) => ({ id, status: "trashed" }))
                })
              );
            });
          });
        }
        if (url.pathname === "/api/admin/logs/client-errors") {
          return jsonResponse({});
        }
        throw new Error(`unexpected trash interface request: ${url.pathname}`);
      };

      const renderImages = async (Page = ImageAdmin) => {
        await React.act(async () => {
          root.render(
            React.createElement(
              QueryClientProvider,
              { client },
              React.createElement(
                MemoryRouter,
                { initialEntries: ["/admin/images"] },
                React.createElement(
                  AuthSessionProvider,
                  null,
                  React.createElement(
                    AdminPreferencesProvider,
                    {
                      username: "trash-interface",
                      serverPreferences: {},
                      serverPreferencesEtag: 'W/"trash-interface-preferences"',
                      serverPreferencesUpdatedAt: Date.now()
                    },
                    React.createElement(
                      ActionFeedbackProvider,
                      null,
                      React.createElement(Page)
                    )
                  )
                )
              )
            )
          );
        });
      };
      const root = createRoot(container);
      try {
        await renderImages();
        await waitFor(
          () => container.querySelectorAll(".admin-image-card").length === 2,
          "trash interface scenario did not load ready items"
        );
        const editButton = () => container.querySelector<HTMLButtonElement>('button[aria-label^="编辑图片："]');
        assert.ok(editButton());
        await React.act(async () => editButton()!.dispatchEvent(new window.Event("focusin", { bubbles: true })));
        await waitFor(() => vocabularyReads === 1, "editor preload did not prepare vocabulary");
        readyItems[0] = { ...readyItems[0]!, title: "refreshed before opening" };
        await React.act(async () => client.invalidateQueries({ queryKey: queryKeys.adminImages }));
        await waitFor(() => (container.textContent ?? "").includes("refreshed before opening"), "new list value did not render");
        const readsBeforeOpen = readyListReads;
        await click(editButton()!);
        await waitFor(() => Boolean(document.querySelector(".image-editor-row")), "editor did not open from refreshed list");
        assert.equal(document.querySelector<HTMLInputElement>(".image-editor-row .image-fields-title")?.value, "refreshed before opening");
        assert.equal(snapshotBodies.length, 0, "完整列表在预热后换成新对象也无需补快照");
        assert.equal(readyListReads, readsBeforeOpen, "打开编辑器不额外验证整页");
        assert.equal(vocabularyReads, 1, "新列表对象复用已有词表");
        const editorClose = document.querySelector<HTMLButtonElement>('.image-metadata-editor-dialog button[title="关闭"]')
          ?? document.querySelector<HTMLButtonElement>('[data-dialog-frame] button[title="关闭"]');
        assert.ok(editorClose);
        await click(editorClose);
        await waitFor(() => !document.querySelector("[data-dialog-frame]"), "editor did not close");
        const selectionTargets = [
          ...container.querySelectorAll<HTMLElement>(".admin-image-card-checkbox-hit-area")
        ];
        assert.equal(selectionTargets.length, 2);
        await click(selectionTargets[0]!);
        await click(selectionTargets[1]!);
        await waitFor(
          () => /已选 2/.test(container.textContent ?? ""),
          "trash interface scenario did not select both items"
        );

        // 两步确认按钮把各状态文案都放在占位格中，当前状态以 aria-label 为准。
        const batchTrashButton = (label: string) => container.querySelector<HTMLButtonElement>(
          `.two-step-confirm-button[aria-label="${label}"]`
        );
        let batchTrash = batchTrashButton("批量删除");
        assert.ok(batchTrash);
        await click(batchTrash);
        assert.equal(trashBodies.length, 0);
        assert.equal(batchTrash.getAttribute("aria-pressed"), "true");
        assert.equal(batchTrash.getAttribute("aria-label"), "确认删除");
        assert.equal(document.querySelector("[data-dialog-frame]"), null);

        await click(selectionTargets[0]!);
        await waitFor(
          () => /已选 1/.test(container.textContent ?? "")
            && Boolean(batchTrashButton("批量删除")),
          "selection change did not disarm frozen batch delete"
        );
        assert.equal(trashBodies.length, 0);
        await click(selectionTargets[0]!);
        await waitFor(
          () => /已选 2/.test(container.textContent ?? ""),
          "trash interface scenario did not restore both selections"
        );

        batchTrash = batchTrashButton("批量删除");
        assert.ok(batchTrash);
        await click(batchTrash);
        await click(batchTrash);
        await waitFor(
          () => trashBodies.length === 1,
          "batch trash did not submit after the second click"
        );
        assert.deepEqual(trashBodies[0], {
          ids: initialReadyItems.map((item) => item.id)
        });
        const pendingBatchTrash = container.querySelector<HTMLButtonElement>(
          '.two-step-confirm-button[aria-label="正在删除"]'
        );
        assert.ok(pendingBatchTrash);
        assert.equal(
          pendingBatchTrash.querySelector("path")?.getAttribute("d"),
          ADMIN_ICONS["delete-bin-5-line"]
        );
        await React.act(async () => releaseTrashMutations.shift()?.());
        await waitFor(
          () =>
            pendingTrashRefreshes.length === 1 &&
            (container.textContent ?? "").includes("已移入回收站 2 张"),
          "batch trash result was not rendered before list refresh"
        );
        assert.equal(
          container.querySelectorAll(".admin-image-card").length,
          2,
          "批量删除已知结果出现时原卡片必须仍在当前图库"
        );
        for (const item of initialReadyItems) {
          assert.ok(document.getElementById(`admin-image-select-${item.id}`));
        }
        assert.ok(container.querySelector(".image-admin-feedback-region .action-feedback-success"));
        assert.doesNotMatch(container.textContent ?? "", /0 张未处理/);
        await React.act(async () => pendingTrashRefreshes.shift()?.resolve());
        await waitFor(
          () =>
            // 删除完成后选择已清空，工具栏回到按 ID 指定图片的「删除图片」。
            [...container.querySelectorAll("button")].some(
              (button) => button.textContent === "删除图片"
            ) &&
            !container.querySelector('[aria-busy="true"].two-step-confirm-button') &&
            container.querySelectorAll(".admin-image-card").length === 1 &&
            Boolean(document.getElementById(`admin-image-select-${readyItems[2]!.id}`)),
          "batch trash did not return to its idle state"
        );

        const singleTrash = container.querySelector<HTMLButtonElement>(
          'button[aria-label^="删除图片："]'
        );
        assert.ok(singleTrash);
        await click(singleTrash);
        assert.equal(trashBodies.length, 1);
        assert.equal(singleTrash.getAttribute("aria-pressed"), "true");
        await click(singleTrash);
        await waitFor(
          () => trashBodies.length === 2,
          "single trash did not submit after the second click"
        );
        assert.deepEqual(trashBodies[1], { ids: [readyItems[2]!.id] });
        const pendingSingleTrash = container.querySelector<HTMLButtonElement>(
          'button[aria-label^="删除中："]'
        );
        assert.ok(pendingSingleTrash);
        assert.equal(
          pendingSingleTrash.querySelector("path")?.getAttribute("d"),
          ADMIN_ICONS["delete-bin-5-line"]
        );
        assert.equal(document.querySelector("[data-dialog-frame]"), null);
        await React.act(async () => releaseTrashMutations.shift()?.());
        await waitFor(
          () =>
            pendingTrashRefreshes.length === 1 &&
            (container.textContent ?? "").includes("已移入回收站 1 张"),
          "single trash result was not rendered before list refresh"
        );
        assert.ok(document.getElementById(`admin-image-select-${readyItems[2]!.id}`));
        await React.act(async () => pendingTrashRefreshes.shift()?.reject());
        await waitFor(
          () =>
            !container.querySelector('button[aria-label^="删除中："]') &&
            (container.textContent ?? "").includes(
              "已移入回收站 1 张；图片列表刷新失败，请重新加载页面"
            ),
          "single trash did not surface the real list refresh failure"
        );
        assert.equal(
          container.querySelectorAll(".admin-image-card").length,
          1,
          "刷新失败时必须保留缓存卡片并明确要求重新加载"
        );
        assert.ok(container.querySelector(".image-admin-feedback-region .action-feedback-error"));

        // 未勾选时按 ID 指定图片：弹窗模块加载期间页面根节点由同一页面锁隔离而按钮外观不变，
        // 弹窗挂载后由其自身的锁接替；删除用途两步确认后提交的 ids 与输入一致。
        const idInputDialogPath = "/packages/web/src/pages/admin/images/ImageIdInputDialog.tsx";
        const idInputDialogHold = Promise.withResolvers<void>();
        const idInputDialogHoldGlobal = "imageshowTestHoldImageIdInputDialog";
        Object.defineProperty(globalThis, idInputDialogHoldGlobal, {
          configurable: true,
          value: idInputDialogHold.promise
        });
        // 让页面的按需导入停在测试控制的 Promise 上，以观察弹窗挂载前的间隙；
        // 真实模块经带查询串的地址原样加载。
        let idInputDialogLoadIntercepted = false;
        const idInputDialogHooks = registerHooks({
          load(url, context, nextLoad) {
            if (!url.endsWith(idInputDialogPath)) return nextLoad(url, context);
            idInputDialogLoadIntercepted = true;
            const source =
              `await globalThis.${idInputDialogHoldGlobal}; export * from ${JSON.stringify(`${url}?real`)};`;
            return { format: "module", source, shortCircuit: true };
          }
        });
        try {
          const idDeleteEntry = () =>
            [...container.querySelectorAll<HTMLButtonElement>("button")].find(
              (button) => button.textContent === "删除图片"
            ) ?? null;
          await waitFor(
            () => idDeleteEntry()?.disabled === false,
            "ID delete entry did not become available after the single trash"
          );
          const entry = idDeleteEntry();
          const cardEdit = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="编辑图片："]'
          );
          const uploadTrigger = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
            (button) => button.textContent === "上传图片"
          );
          assert.ok(entry);
          assert.ok(cardEdit);
          assert.ok(uploadTrigger);
          assert.notEqual(container.inert, true);
          await React.act(async () => {
            entry.dispatchEvent(new window.Event("click", { bubbles: true }));
          });
          // 模块仍被扣住：根节点已 inert、弹窗尚未挂载，各入口按钮既不禁用也不标忙。
          assert.equal(
            idInputDialogLoadIntercepted,
            true,
            "ID 弹窗模块须首次由本用例加载，否则观察不到挂载前的间隙"
          );
          assert.equal(container.inert, true, "ID 弹窗模块加载期间页面根节点必须 inert");
          assert.equal(container.getAttribute("aria-hidden"), "true");
          assert.equal(document.querySelector("[data-dialog-frame]"), null);
          for (const button of [entry, cardEdit, uploadTrigger]) {
            assert.equal(button.disabled, false);
            assert.equal(button.getAttribute("aria-busy"), null);
          }
          idInputDialogHold.resolve();
          await waitFor(
            () => Boolean(document.querySelector("[data-dialog-frame].import-source-overlay")),
            "image ID dialog did not mount after its module loaded"
          );
          assert.equal(container.inert, true, "弹窗挂载后页面锁由弹窗自身接替");
          const idTextarea = document.querySelector<HTMLTextAreaElement>(
            'textarea[aria-label="图片 ID"]'
          );
          assert.ok(idTextarea);
          await React.act(async () => {
            inputText(window as unknown as Window, idTextarea, ` ${offPageImageId.toUpperCase()} `);
          });
          await click(buttonWithText("解析"));
          await waitFor(
            () => Boolean(document.querySelector("[data-dialog-frame].edit-modal")),
            "delete-intent editor did not open from the ID dialog"
          );
          assert.equal(
            document.querySelector(".import-source-overlay"),
            null,
            "ID 弹窗必须在编辑弹窗就绪的同一次渲染中关闭"
          );
          assert.equal(snapshotBodies.length, 1);
          assert.deepEqual(snapshotBodies[0]!.ids, [offPageImageId]);
          const deleteButton = () =>
            document.querySelector<HTMLButtonElement>(".image-editor-delete-button");
          assert.equal(deleteButton()?.getAttribute("aria-label"), "删除 1 张");
          const exclude = document.querySelector<HTMLButtonElement>('.image-editor-row [title="从批量删除中移除"]');
          assert.ok(exclude);
          await click(exclude);
          await waitFor(() => !document.querySelector("[data-dialog-frame]"), "excluding the last image must cancel the delete preview");
          assert.equal(trashBodies.length, 2, "排除最后一张待删除图片按取消处理，不得提交删除请求");
          await click(entry);
          await waitFor(() => Boolean(document.querySelector('textarea[aria-label="图片 ID"]')), "ID input did not reopen");
          await React.act(async () => {
            inputText(window as unknown as Window, document.querySelector<HTMLTextAreaElement>('textarea[aria-label="图片 ID"]')!, offPageImageId);
          });
          await click(buttonWithText("解析"));
          await waitFor(() => Boolean(deleteButton()), "delete preview did not reopen");
          await click(deleteButton()!);
          assert.equal(trashBodies.length, 2);
          assert.equal(deleteButton()?.getAttribute("aria-label"), "确认删除");
          await click(deleteButton()!);
          await waitFor(
            () => trashBodies.length === 3,
            "ID delete did not submit after the second click"
          );
          assert.deepEqual(trashBodies[2], { ids: [offPageImageId] });
          await React.act(async () => releaseTrashMutations.shift()?.());
          await waitFor(
            () =>
              pendingTrashRefreshes.length === 1 &&
              Boolean(container.querySelector(".image-admin-feedback-region .action-feedback-success")),
            "ID delete result was not rendered before list refresh"
          );
          await React.act(async () => pendingTrashRefreshes.shift()?.resolve());
          await waitFor(
            () => !document.querySelector("[data-dialog-frame]") && container.inert !== true,
            "ID delete did not close the editor and release the page lock"
          );
        } finally {
          idInputDialogHold.resolve();
          idInputDialogHooks.deregister();
          Reflect.deleteProperty(globalThis, idInputDialogHoldGlobal);
        }

        // 独立的页面模块图让真实编辑器加载器各经历一次首次加载；其失败缓存仍由生产代码持有。
        // 覆盖脚本失败后的刷新指引，以及入口失效造成交接中断后的关闭重试指引。
        trashedIds.delete(offPageImageId);
        for (const failure of ["load", "interrupted"] as const) {
          const gate = Promise.withResolvers<void>();
          const gateName = "imageshowTestEditorRecoveryGate";
          Object.defineProperty(globalThis, gateName, { configurable: true, value: gate.promise });
          const query = `?id-recovery-${failure}`;
          const isolatedPaths = [
            "/pages/admin/images/ImageAdmin.tsx",
            "/components/image/editor/useImageEditorCapability.ts",
            "/components/image/editor/image-editor-capability-loader.ts",
            "/components/image/editor/image-editor-capability.ts"
          ];
          let loadIntercepted = false;
          const hooks = registerHooks({
            resolve(specifier, context, nextResolve) {
              const resolved = nextResolve(specifier, context);
              if (context.parentURL?.endsWith(query)
                && !context.parentURL.endsWith("/image-editor-capability.ts" + query)
                && isolatedPaths.some((path) => resolved.url.endsWith(path))) {
                return { ...resolved, url: resolved.url + query };
              }
              return resolved;
            },
            load(url, context, nextLoad) {
              if (!url.endsWith("/image-editor-capability.ts" + query)) return nextLoad(url, context);
              loadIntercepted = true;
              const source = `await globalThis.${gateName}; export * from ${JSON.stringify(url.slice(0, -query.length))};`;
              return { format: "module", source, shortCircuit: true };
            }
          });
          try {
            const pageUrl = new URL("../../../../packages/web/src/pages/admin/images/ImageAdmin.tsx", import.meta.url);
            pageUrl.search = query;

            const isolatedPage = await import(pageUrl.href) as { ImageAdmin: typeof ImageAdmin };

            await renderImages(isolatedPage.ImageAdmin);
            await waitFor(() => [...container.querySelectorAll<HTMLButtonElement>("button")].some(button => button.textContent === "删除图片" && !button.disabled), "recovery page did not mount");
            const entry = buttonWithText("删除图片");
            await click(entry);
            const fillAndParse = async () => {
              await waitFor(() => Boolean(document.querySelector('textarea[aria-label="图片 ID"]')), "ID input missing");
              const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="图片 ID"]')!;
              await React.act(async () => inputText(window as unknown as Window, input, offPageImageId));
              await click(buttonWithText("解析"));
              return input;
            };

            const input = await fillAndParse();
            await waitFor(() => loadIntercepted, "editor load must be intercepted before it settles");
            const parent = entry.parentNode!;
            const sibling = entry.nextSibling;
            await React.act(async () => {
              if (failure === "load") gate.reject(new Error("controlled editor script failure"));
              else { entry.remove(); gate.resolve(); }
            });
            const expected = failure === "load"
              ? "编辑器加载失败，请重新加载页面"
              : "未能打开编辑弹窗，请关闭后重试";
            await waitFor(() => (document.querySelector(".import-source-overlay")?.textContent ?? "").includes(expected), `${failure}: wrong editor recovery hint`);
            assert.equal(input.disabled, false);
            assert.ok(input.getAttribute("aria-describedby")?.split(" ").some(id => document.getElementById(id)?.textContent === expected));
            if (failure === "interrupted") parent.insertBefore(entry, sibling);

            await click(buttonWithText("取消"));
            assert.notEqual(container.inert, true);
            await click(entry);

            await fillAndParse();
            if (failure === "load") {
              await waitFor(() => (document.querySelector(".import-source-overlay")?.textContent ?? "").includes(expected), "closing and reopening must retain the page-lifetime load failure");
              await click(buttonWithText("取消"));
            } else {
              await waitFor(() => Boolean(document.querySelector(".edit-modal")), "interrupted handoff should recover after reopening");
              await click(document.querySelector<HTMLButtonElement>('.edit-modal button[title="关闭"]')!);
            }
          } finally {
            gate.resolve();
            hooks.deregister();
            Reflect.deleteProperty(globalThis, gateName);
          }
        }
      } finally {
        await React.act(async () => root.unmount());
        client.clear();
        globalThis.fetch = previousFetch;
        container.replaceChildren();
      }
    };

    const runSortScenario = async () => {
      const username = "sort-preference-admin";
      const client = new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false }
        }
      });
      client.setQueryData(queryKeys.me, {
        authenticated: true,
        username,
        role: "image",
        permissions: [],
        csrf_token: "sort-token",
        application_version: "current-test",
        preferences: {},
        preferences_etag: 'W/"sort-preferences"',
        version_settings: { enabled: true, link_enabled: true }
      });
      client.setQueryData(queryKeys.settings, {
        settings: {
          admin: { image_page_size: 1 },
          ingestion: { list_page_size: 1 }
        }
      });
      client.setQueryData(queryKeys.ingestionVocabulary, {
        themes: [],
        tags: [],
        authors: []
      });
      client.setQueryData(queryKeys.storageOptions, { backends: [] });
      let saved: AdminPreferences = {};
      const patches: AdminPreferences[] = [];
      const requests: URL[] = [];
      let releaseFirstPatch!: () => void;
      const firstPatchGate = new Promise<void>((resolve) => {
        releaseFirstPatch = resolve;
      });
      let offline = false;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input), "https://imageshow.test");
        if (url.pathname === "/api/admin/images") {
          requests.push(url);
          return jsonResponse({
            items: [
              { ...image(String(url.searchParams.get("page")).padStart(12, "0")), status: "ready" }
            ],
            total: 3
          });
        }
        if (url.pathname === "/api/admin/preferences") {
          assert.equal(init?.method, "PATCH");
          const patch = JSON.parse(String(init.body)) as AdminPreferences;
          patches.push(patch);
          if (offline) throw new Error("controlled preference offline");
          if (patches.length === 1) await firstPatchGate;
          saved = { ...saved, ...patch };
          return jsonResponse({ preferences: saved });
        }
        if (url.pathname === "/api/admin/ingestion/vocabulary") {
          return jsonResponse({ themes: [], tags: [], authors: [] });
        }
        throw new Error(`unexpected sorting request: ${url.pathname}`);
      };
      const root = createRoot(container);
      const render = async (visit: number) =>
        React.act(async () => {
          root.render(
            React.createElement(
              QueryClientProvider,
              { client },
              React.createElement(
                MemoryRouter,
                { initialEntries: ["/admin/images"] },
                React.createElement(
                  AuthSessionProvider,
                  null,
                  React.createElement(
                    AdminPreferencesProvider,
                    {
                      username,
                      serverPreferences: {},
                      serverPreferencesEtag: 'W/"sort-preferences"',
                      serverPreferencesUpdatedAt: 1
                    },
                    React.createElement(
                      ActionFeedbackProvider,
                      null,
                      React.createElement(
                        React.StrictMode,
                        null,
                        React.createElement(ImageAdmin, { key: visit })
                      )
                    )
                  )
                )
              )
            )
          );
        });
      const viewButtons = () => [
        ...container.querySelectorAll<HTMLButtonElement>(
          '[role="group"][aria-label="图片列表排序与缩略图显示"] > button'
        )
      ];
      const labels = () => viewButtons().map((button) => button.textContent);
      const cacheKey = `imageshow.admin.preferences.${username}`;
      try {
        await render(1);
        await waitFor(() => requests.length === 1, "default sort did not load once in Strict Mode");
        assert.deepEqual(labels(), ["图片", "最新", "填充"]);
        assert.equal(patches.length, 0, "reading defaults must not write preferences");
        await click(buttonWithText("下一页"));
        await waitFor(
          () => requests.at(-1)?.searchParams.get("page") === "2",
          "page 2 did not load"
        );
        await click(viewButtons()[0]!);
        await waitFor(() => patches.length === 1, "field preference was not queued");
        assert.equal(requests.at(-1)?.searchParams.get("page"), "1");
        await click(viewButtons()[1]!);
        await click(viewButtons()[0]!);
        assert.deepEqual(labels(), ["图片", "最旧", "填充"]);
        releaseFirstPatch();
        await waitFor(
          () => saved.image_sort_by === "image_time"
            && saved.image_sort_order === "oldest",
          "queued sort writes did not converge"
        );
        assert.deepEqual(
          patches,
          [
            { image_sort_by: "created_at" },
            { image_sort_order: "oldest" },
            { image_sort_by: "image_time" }
          ],
          "each click saves only its changed dimension"
        );
        assert.equal(
          new Set(
            requests.map(
              (url) => `${url.searchParams.get("sort_by")}/${url.searchParams.get("order")}`
            )
          ).size,
          4
        );
        await render(2);
        assert.deepEqual(labels(), ["图片", "最旧", "填充"], "re-entry must restore the saved selection");
        const requestCount = requests.length;
        localStorage.setItem(
          cacheKey,
          JSON.stringify({
            values: { image_sort_by: "created_at", image_sort_order: "latest" },
            pending: {}
          })
        );
        const storageEvent = new window.Event("storage");
        Object.defineProperties(storageEvent, {
          key: { value: cacheKey },
          storageArea: { value: localStorage }
        });
        await React.act(async () => window.dispatchEvent(storageEvent));
        assert.deepEqual(
          labels(),
          ["图片", "最旧", "填充"],
          "another window must not reorder the active list"
        );
        assert.equal(requests.length, requestCount);
        await render(3);
        assert.deepEqual(
          labels(),
          ["入库", "最新", "填充"],
          "the next visit consumes synchronized preferences"
        );
        offline = true;
        await click(viewButtons()[1]!);
        await waitFor(() => patches.length === 4, "offline preference was not attempted");
        assert.deepEqual(labels(), ["入库", "最旧", "填充"]);
        assert.equal(
          JSON.parse(localStorage.getItem(cacheKey)!).pending.image_sort_order,
          "oldest"
        );
        offline = false;
        await React.act(async () => window.dispatchEvent(new window.Event("online")));
        await waitFor(
          () =>
            patches.length === 5 &&
            Object.keys(JSON.parse(localStorage.getItem(cacheKey)!).pending).length === 0,
          "reconnection did not persist the pending preference"
        );
        await click(buttonWithText("下一页"));
        await waitFor(() => requests.at(-1)?.searchParams.get("page") === "2", "thumbnail scenario page 2");
        await click(container.querySelector<HTMLElement>('.admin-image-card-checkbox-hit-area')!);
        const selectedBefore = container.querySelectorAll('.admin-image-card.is-selected').length;
        assert.equal(selectedBefore, 1);
        const beforeFit = requests.length;
        await click(viewButtons()[2]!);
        await waitFor(() => saved.image_thumbnail_fit === "contain", "thumbnail preference was not saved");
        assert.equal(container.querySelector('.admin-image-grid')?.getAttribute('data-thumbnail-fit'), "contain");
        assert.equal(requests.length, beforeFit, "缩略图模式不重新查询或重置页码");
        assert.equal(container.querySelectorAll('.admin-image-card.is-selected').length, selectedBefore);
        assert.deepEqual(patches.at(-1), { image_thumbnail_fit: "contain" });
        await render(4);
        assert.equal(viewButtons()[2]!.textContent, "完整", "重新进入恢复缩略图偏好");
      } finally {
        releaseFirstPatch();
        await React.act(async () => root.unmount());
        client.clear();
        globalThis.fetch = previousFetch;
      }
    };

    await runSortScenario();
    await runMutationScenario("restore");
    await runMutationScenario("purge");
    await runMutationScenario("purge-unknown");
    await runTrashScenario();
    assert.deepEqual(
      expectedListErrors
        .map((args) => (args[1] as { error?: { code?: string } } | undefined)?.error?.code)
        .filter((code) => code === "controlled_failure"),
      ["controlled_failure", "controlled_failure", "controlled_failure"],
      "三轮受控列表失败必须各报告一次且不得污染测试输出"
    );
    assert.equal(
      expectedListErrors.length,
      4,
      "每次列表失败只能由查询 owner 上报一次"
    );
    assert.equal(
      expectedMutationErrors.length,
      1,
      "未知永久删除请求必须只记录一次 mutation 错误"
    );
    assert.deepEqual(
      expectedEditorErrors.map(args => (args[1] as { error: { message: string } }).error.message),
      ["controlled editor script failure", "controlled editor script failure"]
    );
  } finally {
    console.error = previousConsoleError;
    clearCsrfToken();
    if (elementScrollTo) {
      Object.defineProperty(
        window.HTMLElement.prototype,
        "scrollTo",
        elementScrollTo
      );
    } else {
      delete (window.HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
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
test("[Web/后台] 图片元数据保存按实际字段失效投影并复用权威详情", async (t) => {
  const { QueryClient } = await import("@tanstack/react-query");
  const createClient = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    for (const key of [
      queryKeys.publicImages,
      queryKeys.galleryFacets,
      queryKeys.galleryStats,
      queryKeys.adminImages,
      queryKeys.overview,
      queryKeys.themes,
      queryKeys.tags,
      queryKeys.authors
    ])
      client.setQueryData(key, {});
    for (const identity of [null, "image-admin", "super-admin"]) {
      client.setQueryData([...queryKeys.publicImageDetail, "image-1", identity], {});
    }
    client.setQueryData([...queryKeys.publicImageDetail, "image-2", null], {});
    client.setQueryData([...queryKeys.adminImageInfo, "image-1"], {});
    t.after(() => client.clear());
    return client;
  };
  const invalidated = (
    client: InstanceType<typeof QueryClient>,
    key: readonly unknown[]
  ) =>
    client.getQueryState(key)?.isInvalidated === true;

  const titleClient = createClient();
  await invalidateImageDataAfterMetadataSave(
    titleClient,
    [{ id: "image-1", title: "new", description: "new detail" }],
    [{ id: "image-1" }]
  );
  assert.equal(invalidated(titleClient, queryKeys.adminImages), true);
  assert.equal(invalidated(titleClient, queryKeys.overview), true);
  assert.equal(
    invalidated(titleClient, [...queryKeys.adminImageInfo, "image-1"]),
    true
  );
  assert.equal(invalidated(titleClient, queryKeys.galleryStats), false);
  assert.equal(invalidated(titleClient, queryKeys.galleryFacets), false);
  assert.equal(
    invalidated(titleClient, [...queryKeys.publicImageDetail, "image-1", null]),
    false
  );

  const membershipClient = createClient();
  await invalidateImageDataAfterMetadataSave(
    membershipClient,
    [{ id: "image-1", theme: "night", tags: ["blue"] }],
    [{ id: "image-1" }]
  );
  for (const key of [
    queryKeys.galleryStats,
    queryKeys.galleryFacets,
    queryKeys.themes,
    queryKeys.tags
  ])
    assert.equal(invalidated(membershipClient, key), true, key[0]);
  assert.equal(invalidated(membershipClient, queryKeys.authors), false);

  const missingSnapshotClient = createClient();
  await invalidateImageDataAfterMetadataSave(
    missingSnapshotClient,
    [{ id: "image-1", title: "unconfirmed title", theme: "night" }],
    null
  );
  assert.equal(
    invalidated(
      missingSnapshotClient,
      [...queryKeys.publicImageDetail, "image-1", null]
    ),
    true
  );

  for (const identity of [null, "image-admin", "super-admin"]) {
    assert.equal(
      invalidated(missingSnapshotClient,
        [...queryKeys.publicImageDetail, "image-1", identity]),
      true
    );
  }
  assert.equal(
    invalidated(missingSnapshotClient,
      [...queryKeys.publicImageDetail, "image-2", null]),
    false
  );

  const { invalidateImageDataAfterTrash } =
    await import("../../../../packages/web/src/lib/api/query-invalidation.ts");
  const pendingClient = createClient();
  const lateResponses: Array<() => void> = [];
  const pendingDetails = [null, "image-admin", "super-admin"].map((identity) =>
    pendingClient.fetchQuery({
      queryKey: [...queryKeys.publicImageDetail, "image-1", identity],
      queryFn: () =>
        new Promise<object>((resolve) =>
          lateResponses.push(() => resolve({ original: true }))
        )
    })
  );
  const retired = Promise.allSettled(pendingDetails);
  assert.equal(lateResponses.length, 3);
  await invalidateImageDataAfterTrash(pendingClient, ["image-1"]);
  await retired;
  for (const resolve of lateResponses) resolve();
  await Promise.resolve();
  for (const identity of [null, "image-admin", "super-admin"]) {
    assert.equal(
      pendingClient.getQueryState([...queryKeys.publicImageDetail, "image-1", identity])
        ?.fetchStatus,
      "idle"
    );
    assert.deepEqual(
      pendingClient.getQueryData([...queryKeys.publicImageDetail, "image-1", identity]),
      {},
      "迟到结果不覆盖提交前已退休的详情"
    );
  }
});
