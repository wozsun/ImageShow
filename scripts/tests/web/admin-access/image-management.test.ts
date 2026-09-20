import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  type AdminCheckStatusDto,
  type AdminOverviewDto
} from "../../../../packages/shared/src/browser.ts";
import type {
  PublicImageItem
} from "../../../../packages/web/src/lib/types.ts";
import {
  ApiClientError,
  clearCsrfToken
} from "../../../../packages/web/src/lib/api/client.ts";

import {
  queryKeys
} from "../../../../packages/web/src/lib/api/query-keys.ts";

import {
  imageAdminConfirmationCopy
} from "../../../../packages/web/src/pages/admin/images/useImageAdminOperations.ts";

import {
  adminImageListItem
} from "../../support/web-test-context.ts";
import {
  inputText
} from "../../support/dom-events.ts";

test("[Web/后台访问] 概览渲染当前、历史与未知 Redis 占用且重建结束只刷新一次", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { MemoryRouter } = await import("react-router");
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { Overview } = await import(
    "../../../../packages/web/src/pages/admin/Overview.tsx"
  ).finally(() => cssHooks.deregister());

  const overviewResult = (
    redisCache: AdminOverviewDto["redis_cache"]
  ): AdminOverviewDto => ({
    gallery: 7,
    theme_unset: 0,
    trash: 0,
    total: 7,
    local: 7,
    nonlocal: 0,
    local_image_size: 1_024,
    local_thumb_size: 256,
    nonlocal_image_size: 0,
    nonlocal_thumb_size: 0,
    theme_count: 1,
    backend_count: 1,
    pc: 7,
    mb: 0,
    dark: 7,
    light: 0,
    top_themes: [],
    recent: [],
    redis_cache: redisCache
  });
  const cacheResult = (
    currentBytes: number | null,
    currentMeasuredAt: string | null,
    historicalBytes: number | null,
    historicalMeasuredAt: string | null,
    rebuilding = false
  ): AdminOverviewDto["redis_cache"] => ({
    state: rebuilding ? "rebuilding" : "ready",
    synchronized: !rebuilding,
    rebuilding,
    item_count: 7,
    current_core_memory_bytes: currentBytes,
    current_core_measured_at: currentMeasuredAt,
    last_full_rebuild_core_memory_bytes: historicalBytes,
    last_full_rebuild_measured_at: historicalMeasuredAt
  });
  const checkStatus = (rebuilding: boolean): AdminCheckStatusDto => ({
    postgresql: {
      status: "ok",
      data: {
        connection: "connected",
        version: "18",
        latency_ms: 1,
        ready_images: 7,
        total_images: 7,
        authoritative_revision: "7",
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
          used_memory_bytes: 4_096,
          used_memory_rss_bytes: 8_192,
          fragmentation_ratio: 1
        },
        image_projection: {
          readable: !rebuilding,
          rebuilding,
          synchronized: !rebuilding,
          state: rebuilding ? "rebuilding" : "ready",
          reason: rebuilding ? "rebuilding" : "ready",
          authoritative_revision: "7",
          applied_revision: rebuilding ? "6" : "7",
          item_count: 7,
          processed: rebuilding ? 3 : null,
          total: rebuilding ? 7 : null,
          last_updated_at: "2026-08-15T01:00:00.000Z",
          full_rebuild_started_at: "2026-08-15T00:59:00.000Z",
          full_rebuild_completed_at: rebuilding
            ? null
            : "2026-08-15T01:00:00.000Z",
          full_rebuild_duration_ms: rebuilding ? null : 60_000,
          last_full_rebuild_core_memory_bytes: 2_048,
          last_full_rebuild_measured_at: "2026-08-15T01:00:00.000Z",
          recent_errors: { core: null, derived: null }
        }
      },
      error: null
    }
  });
  const renderOverviewMarkup = (overview: AdminOverviewDto) => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } }
    });
    client.setQueryData(queryKeys.overview, overview);
    const previousReact = Object.getOwnPropertyDescriptor(globalThis, "React");
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      writable: true,
      value: React
    });
    try {
      return renderToStaticMarkup(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/admin"] },
          React.createElement(Overview, { canManageStorage: true })
        )
      ));
    } finally {
      client.clear();
      if (previousReact) {
        Object.defineProperty(globalThis, "React", previousReact);
      } else {
        delete (globalThis as { React?: unknown }).React;
      }
    }
  };

  const currentMarkup = renderOverviewMarkup(overviewResult(cacheResult(
    1_024,
    "2026-08-15T01:00:01.000Z",
    2_048,
    "2026-08-15T01:00:00.000Z"
  )));
  assert.match(currentMarkup, />1\.0 KB · 已同步</);
  assert.match(
    currentMarkup,
    /title="当前核心图片投影占用 1\.0 KB，测量于 [^"]+"/
  );
  const historicalMarkup = renderOverviewMarkup(overviewResult(cacheResult(
    null,
    null,
    2_048,
    "2026-08-15T01:00:00.000Z"
  )));
  assert.match(historicalMarkup, />2\.0 KB · 已同步</);
  assert.match(
    historicalMarkup,
    /title="当前核心占用未知；最近完整重建核心占用 2\.0 KB，测量于 [^"]+"/
  );
  const unknownMarkup = renderOverviewMarkup(overviewResult(cacheResult(
    null,
    null,
    null,
    null
  )));
  assert.match(unknownMarkup, />— · 已同步</);
  assert.match(unknownMarkup, /title="当前核心图片投影占用未知"/);

  const { document, window } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  );
  const initialOverview = overviewResult(cacheResult(
    null,
    null,
    2_048,
    "2026-08-15T01:00:00.000Z",
    true
  ));
  const refreshedOverview = overviewResult(cacheResult(
    3_072,
    "2026-08-15T01:01:00.000Z",
    2_048,
    "2026-08-15T01:00:00.000Z"
  ));
  let statusRequests = 0;
  let overviewRequests = 0;
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const fetchStub = async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === "/api/admin/check/status") {
      statusRequests += 1;
      return jsonResponse(checkStatus(true));
    }
    if (path === "/api/admin/overview") {
      overviewRequests += 1;
      return jsonResponse(refreshedOverview);
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
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  client.setQueryData(queryKeys.overview, initialOverview);
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
    assert.fail("overview transition did not settle");
  };

  try {
    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/admin"] },
          React.createElement(Overview, { canManageStorage: true })
        )
      ));
    });
    await settleUntil(() => (
      statusRequests === 1
      && client.getQueryState(queryKeys.overview)?.isInvalidated === true
    ));
    assert.equal(overviewRequests, 0, "重建中只标脏，不得刷新 overview");

    await React.act(async () => {
      client.setQueryData(queryKeys.adminCheckStatus, checkStatus(false));
    });
    await settleUntil(() => overviewRequests === 1);
    await settleUntil(() => container.textContent?.includes("3.0 KB · 已同步") === true);
    await React.act(async () => {
      client.setQueryData(queryKeys.adminCheckStatus, checkStatus(false));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(
      overviewRequests,
      1,
      "rebuilding→ready 后只允许唯一 overview owner 刷新一次"
    );
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
test("[Web/后台访问] 图片详情根据链接显示原图并保持来源、标题和后台入口", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
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
  Object.assign(window, {
    requestAnimationFrame,
    cancelAnimationFrame,
    matchMedia,
    scrollTo() {},
    scrollY: 0,
    innerWidth: 1280,
    innerHeight: 720
  });
  const localStorageValues = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageValues.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageValues.delete(key);
    },
    clear: () => localStorageValues.clear()
  };
  Object.assign(window, { localStorage });
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

  const fetchStub = async (input: RequestInfo | URL) => {
    throw new Error(`图片详情真值表不应发起请求: ${String(input)}`);
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
    localStorage,
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
      "../../../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { ImageDetailModal } = await import(
      "../../../../packages/web/src/components/image/ImageDetailModal.tsx"
    );
    const container = document.getElementById("root");
    assert.ok(container);
    const publicItem = (originalUrl: string | null): PublicImageItem => ({
      id: "00000000-0000-7000-8000-000000000544",
      title: "原图入口真值表",
      description: "",
      source: null,
      object_url: "https://img.example.com/images/full/544.webp",
      thumb_url: "",
      device: "pc",
      brightness: "dark",
      theme: "night",
      author: "",
      tags: ["blue", "stars"],
      width: 1600,
      height: 900,
      original_url: originalUrl,
      image_time: "2026-09-01T00:00:00.000Z"
    });
    type AuthScenario = "pending" | "expired" | "guest" | "image" | "super";
    type OriginalActionSnapshot = Readonly<{
      titleText: string;
      titleHref: string | null;
      titleFocusable: boolean;
      present: boolean;
      href: string | null;
      ariaDisabled: string | null;
      sourceHref: string | null;
      sourceAriaDisabled: string | null;
      publicProperties: string;
      actionClasses: string[];
    }>;
    const renderScenario = async ({
      auth,
      originalUrl = "https://img.example.com/images/original/00000000-0000-7000-8000-000000000544",
      sourceUrl = null,
      admin = false,
      objectUrl,
      detailLoading = false,
      detailError = ""
    }: {
      auth: AuthScenario;
      originalUrl?: string | null;
      sourceUrl?: string | null;
      admin?: boolean;
      objectUrl?: string;
      detailLoading?: boolean;
      detailError?: string;
    }): Promise<OriginalActionSnapshot> => {
      localStorage.clear();
      const client = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
            refetchOnWindowFocus: false
          }
        }
      });
      client.setQueryData(queryKeys.galleryFacets, {
        themes: [{ slug: "night", display_name: "夜景" }],
        tags: [
          { slug: "blue", display_name: "蓝色" },
          { slug: "stars", display_name: "星空" }
        ],
        authors: []
      });
      if (auth === "guest") {
        client.setQueryData(queryKeys.me, {
          authenticated: false,
          altcha_enabled: false,
          login_background: ""
        });
      } else if (auth === "image" || auth === "super") {
        client.setQueryData(queryKeys.me, {
          authenticated: true,
          username: `${auth}-original-action-test`,
          role: auth,
          permissions: [],
          csrf_token: `${auth}-original-action-csrf`,
          application_version: "current-test",
          preferences: {},
          preferences_etag: `W/\"${auth}-original-action-preferences\"`,
          version_settings: { enabled: true, link_enabled: true }
        });
      } else if (auth === "expired") {
        await client.fetchQuery({
          queryKey: queryKeys.me,
          queryFn: async () => {
            throw new ApiClientError("管理员登录已失效", 401);
          },
          retry: false
        }).catch(() => undefined);
      }

      const root = createRoot(container);
      try {
        await React.act(async () => {
          root.render(React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(
              MemoryRouter,
              { initialEntries: ["/"] },
              React.createElement(
                AuthSessionProvider,
                null,
                admin
                  ? React.createElement(ImageDetailModal, {
                      item: adminImageListItem({
                        id: publicItem(originalUrl).id,
                        status: "deleted",
                        original_url: originalUrl
                      }),
                      admin: true,
                      storageLabel: "本地存储",
                      onClose() {}
                    })
                  : React.createElement(ImageDetailModal, {
                      item: { ...publicItem(originalUrl), source: sourceUrl, ...(objectUrl === undefined ? {} : { object_url: objectUrl }) },
                      admin: false,
                      detailLoading,
                      detailError,
                      onClose() {}
                    })
              )
            )
          ));
          await Promise.resolve();
        });
        const original = document.querySelector<HTMLAnchorElement>(
          ".image-detail-original"
        );
        const source = document.querySelector<HTMLAnchorElement>(
          ".image-detail-source"
        );
        return {
          titleText: document.querySelector(".image-detail-title-row h2")?.textContent ?? "",
          titleHref: document.querySelector(".image-detail-title-link")?.getAttribute("href") ?? null,
          titleFocusable: Boolean(document.querySelector('.image-detail-title-row h2 a[href], .image-detail-title-row h2 [tabindex]')),
          present: Boolean(original),
          href: original?.getAttribute("href") ?? null,
          ariaDisabled: original?.getAttribute("aria-disabled") ?? null,
          sourceHref: source?.getAttribute("href") ?? null,
          sourceAriaDisabled: source?.getAttribute("aria-disabled") ?? null,
          publicProperties: document.querySelector(
            ".image-detail-public-properties"
          )?.textContent ?? "",
          actionClasses: [...document.querySelectorAll<HTMLElement>(
            ".image-detail-actions > a"
          )].map((element) => element.className)
        };
      } finally {
        await React.act(async () => root.unmount());
        client.clear();
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      }
    };

    for (const state of [
      { objectUrl: "", detailLoading: true },
      { objectUrl: "", detailError: "详情加载失败" },
      { objectUrl: "  " }
    ]) {
      const pendingTitle = await renderScenario({ auth: "guest", ...state });
      assert.equal(pendingTitle.titleText, "原图入口真值表");
      assert.equal(pendingTitle.titleHref, null, "占位标题不得生成当前页空链接");
      assert.equal(pendingTitle.titleFocusable, false, "无直链标题不占用 Tab 焦点");
    }
    const loadedTitle = await renderScenario({ auth: "guest" });
    assert.equal(loadedTitle.titleHref, "https://img.example.com/images/full/544.webp");
    assert.equal(loadedTitle.titleFocusable, true);

    for (const auth of ["pending", "expired", "guest"] as const) {
      assert.equal((await renderScenario({
        auth
      })).present, false, `${auth} 即使残留原图链接也不显示按钮`);
    }
    const guestDetail = await renderScenario({
      auth: "guest",
    });
    assert.equal(guestDetail.present, false);
    assert.equal(
      guestDetail.href,
      null
    );
    assert.equal(
      guestDetail.sourceHref,
      null,
      "公开卡片不应把任意长度来源地址预载进列表响应"
    );
    assert.equal(guestDetail.sourceAriaDisabled, "true");
    assert.match(guestDetail.publicProperties, /主题夜景/);
    assert.match(guestDetail.publicProperties, /标签蓝色星空/);
    assert.deepEqual(
      guestDetail.actionClasses.map((className) => (
        className.includes("image-detail-source") ? "source" : "original"
      )),
      ["source"],
      "访客仅显示来源入口"
    );
    for (const auth of ["image", "super"] as const) {
      const detail = await renderScenario({ auth });
      assert.equal(detail.present, true, `${auth} 管理员使用详情提供的原图链接`);
      assert.match(detail.href!, /\/images\/original\//);
      assert.deepEqual(detail.actionClasses.map(name => name.includes("image-detail-source") ? "source" : "original"), ["source", "original"]);
    }
    assert.equal((await renderScenario({
      auth: "pending",
      admin: true
    })).present, true, "后台调用方必须继续由 admin 上下文显示原图");
    const unavailableOriginal = await renderScenario({
      auth: "guest",
      originalUrl: null
    });
    assert.equal(unavailableOriginal.present, false);
    assert.equal(unavailableOriginal.href, null);
    assert.equal(unavailableOriginal.ariaDisabled, null);
    for (const auth of ["guest", "image", "super"] as const) {
      for (const state of [{ detailLoading: true }, { detailError: "详情加载失败" }, {}]) {
        const pending = await renderScenario({ auth, originalUrl: null, ...state });
        assert.equal(pending.present, false);
        assert.equal(pending.actionClasses.length, 1);
        assert.ok(pending.actionClasses[0]!.includes("image-detail-source"));
        assert.equal(pending.sourceAriaDisabled, "true");
      }
    }
    const sourceReady = await renderScenario({ auth: "guest", originalUrl: null, sourceUrl: "https://source.example/item" });
    assert.equal(sourceReady.sourceHref, "https://source.example/item");
    assert.equal(sourceReady.sourceAriaDisabled, "false");
    const deleted = await renderScenario({ auth: "super", admin: true, originalUrl: "https://img.example.com/images/original/00000000-0000-7000-8000-000000000544" });
    assert.equal(deleted.href, "https://img.example.com/images/original/00000000-0000-7000-8000-000000000544");
  } finally {
    window.HTMLElement.prototype.focus = originalFocus;
    window.HTMLElement.prototype.blur = originalBlur;
    deregisterCssHooks();
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
test("[Web/后台访问] 作者列表空闲时保存采用权威 DTO，新建前置且不追加列表读取", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  );
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
  Object.assign(window, {
    matchMedia,
    innerWidth: 1280,
    innerHeight: 720,
    scrollTo() {}
  });
  let authorGets = 0;
  let authorPosts = 0;
  const requestedAuthorPaths: string[] = [];
  const submittedBodies: unknown[] = [];
  const initialAuthor = {
    slug: "author-profile-test",
    display_name: "Profile Test",
    link: "https://example.com/profile",
    sort_order: 1,
    image_count: 0,
    derived_identity: null
  };
  const committedAuthor = {
    ...initialAuthor,
    link: "https://weibo.com/u/4444444444",
    derived_identity: { provider: "weibo", id: "4444444444" }
  };
  const createdAuthor = { ...initialAuthor, slug: "author-new-first", display_name: "New first", sort_order: 2 };
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://imageshow.test").pathname;
    const method = String(init?.method ?? "GET").toUpperCase();
    requestedAuthorPaths.push(`${method} ${path}`);
    if (path === "/api/admin/authors" && method === "POST") {
      return jsonResponse({ ok: true, item: createdAuthor });
    }
    if (path === "/api/admin/authors" && method === "GET") {
      authorGets += 1;
      return jsonResponse({ ok: true, items: [initialAuthor] });
    }
    if (
      path === "/api/admin/authors/author-profile-test"
      && method === "POST"
    ) {
      authorPosts += 1;
      submittedBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ ok: true, item: committedAuthor });
    }
    throw new Error(`unexpected author profile request: ${method} ${path}`);
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
      "../../../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { ActionFeedbackProvider } = await import(
      "../../../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx"
    );
    const { VocabularyAdmin } = await import(
      "../../../../packages/web/src/pages/admin/VocabularyAdmin.tsx"
    );
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Number.POSITIVE_INFINITY,
          refetchOnWindowFocus: false
        }
      }
    });
    client.setQueryData(queryKeys.me, {
      authenticated: true,
      username: "author-profile-test",
      role: "image",
      permissions: [],
      csrf_token: "author-profile-csrf",
      application_version: "current-test",
      preferences: {},
      preferences_etag: 'W/"author-profile-preferences"',
      version_settings: { enabled: true, link_enabled: true }
    });
    client.setQueryData(queryKeys.settings, {
      settings: { admin: { image_page_size: 20 } }
    });
    for (const key of [
      queryKeys.galleryFacets,
      queryKeys.galleryStats,
      queryKeys.ingestionVocabulary
    ]) client.setQueryData(key, {});
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
      }
      assert.fail(
        `author profile save did not settle; requests=${requestedAuthorPaths.join(",")}; html=${container.innerHTML}`
      );
    };
    try {
      await React.act(async () => {
        root.render(React.createElement(
          React.StrictMode,
          null,
          React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(
              MemoryRouter,
              { initialEntries: ["/admin/authors"] },
              React.createElement(
                AuthSessionProvider,
                null,
                React.createElement(
                  ActionFeedbackProvider,
                  null,
                  React.createElement(VocabularyAdmin, { kind: "authors" })
                )
              )
            )
          )
        ));
      });
      await settleUntil(() => authorGets >= 1 && Boolean(
        container.querySelector("input[aria-label='作者 author-profile-test 链接']")
      ));
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await settleUntil(() => client.getQueryState(queryKeys.authors)?.fetchStatus === "idle");
      const authorGetsBeforeSave = authorGets;
      const linkInput = container.querySelector<HTMLInputElement>(
        "input[aria-label='作者 author-profile-test 链接']"
      );
      const card = container.querySelector<HTMLElement>(".entity-card");
      assert.ok(linkInput);
      assert.ok(card);
      assert.equal(linkInput.getAttribute("title"), null);
      assert.equal(card.querySelectorAll(".entity-card-link-row").length, 1);
      const initialCardChildren = card.childElementCount;

      await React.act(async () => {
        inputText(
          window as unknown as Window,
          linkInput,
          committedAuthor.link
        );
        await Promise.resolve();
      });
      assert.equal(linkInput.value, committedAuthor.link, "DOM 输入事件必须提交新链接值");
      await settleUntil(() => [...container.querySelectorAll("button")].some(
        (button) => button.textContent?.includes("保存")
      ));
      const saveButton = [...container.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes("保存"));
      assert.ok(saveButton);
      await React.act(async () => {
        saveButton.dispatchEvent(new window.Event("click", {
          bubbles: true,
          cancelable: true
        }));
        await Promise.resolve();
      });
      await settleUntil(() => (
        authorPosts === 1
        && linkInput.getAttribute("title")
          === "平台: weibo; UID: 4444444444"
      ));
      assert.equal(authorGets, authorGetsBeforeSave, "保存成功不得追加作者列表 GET");
      assert.deepEqual(submittedBodies, [{
        display_name: "Profile Test",
        link: "https://weibo.com/u/4444444444"
      }]);
      assert.deepEqual(
        client.getQueryData<{ items: unknown[] }>(queryKeys.authors),
        { ok: true, items: [committedAuthor] }
      );
      assert.equal(linkInput.value, committedAuthor.link);
      assert.equal(linkInput.getAttribute("title"), "平台: weibo; UID: 4444444444");
      assert.equal(authorGets, authorGetsBeforeSave);
      assert.equal(card.childElementCount, initialCardChildren);
      assert.equal(card.querySelectorAll(".entity-card-link-row").length, 1);
      assert.equal(card.querySelectorAll("[role='tooltip']").length, 0);
      assert.equal(
        client.getQueryState(queryKeys.authors)?.isInvalidated,
        false
      );
      for (const key of [
        queryKeys.galleryFacets,
        queryKeys.galleryStats,
        queryKeys.ingestionVocabulary
      ]) {
        assert.equal(client.getQueryState(key)?.isInvalidated, true, key[0]);
      }
      const createInput = container.querySelector<HTMLInputElement>(".entity-create-slug");
      const createForm = container.querySelector(".admin-create-form");
      assert.ok(createInput);
      assert.ok(createForm);
      await React.act(async () => { inputText(window as unknown as Window, createInput, createdAuthor.slug); });
      await React.act(async () => {
        createForm.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      });
      await settleUntil(() => container.querySelector<HTMLInputElement>(".entity-card input")?.value === createdAuthor.slug);
      assert.deepEqual(client.getQueryData(queryKeys.authors), { ok: true, items: [createdAuthor, committedAuthor] });
      assert.equal(authorGets, authorGetsBeforeSave, "新建直接前置权威 DTO，不追加列表 GET");
    } finally {
      await React.act(async () => root.unmount());
      client.clear();
    }
  } finally {
    deregisterCssHooks();
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
test("[Web/后台访问] 图片回收站永久删除确认区分已选与全部范围", () => {
  const manyPurge = imageAdminConfirmationCopy({
    kind: "purge",
    request: { scope: "selected", ids: ["one", "two"] }
  });
  const allPurge = imageAdminConfirmationCopy({
    kind: "purge",
    request: { scope: "all" }
  });

  assert.equal(manyPurge?.title, "确认删除已选图片");
  assert.match(manyPurge?.description ?? "", /2 张/);
  assert.equal(manyPurge?.label, "永久删除");
  assert.equal(allPurge?.title, "确认清空回收站");
  assert.match(allPurge?.description ?? "", /之后才移入回收站/);
  assert.equal(allPurge?.label, "永久删除");
});
test("[Web/后台访问] 单图移入回收站按钮必须在同一按钮上点击两次才执行", async () => {
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
    const { TwoStepConfirmIconButton } = await import(
      "../../../../packages/web/src/components/actions/TwoStepConfirmIconButton.tsx"
    );
    const { ADMIN_ICONS } = await import(
      "../../../../packages/web/src/components/icon/admin-icons.generated.ts"
    );
    let confirmed = 0;
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(TwoStepConfirmIconButton, {
        idleIcon: "delete-bin-6-line",
        confirmIcon: "delete-bin-2-line",
        busyIcon: "delete-bin-5-line",
        idleLabel: "删除图片",
        confirmLabel: "再次点击确认删除图片",
        busyLabel: "删除中",
        onConfirm: () => { confirmed += 1; }
      }));
      await Promise.resolve();
    });
    const button = container.querySelector("button");
    assert.ok(button);
    await React.act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(confirmed, 0);
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.equal(button.getAttribute("aria-label"), "再次点击确认删除图片");
    await React.act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(confirmed, 1);
    assert.equal(button.getAttribute("aria-pressed"), "false");
    await React.act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(button.getAttribute("aria-pressed"), "true");
    await React.act(async () => {
      document.body.dispatchEvent(new window.Event("pointerdown", {
        bubbles: true
      }));
      await Promise.resolve();
    });
    assert.equal(
      button.getAttribute("aria-pressed"),
      "false",
      "外部 pointerdown 必须解除无计时二次确认"
    );
    await React.act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
      await Promise.resolve();
    });
    assert.equal(confirmed, 1, "解除后下一次点击只能重新 armed");
    await React.act(async () => {
      root.render(React.createElement(TwoStepConfirmIconButton, {
        idleIcon: "delete-bin-6-line",
        confirmIcon: "delete-bin-2-line",
        busyIcon: "delete-bin-5-line",
        idleLabel: "删除图片",
        confirmLabel: "再次点击确认删除图片",
        busyLabel: "删除中",
        busy: true,
        disabled: true,
        onConfirm: () => { confirmed += 1; }
      }));
      await Promise.resolve();
    });
    assert.equal(button.getAttribute("aria-label"), "删除中");
    assert.equal(
      button.querySelector("path")?.getAttribute("d"),
      ADMIN_ICONS["delete-bin-5-line"]
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
