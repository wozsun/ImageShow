import "../../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { type IngestionVocabularyDto } from "../../../../packages/shared/src/browser.ts";

import { authExpiredEvent, clearCsrfToken } from "../../../../packages/web/src/lib/api/client.ts";

import { queryKeys } from "../../../../packages/web/src/lib/api/query-keys.ts";

import {
  advanceAdminColorSchemeCycle,
  nextAdminColorScheme,
  resolveUiColorContext,
  type AdminColorSchemeCycle
} from "../../../../packages/web/src/lib/ui/color-scheme.ts";
import {
  parseAdminPaginationPage,
  releaseAdminPaginationSubmission,
  resolveAdminPaginationCommit,
  shouldCommitAdminPaginationInput
} from "../../../../packages/web/src/components/navigation/admin-pagination-model.ts";
import { adminNavigationForRole } from "../../../../packages/web/src/pages/admin/shell/AdminNavigation.tsx";

import {
  ImageListSelectionController,
  isImageSelectionPreservingTarget
} from "../../../../packages/web/src/pages/admin/images/image-list-selection.ts";

import {
  imageAdminDoubleRowMaxWidth,
  imageAdminFilterDomGroups,
  isImageAdminDoubleRowWidth
} from "../../../../packages/web/src/pages/admin/images/ImageAdminFilters.tsx";
import {
  galleryCard,
  adminImageListItem,
  createConfigStreamHarness
} from "../../support/web-test-context.ts";
import { inputText, dispatchDomEvent } from "../../support/dom-events.ts";
import { installProperties } from "../../support/property-descriptors.ts";

test("[Web/后台访问] 无会话上下文的公开详情保持访客身份并隔离管理员缓存", async (t) => {
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css")
        ? { format: "module", source: "", shortCircuit: true }
        : next(url, context);
    }
  });
  t.after(() => hooks.deregister());
  const { PublicImageDetail } =
    await import("../../../../packages/web/src/components/image/PublicImageDetail.tsx");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const h = await createConfigStreamHarness(t);
  Object.assign(h.window, { scrollTo() {}, scrollY: 0 });
  const storage = new Map([["site_session_hint", "1"]]);
  t.after(
    installProperties(globalThis, {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
        removeItem: (key: string) => {
          storage.delete(key);
        }
      }
    })
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  t.after(() => {
    client.clear();
    clearCsrfToken();
  });
  const id = "00000000-0000-7000-8000-000000000545";
  const item = { ...adminImageListItem({ id }), original_url: `/images/original/${id}` };
  const auth = {
    authenticated: true,
    username: "embedded-test-admin",
    role: "super",
    permissions: [],
    csrf_token: "embedded-test-csrf",
    preferences: {},
    preferences_etag: 'W/"embedded-test"'
  };
  client.setQueryData(queryKeys.me, auth);
  client.setQueryData(queryKeys.galleryFacets, { themes: [], tags: [], authors: [] });
  client.setQueryData([...queryKeys.adminImageInfo, id], { item });
  client.setQueryData([...queryKeys.publicImageDetail, id, auth.username], { item });
  await h.render(
    h.React.createElement(
      h.React.StrictMode,
      null,
      h.React.createElement(
        QueryClientProvider,
        { client },
        h.React.createElement(PublicImageDetail, {
          card: galleryCard(id),
          onClose() {},
          returnFocusRef: { current: null }
        })
      )
    )
  );
  assert.deepEqual(
    h.pending.map((request) => request.path),
    [`/api/images/${id}`]
  );
  assert.equal(h.pending[0]!.credentials, "omit");
  await h.respond(0, { ok: true, item: { ...item, original_url: null } });
  assert.ok(h.document.querySelector('[role="dialog"]'));
  assert.equal(h.document.querySelector(".image-detail-original"), null);
  await h.React.act(async () => {
    client.setQueryData(queryKeys.me, { ...auth, username: "another-embedded-test-admin" });
    h.window.dispatchEvent(new Event(authExpiredEvent));
  });
  await h.flush();
  assert.equal(h.document.querySelector(".image-detail-original"), null);
  assert.deepEqual(
    h.pending.map((request) => request.path),
    [`/api/images/${id}`]
  );
  assert.equal(storage.get("site_session_hint"), "1", "访客详情不修改普通页面的登录提示");
  await h.render(null);
});

test("[Web/后台访问] 公开详情等待首次认证，按身份读取并隔离迟到结果", async (t) => {
  const { registerHooks } = await import("node:module");
  const hooks = registerHooks({
    load(url, context, next) {
      return url.endsWith(".css")
        ? { format: "module", source: "", shortCircuit: true }
        : next(url, context);
    }
  });
  t.after(() => hooks.deregister());
  const { PublicImageDetail } =
    await import("../../../../packages/web/src/components/image/PublicImageDetail.tsx");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { MemoryRouter } = await import("react-router");
  const { AuthSessionProvider } =
    await import("../../../../packages/web/src/hooks/useAuthSession.tsx");
  const { clearAdminCacheAfterLogin } =
    await import("../../../../packages/web/src/lib/api/query-invalidation.ts");
  const h = await createConfigStreamHarness(t, { honorAbort: false });
  Object.assign(h.window, { scrollTo() {}, scrollY: 0 });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  });
  t.after(() => {
    client.clear();
    clearCsrfToken();
  });
  client.setQueryData(queryKeys.galleryFacets, { themes: [], tags: [], authors: [] });
  const id = "00000000-0000-7000-8000-000000000544";
  const card = galleryCard(id);
  const url = `/images/original/${id}`;
  const item = { ...adminImageListItem({ id }), original_url: url };
  client.setQueryData([...queryKeys.adminImageInfo, id], { item });
  const authenticated = (username: string) => ({
    ok: true,
    authenticated: true,
    username,
    role: "super",
    permissions: [],
    csrf_token: "detail-test",
    application_version: "current-test",
    preferences: {},
    preferences_etag: 'W/"detail-test"',
    version_settings: { enabled: true, link_enabled: true }
  });
  const guest = { ok: true, authenticated: false, altcha_enabled: false, login_background: "" };
  const detailRequests = () => h.pending.filter((request) => request.path === `/api/images/${id}`);
  const originalLink = () =>
    h.document.querySelector<HTMLAnchorElement>(".image-detail-original")?.getAttribute("href") ??
    null;
  const settle = async (predicate: () => boolean) => {
    for (let attempt = 0; attempt < 60 && !predicate(); attempt++) await h.flush();
    assert.ok(predicate(), `详情未收敛: ${h.pending.map((request) => request.path).join(", ")}`);
  };
  await h.render(
    h.React.createElement(
      h.React.StrictMode,
      null,
      h.React.createElement(
        QueryClientProvider,
        { client },
        h.React.createElement(
          MemoryRouter,
          { initialEntries: ["/admin"] },
          h.React.createElement(
            AuthSessionProvider,
            null,
            h.React.createElement(PublicImageDetail, {
              card,
              onClose() {},
              returnFocusRef: { current: null }
            })
          )
        )
      )
    )
  );
  const authRequest = h.pending.findLast(
    (request) => request.path === "/api/admin/auth/me" && !request.signal?.aborted
  );
  assert.ok(authRequest);
  assert.equal(detailRequests().length, 0, "首次认证完成前不发送访客详情再重复读取管理员详情");
  await h.React.act(async () => authRequest.resolve(Response.json(authenticated("admin-a"))));
  await settle(() => detailRequests().length === 1);
  assert.equal(detailRequests()[0]!.credentials, "same-origin");
  await h.React.act(async () => detailRequests()[0]!.resolve(Response.json({ ok: true, item })));
  await settle(() => originalLink() === url);
  assert.equal(detailRequests().length, 1, "StrictMode 重挂共用详情请求");
  const authCount = h.pending.filter((request) => request.path === "/api/admin/auth/me").length;

  await h.React.act(async () => client.setQueryData(queryKeys.me, guest));
  await settle(() => detailRequests().length === 2);
  assert.equal(originalLink(), null, "退出后立即丢弃管理员详情");
  assert.equal(detailRequests()[1]!.credentials, "omit");
  // Switch identity while the visitor request is still in flight.
  await h.React.act(async () => {
    clearAdminCacheAfterLogin(client);
    client.setQueryData(queryKeys.me, authenticated("admin-b"));
  });
  await settle(() => detailRequests().length === 3);
  await h.React.act(async () => detailRequests()[2]!.resolve(Response.json({ ok: true, item })));
  await settle(() => originalLink() === url);
  await h.React.act(async () =>
    detailRequests()[1]!.resolve(Response.json({ ok: true, item: { ...item, original_url: null } }))
  );
  await h.flush();
  assert.equal(originalLink(), url, "迟到访客结果不覆盖新登录身份");

  await h.React.act(async () => {
    void client.invalidateQueries({ queryKey: [...queryKeys.publicImageDetail, id] });
  });
  await settle(() => detailRequests().length === 4);
  await h.React.act(async () => client.setQueryData(queryKeys.me, guest));
  await settle(() => detailRequests().length === 5);
  await h.React.act(async () =>
    detailRequests()[4]!.resolve(Response.json({ ok: true, item: { ...item, original_url: null } }))
  );
  await settle(
    () => client.getQueryState([...queryKeys.publicImageDetail, id, null])?.status === "success"
  );
  await h.React.act(async () => detailRequests()[3]!.resolve(Response.json({ ok: true, item })));
  await h.flush();
  assert.equal(originalLink(), null, "迟到管理员结果不重新显示访客原图按钮");
  assert.equal(
    h.pending.filter((request) => request.path === "/api/admin/auth/me").length,
    authCount
  );
  await h.render(null);
  await h.flush();
});

test("[Web/后台访问] 图片管理保留连续选择、直接分页和管理员外观语义", () => {
  const pageIds = ["a", "b", "c", "d", "e"];
  const controller = new ImageListSelectionController();
  let selected = controller.update({
    pageIds,
    selectedIds: [],
    targetId: "b",
    checked: true,
    extendRange: false,
    busy: false
  });
  selected = controller.update({
    pageIds,
    selectedIds: selected,
    targetId: "e",
    checked: true,
    extendRange: true,
    busy: false
  });
  assert.deepEqual(selected, ["b", "c", "d", "e"]);
  selected = controller.update({
    pageIds,
    selectedIds: selected,
    targetId: "d",
    checked: false,
    extendRange: true,
    busy: false
  });
  assert.deepEqual(selected, ["e"]);
  assert.strictEqual(
    controller.update({
      pageIds,
      selectedIds: selected,
      targetId: "a",
      checked: true,
      extendRange: false,
      busy: true
    }),
    selected
  );
  assert.equal(isImageSelectionPreservingTarget({ closest: () => ({}) }), true);
  assert.equal(isImageSelectionPreservingTarget({ closest: () => null }), false);

  assert.equal(parseAdminPaginationPage("012", 12), 12);
  assert.equal(parseAdminPaginationPage("13", 12), null);
  const firstCommit = resolveAdminPaginationCommit({
    value: "003",
    page: 1,
    totalPages: 5,
    submittedPage: null
  });
  assert.deepEqual(firstCommit, {
    value: "3",
    invalid: false,
    submittedPage: 3,
    targetPage: 3
  });
  assert.equal(
    resolveAdminPaginationCommit({
      value: firstCommit.value,
      page: 1,
      totalPages: 5,
      submittedPage: firstCommit.submittedPage
    }).targetPage,
    null
  );
  assert.equal(releaseAdminPaginationSubmission(true, false, 3), null);
  assert.equal(shouldCommitAdminPaginationInput("Enter", false, 13), true);
  assert.equal(shouldCommitAdminPaginationInput("Enter", true, 13), false);

  const navigationModules = (role: "image" | "super") =>
    new Set(
      Object.values(adminNavigationForRole(role)).flatMap((entries) =>
        entries.flatMap((entry) =>
          entry.kind === "link"
            ? [entry.routeModule].filter((value) => value !== undefined)
            : entry.items.flatMap((item) => (item.routeModule ? [item.routeModule] : []))
        )
      )
    );
  assert.deepEqual([...navigationModules("image")].sort(), [
    "account",
    "check",
    "images",
    "overview",
    "vocabulary"
  ]);
  assert.deepEqual([...navigationModules("super")].sort(), [
    "account",
    "advancedConfig",
    "check",
    "images",
    "logs",
    "overview",
    "site",
    "storage",
    "users",
    "vocabulary"
  ]);

  assert.equal(resolveUiColorContext("public", "light", false), "dark");
  assert.equal(resolveUiColorContext("admin", "system", true), "dark");
  assert.equal(resolveUiColorContext("admin", "system", false), "light");
  let colorScheme: "system" | "dark" | "light" = "system";
  let cycle: AdminColorSchemeCycle | null = null;
  const sequence: Array<"system" | "dark" | "light"> = [colorScheme];
  for (let index = 0; index < 3; index += 1) {
    const next = nextAdminColorScheme(colorScheme, "dark", cycle);
    cycle = advanceAdminColorSchemeCycle(colorScheme, "dark", next);
    colorScheme = next;
    sequence.push(colorScheme);
  }
  assert.deepEqual(sequence, ["system", "light", "dark", "system"]);
});
test("[Web/后台访问] 后台颜色偏好在首个布局观察前接管 bootstrap 颜色域", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html data-ui-context=bootstrap data-color-scheme=dark><head>" +
      "<meta name=color-scheme content=dark><meta name=theme-color content=#070b15>" +
      "</head><body><div id=root></div></body></html>"
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
  Object.assign(window, { matchMedia });

  const getComputedStyle = () => ({
    backgroundColor: "rgb(255, 255, 255)",
    getPropertyValue: (name: string) => (name === "--color-browser-canvas" ? "#ffffff" : "")
  });
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
    getComputedStyle,
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
    const { useAdminColorScheme } =
      await import("../../../../packages/web/src/hooks/useAdminColorScheme.ts");
    const layoutObservations: string[] = [];

    function Harness() {
      const resolved = useAdminColorScheme("light");
      React.useLayoutEffect(() => {
        layoutObservations.push(
          `${document.documentElement.dataset.uiContext}/` +
            `${document.documentElement.dataset.colorScheme}/${resolved}`
        );
      }, [resolved]);
      return null;
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    assert.deepEqual(layoutObservations, ["admin/light/light"]);
    assert.equal(
      document.querySelector('meta[name="color-scheme"]')?.getAttribute("content"),
      "light"
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
test("[Web/后台访问] 动画关闭捕获最新回调并在请求阶段冻结完成动作", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let reduceMotion = true;
  const matchMedia = (query: string) => ({
    matches: reduceMotion && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  Object.assign(window, { matchMedia });
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
  try {
    const { createRoot } = await import("react-dom/client");
    const { useAnimatedClose } =
      await import("../../../../packages/web/src/hooks/useAnimatedClose.ts");
    const closedRevisions: number[] = [];
    const preparedRevisions: number[] = [];
    let commitCompletedRevision: ((revision: number) => void) | undefined;
    let finishAnimatedClose: (() => void) | undefined;
    const animationTarget = document.createElement("div");

    function Harness() {
      const [completedRevision, setCompletedRevision] = React.useState(0);
      commitCompletedRevision = setCompletedRevision;
      const exit = useAnimatedClose(() => {
        closedRevisions.push(completedRevision);
      });
      finishAnimatedClose = () =>
        exit.onAnimationEnd({
          currentTarget: animationTarget,
          target: animationTarget
        } as never);
      React.useLayoutEffect(() => {
        if (completedRevision === 1) {
          exit.requestClose();
        } else if (completedRevision > 1) {
          exit.requestClose(undefined, () => {
            preparedRevisions.push(completedRevision);
            return () => closedRevisions.push(completedRevision);
          });
        }
      }, [completedRevision, exit.requestClose]);
      return null;
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
    await React.act(async () => {
      commitCompletedRevision?.(1);
      await Promise.resolve();
    });

    assert.deepEqual(closedRevisions, [1], "完成态提交后立即关闭必须使用最新已提交的清理回调");
    reduceMotion = false;
    await React.act(async () => {
      commitCompletedRevision?.(2);
      await Promise.resolve();
    });
    await React.act(async () => {
      commitCompletedRevision?.(3);
      await Promise.resolve();
    });
    await React.act(async () => finishAnimatedClose?.());
    assert.deepEqual(preparedRevisions, [2], "重复关闭请求不得重新准备或扩大已经冻结的动作");
    assert.deepEqual(
      closedRevisions,
      [1, 2],
      "退场动画期间的新完成态不得扩大已经请求的关闭清理范围"
    );
    await React.act(async () => root.unmount());

    let requestBoundaryClose: (() => void) | undefined;
    let finishBoundaryClose: (() => void) | undefined;
    function ExitBoundary({ onFinish }: Readonly<{ onFinish: () => void }>) {
      const exit = useAnimatedClose(onFinish);
      requestBoundaryClose = exit.requestClose;
      finishBoundaryClose = () =>
        exit.onAnimationEnd({
          currentTarget: animationTarget,
          target: animationTarget
        } as never);
      return React.createElement("div", {
        id: "animated-close-boundary",
        className: exit.closing ? "is-closing" : ""
      });
    }
    function ExitBoundaryHarness() {
      const [locked, setLocked] = React.useState(true);
      const [open, setOpen] = React.useState(true);
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            id: "animated-close-background-action",
            disabled: locked
          },
          "后台操作"
        ),
        open &&
          React.createElement(ExitBoundary, {
            onFinish: () => {
              setLocked(false);
              setOpen(false);
            }
          })
      );
    }
    const boundaryHost = document.createElement("div");
    document.body.append(boundaryHost);
    const boundaryRoot = createRoot(boundaryHost);
    await React.act(async () => {
      boundaryRoot.render(React.createElement(ExitBoundaryHarness));
      await Promise.resolve();
    });
    await React.act(async () => requestBoundaryClose?.());
    assert.equal(
      document.getElementById("animated-close-boundary")?.classList.contains("is-closing"),
      true
    );
    await React.act(() => {
      finishBoundaryClose?.();
      assert.equal(
        document.getElementById("animated-close-boundary"),
        null,
        "动画结束回调返回前必须同步移除已经透明的弹窗"
      );
      assert.equal(
        (document.getElementById("animated-close-background-action") as HTMLButtonElement | null)
          ?.disabled,
        false,
        "首个无弹窗画面中的后台操作必须已经恢复可用"
      );
    });
    await React.act(async () => boundaryRoot.unmount());
    boundaryHost.remove();

    const requestAnimationFrame = (callback: FrameRequestCallback) =>
      setTimeout(() => callback(Date.now()), 0) as unknown as number;
    Object.assign(window, {
      requestAnimationFrame,
      cancelAnimationFrame: (handle: number) => clearTimeout(handle),
      scrollTo() {},
      scrollY: 0,
      innerWidth: 1280
    });
    const { DialogFrame } =
      await import("../../../../packages/web/src/components/feedback/DialogFrame.tsx");
    let noAnimationPrepared = 0;
    let noAnimationFinished = 0;
    let noAnimationFallback = 0;
    function NoAnimationDialog() {
      const [open, setOpen] = React.useState(true);
      const closeRef = React.useRef<HTMLButtonElement | null>(null);
      if (!open) return null;
      return React.createElement(DialogFrame, {
        className: "no-animation-dialog",
        ariaLabel: "无动画关闭测试",
        animateClose: false,
        initialFocusRef: closeRef,
        prepareClose: () => {
          noAnimationPrepared += 1;
          return () => {
            noAnimationFinished += 1;
            setOpen(false);
          };
        },
        onClose: () => {
          noAnimationFallback += 1;
        },
        children: ({ requestClose }: { requestClose: (afterClose?: () => void) => void }) =>
          React.createElement(
            "button",
            {
              id: "no-animation-close",
              ref: closeRef,
              onClick: () => requestClose()
            },
            "关闭"
          )
      });
    }
    const noAnimationHost = document.createElement("div");
    document.body.append(noAnimationHost);
    const noAnimationRoot = createRoot(noAnimationHost);
    await React.act(async () => {
      noAnimationRoot.render(React.createElement(NoAnimationDialog));
      await Promise.resolve();
    });
    const noAnimationClose = document.getElementById("no-animation-close");
    assert.ok(noAnimationClose);
    await React.act(async () => {
      noAnimationClose.dispatchEvent(
        new window.Event("click", {
          bubbles: true,
          cancelable: true
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(noAnimationPrepared, 1);
    assert.equal(noAnimationFinished, 1);
    assert.equal(noAnimationFallback, 0);
    assert.equal(document.getElementById("no-animation-close"), null);
    await React.act(async () => noAnimationRoot.unmount());
    noAnimationHost.remove();
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
test("[Web/后台访问] 标签切换超限时保持原模式与条件，减少选择后可恢复", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { React } = h;
  const { FacetSelector } =
    await import("../../../../packages/web/src/components/data-display/FacetSelector.tsx");
  const slugs = Array.from(
    { length: 31 },
    (_, index) => `tag-${String(index).padStart(2, "0")}${"x".repeat(26)}`
  );
  const values: string[] = [];
  function Harness() {
    const [value, setValue] = React.useState(slugs.join(","));
    return React.createElement(FacetSelector, {
      options: [...slugs, "tag-extra"].map((slug) => ({ slug, display_name: slug })),
      value,
      noun: "标签",
      selectionMode: "any-all",
      onChange: (next) => {
        values.push(next);
        setValue(next);
      }
    });
  }
  await h.render(React.createElement(Harness));
  const activate = async (button: HTMLButtonElement) => {
    assert.ok(button);
    await React.act(async () => {
      dispatchDomEvent(h.window, button, "click", { detail: 0 });
    });
  };
  await activate(h.document.querySelector<HTMLButtonElement>(".select-trigger")!);
  const search = h.document.querySelector<HTMLInputElement>(".facet-search-input")!;
  await React.act(async () => inputText(h.window as unknown as Window, search, "tag-extra"));
  await activate(h.document.querySelector<HTMLButtonElement>(".facet-search-option")!);
  assert.equal(search.value, "tag-extra", "添加超限时保留搜索词");
  assert.match(h.document.querySelector('[role="alert"]')?.textContent ?? "", /限制/);
  assert.deepEqual(values, []);
  const modes = h.document.querySelectorAll<HTMLButtonElement>(".facet-mode-switch button");
  await activate(modes[1]!);
  assert.match(h.document.querySelector('[role="alert"]')?.textContent ?? "", /限制/);
  assert.equal(modes[0]!.getAttribute("aria-pressed"), "true");
  assert.equal(modes[1]!.getAttribute("aria-pressed"), "false");
  assert.deepEqual(values, []);
  await activate(h.document.querySelector<HTMLButtonElement>(".facet-selected-list button")!);
  assert.equal(search.value, "tag-extra", "移除已选项不清空搜索词");
  await activate(modes[1]!);
  assert.equal(search.value, "tag-extra", "切换模式不清空搜索词");
  assert.equal(values.at(-1), "all:" + slugs.slice(1).join(","));
  assert.equal(modes[1]!.getAttribute("aria-pressed"), "true");
  assert.equal(h.document.querySelector('[role="alert"]'), null);
});

test("[Web/后台访问] 共享 FacetSelector 在原按钮位置内联搜索并保持 Portal 筛选流程", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextFrame = 1;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frameTimers.set(
      id,
      setTimeout(() => {
        frameTimers.delete(id);
        callback(Date.now());
      }, 0)
    );
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    const timer = frameTimers.get(id);
    if (timer) clearTimeout(timer);
    frameTimers.delete(id);
  };
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
  class TestResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const visualViewport = new window.EventTarget() as EventTarget & {
    width: number;
    height: number;
    offsetLeft: number;
    offsetTop: number;
  };
  Object.assign(visualViewport, {
    width: 390,
    height: 844,
    offsetLeft: 0,
    offsetTop: 0
  });
  Object.assign(window, {
    innerWidth: 390,
    innerHeight: 844,
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    ResizeObserver: TestResizeObserver,
    visualViewport
  });
  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    HTMLInputElement: window.HTMLInputElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
    ResizeObserver: TestResizeObserver,
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

  const elementPrototype = window.HTMLElement.prototype;
  const previousFocus = Object.getOwnPropertyDescriptor(elementPrototype, "focus");
  const previousBlur = Object.getOwnPropertyDescriptor(elementPrototype, "blur");
  const previousRect = Object.getOwnPropertyDescriptor(elementPrototype, "getBoundingClientRect");
  const previousOnInput = Object.getOwnPropertyDescriptor(elementPrototype, "oninput");
  let controlTop = 100;
  let fixedOriginTop = 0;
  let activeElement = document.body as HTMLElement;
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => activeElement
  });
  Object.defineProperty(elementPrototype, "getBoundingClientRect", {
    configurable: true,
    value: function getBoundingClientRect() {
      if ((this as HTMLElement).hasAttribute("data-anchored-fixed-origin")) {
        return {
          x: 0,
          y: fixedOriginTop,
          left: 0,
          top: fixedOriginTop,
          right: 0,
          bottom: fixedOriginTop,
          width: 0,
          height: 0,
          toJSON() {
            return this;
          }
        };
      }
      return {
        x: 20,
        y: controlTop,
        left: 20,
        top: controlTop,
        right: 340,
        bottom: controlTop + 40,
        width: 320,
        height: 40,
        toJSON() {
          return this;
        }
      };
    }
  });
  Object.defineProperty(elementPrototype, "oninput", {
    configurable: true,
    writable: true,
    value: null
  });
  Object.defineProperty(elementPrototype, "focus", {
    configurable: true,
    value: function focus() {
      activeElement = this as HTMLElement;
    }
  });
  Object.defineProperty(elementPrototype, "blur", {
    configurable: true,
    value: function blur() {
      if (activeElement === this) activeElement = document.body as HTMLElement;
    }
  });

  const dispatch = (
    target: EventTarget,
    type: string,
    properties: Record<string, unknown> = {}
  ) => {
    const event = new window.Event(type, {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperties(
      event,
      Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, { configurable: true, value }])
      )
    );
    target.dispatchEvent(event);
    return event;
  };
  let nextPointerId = 40;
  const touchActivate = async (button: HTMLButtonElement) => {
    const pointerId = nextPointerId++;
    const rect = button.getBoundingClientRect();
    let pointerDown!: Event;
    let pointerUp!: Event;
    let activeAfterPointerUp: Element | null = null;
    await React.act(async () => {
      pointerDown = dispatch(button, "pointerdown", {
        pointerId,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientX: rect.left + 1,
        clientY: rect.top + 1
      });
      pointerUp = dispatch(button, "pointerup", {
        pointerId,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
        clientX: rect.left + 1,
        clientY: rect.top + 1
      });
      activeAfterPointerUp = document.activeElement;
      await Promise.resolve();
    });
    assert.equal(pointerDown.defaultPrevented, true);
    assert.equal(pointerUp.defaultPrevented, true);
    return activeAfterPointerUp;
  };
  const finishFacetClose = async (closingMenu: HTMLElement) => {
    assert.equal(closingMenu.classList.contains("is-closing"), true);
    await React.act(async () => {
      dispatch(closingMenu, "animationend");
      await Promise.resolve();
    });
  };

  let setDismissSignal: React.Dispatch<React.SetStateAction<number>> | undefined;
  const observedValues: string[] = [];
  try {
    const { createRoot } = await import("react-dom/client");
    const { FacetSelector } =
      await import("../../../../packages/web/src/components/data-display/FacetSelector.tsx");
    const { AnchoredMenuDismissSignalContext } =
      await import("../../../../packages/web/src/hooks/useAnchoredMenu.ts");
    function Harness() {
      const [value, setValue] = React.useState("!legacy,!night");
      const [dismissSignal, commitDismissSignal] = React.useState(0);
      setDismissSignal = commitDismissSignal;
      return React.createElement(
        AnchoredMenuDismissSignalContext.Provider,
        { value: dismissSignal },
        React.createElement(FacetSelector, {
          options: [
            { slug: "night", display_name: "夜景" },
            { slug: "stage", display_name: "舞台" },
            { slug: "editorial", display_name: "编辑精选" },
            { slug: "null", display_name: "未设置" }
          ],
          value,
          noun: "主题",
          ariaLabel: "主题",
          menuClassName: "public-gallery-menu",
          onChange: (next: string) => {
            observedValues.push(next);
            setValue(next);
          }
        }),
        React.createElement("output", { className: "facet-value" }, value)
      );
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    let trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    assert.ok(trigger);
    assert.equal(trigger.textContent, "排除 2 个主题");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(trigger.querySelector("input"), null);

    const activeAfterOpeningPointerUp = await touchActivate(trigger);
    let search = container.querySelector<HTMLInputElement>(".facet-search-input");
    let collapse = container.querySelector<HTMLButtonElement>(".facet-search-collapse");
    let menu = document.querySelector<HTMLElement>(".facet-select-menu");
    assert.ok(search && collapse && menu);
    assert.equal(container.querySelector(".select-trigger"), null);
    assert.equal(search.closest("button"), null, "搜索框不得嵌套在按钮中");
    assert.equal(search.getAttribute("aria-controls"), menu.id);
    assert.equal(search.hasAttribute("aria-expanded"), false);
    assert.equal(search.hasAttribute("aria-haspopup"), false);
    assert.equal(collapse.getAttribute("aria-label"), "收起主题筛选");
    assert.equal(collapse.getAttribute("aria-controls"), menu.id);
    assert.equal(collapse.getAttribute("aria-expanded"), "true");
    assert.equal(menu.getAttribute("role"), "region");
    assert.equal(menu.getAttribute("aria-label"), "主题筛选选项");
    const searchStatus = container.querySelector<HTMLElement>(".facet-search-status");
    assert.ok(searchStatus);
    assert.equal(search.getAttribute("aria-describedby"), searchStatus.id);
    assert.match(searchStatus.textContent, /按 Tab 浏览已选主题和筛选方式/);
    assert.equal(
      activeAfterOpeningPointerUp,
      search,
      "触摸 pointerup 返回前必须同步挂载并聚焦搜索框，保留 iOS 键盘激活"
    );
    assert.equal(document.activeElement, search);
    assert.deepEqual(
      [...menu.children].map((child) => child.className),
      ["facet-search-results", "facet-menu-divider", "facet-selected-list", "facet-mode-switch"]
    );
    assert.match(menu.querySelector(".facet-selected-list")?.textContent ?? "", /legacy/);
    assert.match(menu.querySelector(".facet-selected-list")?.textContent ?? "", /夜景/);

    await React.act(async () => {
      inputText(window as unknown as Window, search!, "unset");
    });
    assert.equal(searchStatus.textContent, "没有可添加的主题");
    await React.act(async () => {
      inputText(window as unknown as Window, search!, " NULL ");
    });
    const nullOptions = [...menu.querySelectorAll<HTMLButtonElement>(".facet-search-option")];
    assert.deepEqual(
      nullOptions.map((option) => option.textContent),
      ["null未设置"]
    );
    await touchActivate(nullOptions[0]!);
    assert.equal(document.querySelector(".facet-value")?.textContent, "!legacy,!night,!null");
    assert.equal(menu.querySelector(".facet-search-option"), null);
    await touchActivate(menu.querySelector<HTMLButtonElement>('[title="移除 未设置"]')!);

    await React.act(async () => {
      inputText(window as unknown as Window, search!, "sta");
      await Promise.resolve();
    });
    assert.equal(search.value, "sta", "DOM 输入事件必须提交筛选词");
    assert.equal(searchStatus.textContent, "1 个可添加的主题");
    let candidate = menu.querySelector<HTMLButtonElement>(".facet-search-option");
    assert.ok(candidate);
    assert.equal(candidate.textContent, "stage舞台");
    assert.equal(searchStatus.textContent, "1 个可添加的主题");

    let tabEvent = dispatch(search, "keydown", {
      key: "Tab",
      shiftKey: false
    });
    assert.equal(tabEvent.defaultPrevented, true);
    assert.equal(document.activeElement, candidate);
    tabEvent = dispatch(candidate, "keydown", {
      key: "Tab",
      shiftKey: true
    });
    assert.equal(tabEvent.defaultPrevented, true);
    assert.equal(document.activeElement, search);

    await touchActivate(candidate);
    assert.equal(document.querySelector(".facet-value")?.textContent, "!legacy,!night,!stage");
    assert.equal(search.value, "", "成功添加后清空搜索词，方便搜索下一项");
    assert.equal(document.activeElement, search, "触摸选择后焦点回到搜索框");
    assert.ok(document.querySelector(".facet-select-menu"), "成功添加后菜单保持打开");
    assert.equal(menu.querySelector(".facet-search-option"), null);

    await React.act(async () => {
      inputText(window as unknown as Window, search!, "edi");
      await Promise.resolve();
    });
    candidate = menu.querySelector<HTMLButtonElement>(".facet-search-option");
    assert.ok(candidate);
    await React.act(async () => {
      dispatch(candidate!, "click", { detail: 0 });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".facet-value")?.textContent,
      "!legacy,!night,!stage,!editorial"
    );
    assert.equal(search.value, "", "键盘选择后同样清空搜索词");
    assert.equal(document.activeElement, search);
    await React.act(async () => inputText(window as unknown as Window, search!, "edi"));

    const modeButtons = menu.querySelectorAll<HTMLButtonElement>(".facet-mode-switch button");
    assert.equal(modeButtons.length, 2);
    const lastModeButton = modeButtons[1];
    tabEvent = dispatch(lastModeButton, "keydown", {
      key: "Tab",
      shiftKey: false
    });
    assert.equal(tabEvent.defaultPrevented, true);
    assert.equal(document.activeElement, collapse);
    tabEvent = dispatch(collapse, "keydown", {
      key: "Tab",
      shiftKey: true
    });
    assert.equal(tabEvent.defaultPrevented, true);
    assert.equal(document.activeElement, lastModeButton);

    await touchActivate(modeButtons[0]);
    assert.equal(
      document.querySelector(".facet-value")?.textContent,
      "legacy,night,stage,editorial"
    );
    const legacyRemoval = [
      ...menu.querySelectorAll<HTMLButtonElement>(".facet-selected-list button")
    ].find((button) => button.getAttribute("title") === "移除 legacy");
    assert.ok(legacyRemoval);
    await touchActivate(legacyRemoval);
    assert.equal(document.querySelector(".facet-value")?.textContent, "night,stage,editorial");

    visualViewport.height = 360;
    await React.act(async () => {
      visualViewport.dispatchEvent(new window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.ok(document.querySelector(".facet-select-menu"));
    assert.equal(search.value, "edi", "软键盘视口变化不得清空搜索或关闭弹层");
    assert.equal(menu.classList.contains("opens-up"), false);
    assert.ok(Number.parseFloat(menu.style.maxHeight) <= 212);

    controlTop = 300;
    visualViewport.offsetTop = 180;
    fixedOriginTop = -180;
    await React.act(async () => {
      visualViewport.dispatchEvent(new window.Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(menu.classList.contains("opens-up"), true);
    const paintedMenuTop = Number.parseFloat(menu.style.top) + fixedOriginTop;
    const paintedMenuBottom = paintedMenuTop + Number.parseFloat(menu.style.maxHeight);
    const paintedViewportTop = visualViewport.offsetTop + fixedOriginTop;
    const paintedViewportBottom = paintedViewportTop + visualViewport.height;
    assert.equal(
      paintedMenuBottom,
      controlTop - 6,
      "iOS 键盘平移 fixed 原点后，弹层仍须停在内联搜索框上方"
    );
    assert.ok(
      paintedMenuTop >= paintedViewportTop && paintedMenuBottom <= paintedViewportBottom,
      "弹层翻转与 maxHeight 必须使用校正后的可见视口边界"
    );

    visualViewport.offsetTop = 0;
    fixedOriginTop = 0;
    controlTop = 700;
    visualViewport.height = 844;
    await React.act(async () => {
      visualViewport.dispatchEvent(new window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(menu.classList.contains("opens-up"), true);
    controlTop = 100;
    await React.act(async () => {
      visualViewport.dispatchEvent(new window.Event("resize"));
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    assert.equal(menu.classList.contains("opens-up"), false);

    search.focus();
    await touchActivate(collapse);
    trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    assert.ok(trigger);
    assert.equal(trigger.textContent, "包含 3 个主题");
    assert.equal(trigger.getAttribute("aria-controls"), menu.id);
    assert.equal(container.querySelector(".facet-search-input"), null);
    assert.ok(document.querySelector(".facet-select-menu.is-closing"));
    await finishFacetClose(menu);
    assert.equal(document.querySelector(".facet-select-menu"), null);
    assert.equal(document.activeElement, trigger, "显式收起后应恢复筛选按钮焦点");
    assert.equal(trigger.hasAttribute("aria-controls"), false);
    const compatibilityClick = dispatch(window, "click", { detail: 1 });
    assert.equal(compatibilityClick.defaultPrevented, true, "触控收起后的兼容 click 不得重开筛选");

    await React.act(async () => {
      dispatch(trigger!, "click", { detail: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    search = container.querySelector<HTMLInputElement>(".facet-search-input");
    assert.ok(search);
    assert.equal(search.value, "", "重新展开必须使用已清空的搜索词");
    assert.match(
      document.querySelector(".facet-search-results")?.textContent ?? "",
      /输入名称、slug 或拼音搜索主题/
    );
    await React.act(async () => {
      search!.focus();
      setDismissSignal?.((current) => current + 1);
      await Promise.resolve();
    });
    assert.equal(container.querySelector(".facet-search-input"), null);
    assert.ok(container.querySelector(".select-trigger"));
    menu = document.querySelector<HTMLElement>(".facet-select-menu");
    assert.ok(menu);
    await finishFacetClose(menu);
    assert.equal(
      document.activeElement,
      document.body,
      "页眉或移动筛选面板自动收起时不得把焦点送回即将隐藏的按钮"
    );

    trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    await React.act(async () => {
      dispatch(trigger!, "click", { detail: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    search = container.querySelector<HTMLInputElement>(".facet-search-input");
    assert.ok(search);
    await React.act(async () => {
      dispatch(document, "keydown", { key: "Escape", shiftKey: false });
      await Promise.resolve();
    });
    menu = document.querySelector<HTMLElement>(".facet-select-menu");
    assert.ok(menu);
    await finishFacetClose(menu);
    trigger = container.querySelector<HTMLButtonElement>(".select-trigger");
    assert.ok(trigger);
    assert.equal(document.activeElement, trigger, "Escape 收起后应恢复按钮焦点");

    await React.act(async () => root.unmount());
    assert.deepEqual(observedValues, [
      "!legacy,!night,!null",
      "!legacy,!night",
      "!legacy,!night,!stage",
      "!legacy,!night,!stage,!editorial",
      "legacy,night,stage,editorial",
      "night,stage,editorial"
    ]);
  } finally {
    for (const timer of frameTimers.values()) clearTimeout(timer);
    if (previousFocus) {
      Object.defineProperty(elementPrototype, "focus", previousFocus);
    } else {
      delete (elementPrototype as unknown as Record<string, unknown>).focus;
    }
    if (previousBlur) {
      Object.defineProperty(elementPrototype, "blur", previousBlur);
    } else {
      delete (elementPrototype as unknown as Record<string, unknown>).blur;
    }
    if (previousRect) {
      Object.defineProperty(elementPrototype, "getBoundingClientRect", previousRect);
    } else {
      delete (elementPrototype as unknown as Record<string, unknown>).getBoundingClientRect;
    }
    if (previousOnInput) {
      Object.defineProperty(elementPrototype, "oninput", previousOnInput);
    } else {
      delete (elementPrototype as unknown as Record<string, unknown>).oninput;
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
test("[Web/后台访问] 后台筛选布局按容器宽度选择字段分组", () => {
  assert.deepEqual(
    imageAdminFilterDomGroups(false),
    {
      primary: ["device", "brightness", "theme"],
      secondary: ["tag", "author"]
    },
    "后台单行与移动布局必须保持设备、亮度、主题、标签、作者的 DOM 顺序"
  );
  assert.deepEqual(
    imageAdminFilterDomGroups(true),
    {
      primary: ["device", "brightness", "author"],
      secondary: ["theme", "tag"]
    },
    "后台双行必须把作者放在首行，并让主题与标签依次位于第二行"
  );
  assert.equal(imageAdminDoubleRowMaxWidth, 947);
  assert.equal(isImageAdminDoubleRowWidth(0), false);
  assert.equal(isImageAdminDoubleRowWidth(946.99), true);
  assert.equal(isImageAdminDoubleRowWidth(947), true);
  assert.equal(isImageAdminDoubleRowWidth(947.01), false);
  assert.equal(isImageAdminDoubleRowWidth(948), false);
});
test("[Web/后台访问] 后台图片筛选在临界视口保持清空、无障碍名称与搜索交互", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ImageAdminFilters } =
    await import("../../../../packages/web/src/pages/admin/images/ImageAdminFilters.tsx");
  const filters = {
    device: "",
    brightness: "",
    theme: "",
    tag: "",
    author: ""
  };
  const facets = {
    themes: [{ slug: "night", display_name: "夜景" }],
    tags: [{ slug: "blue", display_name: "蓝色" }],
    authors: [{ slug: "camera", display_name: "摄影师", link: "" }]
  };
  const vocabulary: IngestionVocabularyDto = {
    themes: facets.themes,
    tags: facets.tags,
    authors: facets.authors
  };
  const fieldIds = ["admin-image-theme-facet", "admin-image-tag-facet", "admin-image-author-facet"];
  const structures: string[][] = [];

  for (const width of [760, 761, 999, 1000, 1389, 1390]) {
    const { window, document } = parseHTML(
      "<!doctype html><html><body><div id=root></div></body></html>"
    );
    const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextFrame = 1;
    const requestAnimationFrame = (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frameTimers.set(
        id,
        setTimeout(() => {
          frameTimers.delete(id);
          callback(Date.now());
        }, 0)
      );
      return id;
    };
    const cancelAnimationFrame = (id: number) => {
      const timer = frameTimers.get(id);
      if (timer) clearTimeout(timer);
      frameTimers.delete(id);
    };
    const matchMedia = (query: string) => {
      const maxWidth = /max-width:\s*(\d+)px/.exec(query)?.[1];
      const minWidth = /min-width:\s*(\d+)px/.exec(query)?.[1];
      const widthConstrained = Boolean(maxWidth || minWidth);
      return {
        matches:
          query.includes("prefers-reduced-motion") ||
          (widthConstrained &&
            (maxWidth ? width <= Number(maxWidth) : true) &&
            (minWidth ? width >= Number(minWidth) : true)),
        media: query,
        onchange: null,
        addListener() {},
        removeListener() {},
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent: () => true
      };
    };
    class TestResizeObserver {
      static callbacks = new Set<() => void>();
      readonly callback: () => void;

      constructor(callback: () => void) {
        this.callback = callback;
        TestResizeObserver.callbacks.add(callback);
      }

      static notify() {
        for (const callback of TestResizeObserver.callbacks) callback();
      }

      observe() {}
      unobserve() {}
      disconnect() {
        TestResizeObserver.callbacks.delete(this.callback);
      }
    }
    const visualViewport = new window.EventTarget() as EventTarget & {
      width: number;
      height: number;
      offsetLeft: number;
      offsetTop: number;
    };
    Object.assign(visualViewport, {
      width,
      height: 844,
      offsetLeft: 0,
      offsetTop: 0
    });
    Object.assign(window, {
      innerWidth: width,
      innerHeight: 844,
      matchMedia,
      requestAnimationFrame,
      cancelAnimationFrame,
      ResizeObserver: TestResizeObserver,
      visualViewport
    });
    const installedGlobals = {
      window,
      self: window,
      document,
      navigator: window.navigator,
      Node: window.Node,
      Element: window.Element,
      HTMLElement: window.HTMLElement,
      HTMLButtonElement: window.HTMLButtonElement,
      HTMLInputElement: window.HTMLInputElement,
      Event: window.Event,
      EventTarget: window.EventTarget,
      MutationObserver: window.MutationObserver,
      ResizeObserver: TestResizeObserver,
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

    const elementPrototype = window.HTMLElement.prototype;
    const previousFocus = Object.getOwnPropertyDescriptor(elementPrototype, "focus");
    const previousBlur = Object.getOwnPropertyDescriptor(elementPrototype, "blur");
    const previousRect = Object.getOwnPropertyDescriptor(elementPrototype, "getBoundingClientRect");
    let activeElement = document.body as HTMLElement;
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => activeElement
    });
    Object.defineProperty(elementPrototype, "focus", {
      configurable: true,
      value: function focus() {
        activeElement = this as HTMLElement;
      }
    });
    Object.defineProperty(elementPrototype, "blur", {
      configurable: true,
      value: function blur() {
        if (activeElement === this) activeElement = document.body as HTMLElement;
      }
    });
    Object.defineProperty(elementPrototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 20,
        y: 100,
        left: 20,
        top: 100,
        right: Math.max(320, width - 20),
        bottom: 140,
        width: Math.max(300, width - 40),
        height: 40,
        toJSON() {
          return this;
        }
      })
    });
    const dispatch = (
      target: EventTarget,
      type: string,
      properties: Record<string, unknown> = {}
    ) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(
        event,
        Object.fromEntries(
          Object.entries(properties).map(([key, value]) => [key, { configurable: true, value }])
        )
      );
      target.dispatchEvent(event);
      return event;
    };

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    let adminClearCalls = 0;
    const adminFilterChanges: string[] = [];
    let setAdminHarnessFilters: ((next: typeof filters) => void) | undefined;
    let setAdminHarnessDisabled: ((next: boolean) => void) | undefined;
    try {
      const mobileLayout = window.matchMedia("(max-width: 760px)").matches;
      assert.equal(mobileLayout, width === 760);
      function Harness() {
        const [adminFilters, setAdminFilters] = React.useState(filters);
        const [adminDisabled, setAdminDisabled] = React.useState(false);
        setAdminHarnessFilters = setAdminFilters;
        setAdminHarnessDisabled = setAdminDisabled;
        return React.createElement(
          "main",
          null,
          React.createElement(ImageAdminFilters, {
            value: adminFilters,
            vocabulary,
            view: "ready",
            mobileLayout,
            disabled: adminDisabled,
            onChange(key, value) {
              adminFilterChanges.push(`${key}:${value}`);
              setAdminFilters((current) => ({ ...current, [key]: value }));
            },
            onClear() {
              adminClearCalls += 1;
              setAdminFilters({ ...filters });
            }
          })
        );
      }
      await React.act(async () => {
        root.render(React.createElement(Harness));
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      if (mobileLayout) {
        const adminToggle = container.querySelector<HTMLButtonElement>(".image-list-filter-toggle");
        assert.ok(adminToggle);
        await React.act(async () => {
          dispatch(adminToggle, "click", { detail: 1 });
          await Promise.resolve();
        });
      }

      const adminClear = container.querySelector<HTMLButtonElement>(".image-list-filter-clear");
      assert.ok(adminClear);
      assert.equal(adminClear.disabled, true);
      if (mobileLayout && !container.querySelector(".image-list-filter-bar.filters-open")) {
        await React.act(async () =>
          dispatch(container.querySelector(".image-list-filter-toggle")!, "click")
        );
      }
      const adminPanel = container.querySelector<HTMLElement>(".image-list-filter-panel");
      assert.ok(adminPanel);
      const controls = [...container.querySelectorAll<HTMLElement>(".facet-select-control")];
      assert.equal(controls.length, 3);
      assert.equal(document.querySelector(".facet-search-input"), null);
      for (const id of fieldIds) {
        const target = document.getElementById(id);
        assert.equal(container.querySelector(`label[for="${id}"]`), null);
        assert.ok(target);
        assert.ok(target.getAttribute("aria-label"), `${width}px 下 ${id} 必须保留无障碍名称`);
        assert.equal(target.tagName, "BUTTON");
        assert.equal(target.classList.contains("select-trigger"), true);
        assert.equal(target.hasAttribute("aria-controls"), false);
        assert.equal(target.hasAttribute("aria-haspopup"), false);
      }
      structures.push(
        controls.map((control) =>
          [...control.children].map((child) => `${child.tagName}.${child.className}`).join(">")
        )
      );

      for (const id of ["admin-image-theme-facet"]) {
        const trigger = document.getElementById(id) as HTMLButtonElement | null;
        assert.ok(trigger);
        const accessibleName = trigger.getAttribute("aria-label");
        await React.act(async () => {
          dispatch(trigger, "click", { detail: 0 });
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
        const search = document.getElementById(id) as HTMLInputElement | null;
        assert.ok(search);
        const menuId = search.getAttribute("aria-controls");
        assert.ok(menuId);
        const menu = document.getElementById(menuId);
        const collapse: HTMLButtonElement | null = container.querySelector(
          `#${id} + .facet-search-status + .facet-search-collapse`
        );
        assert.ok(menu && collapse);
        assert.equal(menu.getAttribute("role"), "region");
        assert.equal(search.hasAttribute("aria-expanded"), false);
        assert.equal(collapse.getAttribute("aria-expanded"), "true");

        assert.equal(search.getAttribute("aria-label"), `搜索${accessibleName}`);
        assert.equal(document.getElementById(id), search);
        assert.ok(document.getElementById(menuId));
        search.focus();
        assert.equal(document.activeElement, search);

        await React.act(async () => {
          dispatch(document, "keydown", { key: "Escape", shiftKey: false });
          await Promise.resolve();
        });
        const restoredTrigger = document.getElementById(id);
        assert.ok(restoredTrigger);
        assert.equal(restoredTrigger.tagName, "BUTTON");
        assert.equal(restoredTrigger.hasAttribute("aria-controls"), false);
        await React.act(async () => {
          dispatch(menu, "animationend");
          await Promise.resolve();
        });
      }

      const populatedFilters = {
        device: "pc",
        brightness: "dark",
        theme: "night",
        tag: "blue",
        author: "camera"
      };
      assert.ok(setAdminHarnessFilters);
      await React.act(async () => {
        setAdminHarnessFilters?.(populatedFilters);
        await Promise.resolve();
      });
      assert.equal(adminClear.disabled, false);

      if (
        mobileLayout &&
        !container.querySelector(".image-list-filter-bar")?.classList.contains("filters-open")
      ) {
        const adminToggle = container.querySelector<HTMLButtonElement>(".image-list-filter-toggle");
        assert.ok(adminToggle);
        await React.act(async () => {
          dispatch(adminToggle, "click", { detail: 1 });
          await Promise.resolve();
        });
      }

      const adminThemeTrigger = document.getElementById(
        "admin-image-theme-facet"
      ) as HTMLButtonElement | null;
      assert.ok(adminThemeTrigger);
      await React.act(async () => {
        dispatch(adminThemeTrigger, "click", { detail: 0 });
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      const openAdminSearch = document.getElementById(
        "admin-image-theme-facet"
      ) as HTMLInputElement | null;
      assert.ok(openAdminSearch);
      const openAdminMenuId = openAdminSearch.getAttribute("aria-controls");
      assert.ok(openAdminMenuId);
      const openAdminMenu = document.getElementById(openAdminMenuId);
      assert.ok(openAdminMenu);

      await React.act(async () => {
        dispatch(adminClear, "click", { detail: 1 });
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      assert.equal(adminClearCalls, 1);
      assert.deepEqual(adminFilterChanges, []);
      assert.equal(adminClear.disabled, true);
      assert.equal(
        openAdminMenu.isConnected ? openAdminMenu.classList.contains("is-closing") : true,
        true,
        "清空必须收起已打开的后台 Facet 子菜单"
      );
      if (mobileLayout) {
        assert.equal(
          container.querySelector(".image-list-filter-bar")?.classList.contains("filters-open"),
          true,
          "移动后台清空不得关闭外层筛选面板"
        );
      }

      assert.ok(setAdminHarnessDisabled);
      await React.act(async () => {
        setAdminHarnessFilters?.(populatedFilters);
        setAdminHarnessDisabled?.(true);
        await Promise.resolve();
      });
      assert.equal(adminClear.disabled, true);
      assert.equal(
        container.querySelector<HTMLButtonElement>(".image-list-filter-toggle")?.disabled,
        true,
        "后台忙碌态必须同时禁用筛选与清空"
      );
    } finally {
      await React.act(async () => root.unmount());
      for (const timer of frameTimers.values()) clearTimeout(timer);
      if (previousFocus) {
        Object.defineProperty(elementPrototype, "focus", previousFocus);
      } else {
        delete (elementPrototype as unknown as Record<string, unknown>).focus;
      }
      if (previousBlur) {
        Object.defineProperty(elementPrototype, "blur", previousBlur);
      } else {
        delete (elementPrototype as unknown as Record<string, unknown>).blur;
      }
      if (previousRect) {
        Object.defineProperty(elementPrototype, "getBoundingClientRect", previousRect);
      } else {
        delete (elementPrototype as unknown as Record<string, unknown>).getBoundingClientRect;
      }
      for (const [key, descriptor] of previousGlobals) {
        if (descriptor) {
          Object.defineProperty(globalThis, key, descriptor);
        } else {
          delete (globalThis as Record<string, unknown>)[key];
        }
      }
    }
  }
  for (const structure of structures.slice(1)) {
    assert.deepEqual(structure, structures[0], "所有清空动作临界视口都不得切换 FacetSelector DOM");
  }
});
