import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  adminPermissions,
  type AdminCheckStatusDto,
  type AdminImageListItemDto,
  type AdminOverviewDto,
  type IngestionVocabularyDto
} from "../../../packages/shared/src/browser.ts";
import type {
  PublicImageItem
} from "../../../packages/web/src/lib/types.ts";
import {
  ApiClientError,
  api,
  apiWithEtag,
  authExpiredEvent,
  clearCsrfToken
} from "../../../packages/web/src/lib/api/client.ts";
import {
  invalidateImageDataAfterMetadataSave
} from "../../../packages/web/src/lib/api/query-invalidation.ts";
import {
  queryKeys
} from "../../../packages/web/src/lib/api/query-keys.ts";
import {
  AuthSessionRefreshCoordinator
} from "../../../packages/web/src/lib/api/auth-session.ts";
import {
  advanceAdminColorSchemeCycle,
  nextAdminColorScheme,
  resolveUiColorContext,
  type AdminColorSchemeCycle
} from "../../../packages/web/src/lib/ui/color-scheme.ts";
import {
  parseAdminPaginationPage,
  releaseAdminPaginationSubmission,
  resolveAdminPaginationCommit,
  shouldCommitAdminPaginationInput
} from "../../../packages/web/src/components/navigation/admin-pagination-model.ts";
import {
  adminNavigationForRole
} from "../../../packages/web/src/pages/admin/shell/AdminNavigation.tsx";
import {
  adminRoutePreloadPolicies
} from "../../../packages/web/src/pages/admin/shell/admin-route-modules.ts";
import {
  createPageLifetimeModuleLoader
} from "../../../packages/web/src/lib/page-lifetime-module-loader.ts";
import {
  createPublicRouteModuleLoader
} from "../../../packages/web/src/lib/public-route-modules.ts";
import {
  preloadIntentProps,
  usePreloadIntentProps
} from "../../../packages/web/src/lib/ui/preload-intent.ts";
import {
  reorderItemByDirection,
  reorderItemByKey,
  reorderPageForKey,
  reorderPositionByKey
} from "../../../packages/web/src/lib/ui/reorder.ts";
import {
  ImageListSelectionController,
  isImageSelectionPreservingTarget
} from "../../../packages/web/src/pages/admin/images/image-list-selection.ts";
import {
  imageAdminConfirmationCopy
} from "../../../packages/web/src/pages/admin/images/useImageAdminOperations.ts";
import {
  useImageAdminPageNavigation
} from "../../../packages/web/src/pages/admin/images/useImageAdminPageNavigation.ts";
import {
  adminImageListQuery,
  effectiveImageAdminPage,
  imageAdminPaginationScopeKey,
  imageAdminTotalPages,
  resetImageAdminPage,
  resolveImageAdminScopeTotal
} from "../../../packages/web/src/pages/admin/images/image-admin-list-query.ts";
import {
  emptyImageAdminFilters,
  imageAdminDoubleRowMaxWidth,
  imageAdminFilterDomGroups,
  isImageAdminDoubleRowWidth
} from "../../../packages/web/src/pages/admin/images/ImageAdminFilters.tsx";
import {
  galleryCard,
  adminImageListItem
} from "../support/web-test-context.ts";
import {
  inputText
} from "../support/dom-events.ts";
import {
  installControlledClock
} from "../support/controlled-clock.ts";

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
  assert.strictEqual(controller.update({
    pageIds,
    selectedIds: selected,
    targetId: "a",
    checked: true,
    extendRange: false,
    busy: true
  }), selected);
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
  assert.equal(resolveAdminPaginationCommit({
    value: firstCommit.value,
    page: 1,
    totalPages: 5,
    submittedPage: firstCommit.submittedPage
  }).targetPage, null);
  assert.equal(releaseAdminPaginationSubmission(true, false, 3), null);
  assert.equal(shouldCommitAdminPaginationInput("Enter", false, 13), true);
  assert.equal(shouldCommitAdminPaginationInput("Enter", true, 13), false);

  const navigationModules = (role: "image" | "super") => new Set(
    Object.values(adminNavigationForRole(role)).flatMap((entries) => (
      entries.flatMap((entry) => entry.kind === "link"
        ? [entry.routeModule].filter((value) => value !== undefined)
        : entry.items.flatMap((item) => (
            item.routeModule ? [item.routeModule] : []
          )))
    ))
  );
  assert.deepEqual(
    [...navigationModules("image")].sort(),
    ["account", "check", "images", "overview", "vocabulary"]
  );
  assert.deepEqual(
    [...navigationModules("super")].sort(),
    [
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
    ]
  );

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
    "<!doctype html><html data-ui-context=bootstrap data-color-scheme=dark><head>"
      + "<meta name=color-scheme content=dark><meta name=theme-color content=#070b15>"
      + "</head><body><div id=root></div></body></html>"
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
    getPropertyValue: (name: string) => (
      name === "--color-browser-canvas" ? "#ffffff" : ""
    )
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
    const { useAdminColorScheme } = await import(
      "../../../packages/web/src/hooks/useAdminColorScheme.ts"
    );
    const layoutObservations: string[] = [];

    function Harness() {
      const resolved = useAdminColorScheme("light");
      React.useLayoutEffect(() => {
        layoutObservations.push(
          `${document.documentElement.dataset.uiContext}/`
            + `${document.documentElement.dataset.colorScheme}/${resolved}`
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
    const { useAnimatedClose } = await import(
      "../../../packages/web/src/hooks/useAnimatedClose.ts"
    );
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
      finishAnimatedClose = () => exit.onAnimationEnd({
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

    assert.deepEqual(
      closedRevisions,
      [1],
      "完成态提交后立即关闭必须使用最新已提交的清理回调"
    );
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
    assert.deepEqual(
      preparedRevisions,
      [2],
      "重复关闭请求不得重新准备或扩大已经冻结的动作"
    );
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
      finishBoundaryClose = () => exit.onAnimationEnd({
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
        React.createElement("button", {
          id: "animated-close-background-action",
          disabled: locked
        }, "后台操作"),
        open && React.createElement(ExitBoundary, {
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
      document.getElementById("animated-close-boundary")
        ?.classList.contains("is-closing"),
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
        (document.getElementById(
          "animated-close-background-action"
        ) as HTMLButtonElement | null)?.disabled,
        false,
        "首个无弹窗画面中的后台操作必须已经恢复可用"
      );
    });
    await React.act(async () => boundaryRoot.unmount());
    boundaryHost.remove();

    const requestAnimationFrame = (callback: FrameRequestCallback) => (
      setTimeout(() => callback(Date.now()), 0) as unknown as number
    );
    Object.assign(window, {
      requestAnimationFrame,
      cancelAnimationFrame: (handle: number) => clearTimeout(handle),
      scrollTo() {},
      scrollY: 0,
      innerWidth: 1280
    });
    const { DialogFrame } = await import(
      "../../../packages/web/src/components/feedback/DialogFrame.tsx"
    );
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
        onClose: () => { noAnimationFallback += 1; },
        children: ({ requestClose }: {
          requestClose: (afterClose?: () => void) => void;
        }) => React.createElement("button", {
          id: "no-animation-close",
          ref: closeRef,
          onClick: () => requestClose()
        }, "关闭")
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
      noAnimationClose.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
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
test("[Web/后台访问] 共享 FacetSelector 在原按钮位置内联搜索并保持 Portal 筛选流程", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextFrame = 1;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame++;
    frameTimers.set(id, setTimeout(() => {
      frameTimers.delete(id);
      callback(Date.now());
    }, 0));
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

  const elementPrototype = window.HTMLElement.prototype;
  const previousFocus = Object.getOwnPropertyDescriptor(elementPrototype, "focus");
  const previousBlur = Object.getOwnPropertyDescriptor(elementPrototype, "blur");
  const previousRect = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "getBoundingClientRect"
  );
  const previousOnInput = Object.getOwnPropertyDescriptor(
    elementPrototype,
    "oninput"
  );
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
          toJSON() { return this; }
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
        toJSON() { return this; }
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
    Object.defineProperties(event, Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [
        key,
        { configurable: true, value }
      ])
    ));
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
    const { FacetSelector } = await import(
      "../../../packages/web/src/components/data-display/FacetSelector.tsx"
    );
    const { AnchoredMenuDismissSignalContext } = await import(
      "../../../packages/web/src/hooks/useAnchoredMenu.ts"
    );
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
            { slug: "editorial", display_name: "编辑精选" }
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
    let collapse = container.querySelector<HTMLButtonElement>(
      ".facet-search-collapse"
    );
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
    const searchStatus = container.querySelector<HTMLElement>(
      ".facet-search-status"
    );
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
      [
        "facet-search-results",
        "facet-menu-divider",
        "facet-selected-list",
        "facet-mode-switch"
      ]
    );
    assert.match(menu.querySelector(".facet-selected-list")?.textContent ?? "", /legacy/);
    assert.match(menu.querySelector(".facet-selected-list")?.textContent ?? "", /夜景/);

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
    assert.equal(
      document.querySelector(".facet-value")?.textContent,
      "!legacy,!night,!stage"
    );
    assert.equal(search.value, "sta", "连续选择期间必须保留搜索词");
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

    const modeButtons = menu.querySelectorAll<HTMLButtonElement>(
      ".facet-mode-switch button"
    );
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
    const legacyRemoval = [...menu.querySelectorAll<HTMLButtonElement>(
      ".facet-selected-list button"
    )].find((button) => button.getAttribute("title") === "移除 legacy");
    assert.ok(legacyRemoval);
    await touchActivate(legacyRemoval);
    assert.equal(
      document.querySelector(".facet-value")?.textContent,
      "night,stage,editorial"
    );

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
    const paintedMenuBottom = paintedMenuTop
      + Number.parseFloat(menu.style.maxHeight);
    const paintedViewportTop = visualViewport.offsetTop + fixedOriginTop;
    const paintedViewportBottom = paintedViewportTop + visualViewport.height;
    assert.equal(
      paintedMenuBottom,
      controlTop - 6,
      "iOS 键盘平移 fixed 原点后，弹层仍须停在内联搜索框上方"
    );
    assert.ok(
      paintedMenuTop >= paintedViewportTop
      && paintedMenuBottom <= paintedViewportBottom,
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
    assert.equal(
      compatibilityClick.defaultPrevented,
      true,
      "触控收起后的兼容 click 不得重开筛选"
    );

    await React.act(async () => {
      dispatch(trigger!, "click", { detail: 0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    search = container.querySelector<HTMLInputElement>(".facet-search-input");
    assert.ok(search);
    assert.equal(search.value, "", "重新展开必须使用已清空的搜索词");
    assert.match(
      document.querySelector(".facet-search-results")?.textContent ?? "",
      /输入关键字搜索主题/
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
      delete (elementPrototype as unknown as Record<string, unknown>)
        .getBoundingClientRect;
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
test("[Web/后台访问] 公开图库与后台图片筛选在清空动作临界视口真实挂载并保持无障碍名称与搜索交互边界", async () => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { PublicImageToolbar, randomLinkNeedsTruncation } = await import(
    "../../../packages/web/src/components/navigation/PublicImageToolbar.tsx"
  );
  const { ImageAdminFilters } = await import(
    "../../../packages/web/src/pages/admin/images/ImageAdminFilters.tsx"
  );
  const filters = {
    device: "",
    brightness: "",
    theme: "",
    tag: "",
    author: ""
  };
  const randomUrl = "https://img.example/random";
  assert.equal(randomLinkNeedsTruncation(120, 120), false);
  assert.equal(randomLinkNeedsTruncation(120.5, 120), false);
  assert.equal(randomLinkNeedsTruncation(120.6, 120), true);
  assert.equal(randomLinkNeedsTruncation(240, 0), false);
  const facets = {
    devices: ["pc", "mb"],
    brightnesses: ["light", "dark"],
    themes: [{ slug: "night", display_name: "夜景" }],
    tags: [{ slug: "blue", display_name: "蓝色" }],
    authors: [{ slug: "camera", display_name: "摄影师", link: "" }]
  };
  const vocabulary: IngestionVocabularyDto = {
    themes: facets.themes,
    tags: facets.tags,
    authors: facets.authors
  };
  const fieldIds = [
    "gallery-theme-facet",
    "gallery-tag-facet",
    "gallery-author-facet",
    "admin-image-theme-facet",
    "admin-image-tag-facet",
    "admin-image-author-facet"
  ];
  const structures: string[][] = [];

  for (const width of [760, 761, 999, 1000, 1389, 1390]) {
    const { window, document } = parseHTML(
      "<!doctype html><html><body><div id=root></div></body></html>"
    );
    const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
    let nextFrame = 1;
    const requestAnimationFrame = (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frameTimers.set(id, setTimeout(() => {
        frameTimers.delete(id);
        callback(Date.now());
      }, 0));
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
        matches: query.includes("prefers-reduced-motion")
          || widthConstrained
            && (maxWidth ? width <= Number(maxWidth) : true)
            && (minWidth ? width >= Number(minWidth) : true),
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
      disconnect() { TestResizeObserver.callbacks.delete(this.callback); }
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

    const elementPrototype = window.HTMLElement.prototype;
    const previousFocus = Object.getOwnPropertyDescriptor(elementPrototype, "focus");
    const previousBlur = Object.getOwnPropertyDescriptor(elementPrototype, "blur");
    const previousRect = Object.getOwnPropertyDescriptor(
      elementPrototype,
      "getBoundingClientRect"
    );
    let activeElement = document.body as HTMLElement;
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => activeElement
    });
    Object.defineProperty(elementPrototype, "focus", {
      configurable: true,
      value: function focus() { activeElement = this as HTMLElement; }
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
        toJSON() { return this; }
      })
    });
    const dispatch = (
      target: EventTarget,
      type: string,
      properties: Record<string, unknown> = {}
    ) => {
      const event = new window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperties(event, Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [
          key,
          { configurable: true, value }
        ])
      ));
      target.dispatchEvent(event);
      return event;
    };

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    let galleryClearCalls = 0;
    let adminClearCalls = 0;
    const galleryFilterChanges: string[] = [];
    const adminFilterChanges: string[] = [];
    let setGalleryHarnessFilters: ((next: typeof filters) => void) | undefined;
    let setAdminHarnessFilters: ((next: typeof filters) => void) | undefined;
    let setAdminHarnessDisabled: ((next: boolean) => void) | undefined;
    try {
      const mobileLayout = window.matchMedia("(max-width: 760px)").matches;
      assert.equal(mobileLayout, width === 760);
      function Harness() {
        const [galleryFilters, setGalleryFilters] = React.useState(filters);
        const [adminFilters, setAdminFilters] = React.useState(filters);
        const [adminDisabled, setAdminDisabled] = React.useState(false);
        const [galleryDismissSignal, setGalleryDismissSignal] = React.useState(0);
        const toolbarRef = React.useRef<HTMLElement | null>(null);
        const galleryToggleRef = React.useRef<HTMLButtonElement | null>(null);
        const galleryClearRef = React.useRef<HTMLButtonElement | null>(null);
        const galleryPanelRef = React.useRef<HTMLDivElement | null>(null);
        setGalleryHarnessFilters = setGalleryFilters;
        setAdminHarnessFilters = setAdminFilters;
        setAdminHarnessDisabled = setAdminDisabled;
        return React.createElement(
          "main",
          null,
          React.createElement(PublicImageToolbar, {
            animateEntrance: false,
            filters: galleryFilters,
            facets,
            randomUrl,
            filtersOpen: mobileLayout,
            filterPanelHidden: mobileLayout ? false : undefined,
            filterMenuDismissSignal: galleryDismissSignal,
            toolbarVisible: true,
            toolbarRef,
            filterToggleRef: galleryToggleRef,
            clearFiltersRef: galleryClearRef,
            filterPanelRef: galleryPanelRef,
            toggleFilters() {},
            dismissFilterMenus() {
              setGalleryDismissSignal((current) => current + 1);
            },
            onFilterChange(key, value) {
              galleryFilterChanges.push(`${key}:${value}`);
              setGalleryFilters((current) => ({ ...current, [key]: value }));
            },
            onClearFilters() {
              galleryClearCalls += 1;
              setGalleryFilters({ ...filters });
            }
          }),
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
        const adminToggle = container.querySelector<HTMLButtonElement>(
          ".image-list-filter-toggle"
        );
        assert.ok(adminToggle);
        await React.act(async () => {
          dispatch(adminToggle, "click", { detail: 1 });
          await Promise.resolve();
        });
      }

      const galleryClear = container.querySelector<HTMLButtonElement>(
        ".gallery-filter-clear"
      );
      const adminClear = container.querySelector<HTMLButtonElement>(
        ".image-list-filter-clear"
      );
      assert.ok(galleryClear && adminClear);
      assert.equal(galleryClear.disabled, true);
      assert.equal(adminClear.disabled, true);
      assert.equal(galleryClear.textContent?.trim(), mobileLayout ? "清空" : "清空筛选");
      assert.equal(adminClear.textContent?.trim(), "清空");
      assert.equal(
        container.querySelector(".generated-link-field code > span")?.textContent,
        randomUrl
      );
      const randomLinkViewport = container.querySelector<HTMLElement>(
        ".generated-link-value"
      );
      const randomLinkText = container.querySelector<HTMLElement>(
        ".generated-link-text"
      );
      assert.ok(randomLinkViewport && randomLinkText);
      let randomLinkAvailableWidth = 120;
      let randomLinkContentWidth = 240;
      Object.defineProperty(randomLinkViewport, "clientWidth", {
        configurable: true,
        get: () => randomLinkAvailableWidth
      });
      Object.defineProperty(randomLinkText, "scrollWidth", {
        configurable: true,
        get: () => randomLinkContentWidth
      });
      await React.act(async () => TestResizeObserver.notify());
      assert.equal(randomLinkViewport.classList.contains("is-truncated"), true);
      assert.equal(randomLinkViewport.title, randomUrl);
      assert.equal(
        randomLinkViewport.querySelector(".generated-link-truncation")?.textContent,
        "..."
      );

      const selections: Node[] = [];
      Object.defineProperty(document, "getSelection", { configurable: true, value: () => ({
        selectAllChildren: (node: Node) => selections.push(node)
      }) });
      assert.equal(randomLinkViewport.getAttribute("role"), "textbox");
      assert.equal(randomLinkViewport.getAttribute("aria-readonly"), "true");
      assert.equal(container.querySelector(".generated-link-label")?.textContent, "随机API");
      await React.act(async () => {
        dispatch(randomLinkViewport, "pointerdown", { button: 0 });
        randomLinkViewport.focus();
        dispatch(randomLinkViewport, "focusin");
        dispatch(randomLinkViewport, "click");
      });
      assert.ok(selections.length > 0);
      assert.ok(selections.every((node) => node === randomLinkText), "选区只包含完整 URL，不含标签或截断标记");
      const firstSelectionCount = selections.length;
      await React.act(async () => {
        dispatch(randomLinkViewport, "pointerdown", { button: 0 });
        dispatch(randomLinkViewport, "click");
      });
      assert.equal(selections.length, firstSelectionCount, "再次点击不覆盖浏览器局部选区");
      await React.act(async () => {
        randomLinkViewport.blur();
        dispatch(randomLinkViewport, "focusout");
      });

      randomLinkContentWidth = randomLinkAvailableWidth;
      await React.act(async () => TestResizeObserver.notify());
      assert.equal(randomLinkViewport.classList.contains("is-truncated"), false);
      assert.equal(randomLinkViewport.hasAttribute("title"), false);
      assert.equal(
        randomLinkViewport.querySelector(".generated-link-truncation"),
        null
      );

      const galleryPanel = container.querySelector<HTMLElement>(
        ".gallery-filter-panel"
      );
      if (mobileLayout && !container.querySelector(".image-list-filter-bar.filters-open")) {
        await React.act(async () => dispatch(container.querySelector(".image-list-filter-toggle")!, "click"));
      }
      const adminPanel = container.querySelector<HTMLElement>(
        ".image-list-filter-panel"
      );
      assert.ok(galleryPanel && adminPanel);
      const galleryPanelOrder = [...galleryPanel.children].map((child) => (
        child.className
      ));
      if (mobileLayout) {
        const galleryActions = container.querySelector<HTMLElement>(
          ".gallery-filter-actions"
        );
        const adminActions = container.querySelector<HTMLElement>(
          ".image-list-filter-actions"
        );
        assert.ok(galleryActions && adminActions);
        assert.deepEqual(
          [...galleryActions.children].map((child) => child.tagName),
          ["BUTTON", "SPAN", "BUTTON"]
        );
        assert.deepEqual(
          [...adminActions.children].map((child) => child.tagName),
          ["BUTTON", "SPAN", "BUTTON"]
        );
        for (const divider of container.querySelectorAll(
          ".gallery-filter-action-divider, .image-list-filter-action-divider"
        )) {
          assert.equal(divider.getAttribute("aria-hidden"), "true");
          assert.equal(divider.hasAttribute("role"), false);
        }
        assert.deepEqual(galleryPanelOrder, ["gallery-filter-fields", "theme-link"]);
        assert.equal(
          container.querySelector(".image-list-filter-bar")?.classList.contains(
            "filters-open"
          ),
          true
        );
      } else {
        assert.equal(
          container.querySelectorAll(
            ".gallery-filter-action-divider, .image-list-filter-action-divider"
          ).length,
          0
        );
        assert.deepEqual(
          galleryPanelOrder,
          width < 1000
            ? ["gallery-filter-fields", "theme-link", "gallery-filter-action"]
            : ["gallery-filter-fields", "gallery-filter-action", "theme-link"]
        );
        assert.equal(
          adminPanel.lastElementChild?.classList.contains("image-list-filter-action"),
          true
        );
      }

      const controls = [...container.querySelectorAll<HTMLElement>(
        ".facet-select-control"
      )];
      assert.equal(controls.length, 6);
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
      structures.push(controls.map((control) => (
        [...control.children]
          .map((child) => `${child.tagName}.${child.className}`)
          .join(">")
      )));

      for (const id of ["gallery-theme-facet", "admin-image-theme-facet"]) {
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
      assert.ok(setGalleryHarnessFilters && setAdminHarnessFilters);
      await React.act(async () => {
        setGalleryHarnessFilters?.(populatedFilters);
        setAdminHarnessFilters?.(populatedFilters);
        await Promise.resolve();
      });
      assert.equal(galleryClear.disabled, false);
      assert.equal(adminClear.disabled, false);

      if (
        mobileLayout
        && !container.querySelector(".image-list-filter-bar")?.classList.contains(
          "filters-open"
        )
      ) {
        const adminToggle = container.querySelector<HTMLButtonElement>(
          ".image-list-filter-toggle"
        );
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
        openAdminMenu.isConnected
          ? openAdminMenu.classList.contains("is-closing")
          : true,
        true,
        "清空必须收起已打开的后台 Facet 子菜单"
      );
      if (mobileLayout) {
        assert.equal(
          container.querySelector(".image-list-filter-bar")?.classList.contains(
            "filters-open"
          ),
          true,
          "移动后台清空不得关闭外层筛选面板"
        );
      }

      await React.act(async () => {
        dispatch(galleryClear, "click", { detail: 1 });
        await Promise.resolve();
      });
      assert.equal(galleryClearCalls, 1);
      assert.deepEqual(galleryFilterChanges, []);
      assert.equal(galleryClear.disabled, true);
      if (mobileLayout) {
        assert.equal(
          container.querySelector(".gallery-toolbar")?.classList.contains(
            "filters-open"
          ),
          true,
          "移动画廊清空不得关闭外层筛选面板"
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
        container.querySelector<HTMLButtonElement>(
          ".image-list-filter-toggle"
        )?.disabled,
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
        delete (elementPrototype as unknown as Record<string, unknown>)
          .getBoundingClientRect;
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
    assert.deepEqual(
      structure,
      structures[0],
      "所有清空动作临界视口都不得切换 FacetSelector DOM"
    );
  }
});
test("[Web/后台访问] 后台偏好五分钟内聚焦零请求且首次过期重验证命中 304", async () => {
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
  Object.assign(window, { localStorage });
  let preferenceReads = 0;
  let preferenceWrites = 0;
  const preferenceEtag = 'W/"preference-focus-v1"';
  const updatedPreferenceEtag = 'W/"preference-focus-v2"';
  const fetchStub = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ) => {
    const url = new URL(String(input), "https://imageshow.test");
    assert.equal(url.pathname, "/api/admin/preferences");
    if (init.method === "PATCH") {
      preferenceWrites += 1;
      return new Response(JSON.stringify({
        ok: true,
        preferences: { color_scheme: "light" }
      }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          etag: updatedPreferenceEtag
        }
      });
    }
    preferenceReads += 1;
    assert.equal(
      new Headers(init.headers).get("if-none-match"),
      preferenceEtag,
      "首次偏好 GET 必须复用 /auth/me 提供的验证器"
    );
    return new Response(null, {
      status: 304,
      headers: { etag: preferenceEtag }
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

  try {
    const { createRoot } = await import("react-dom/client");
    const {
      focusManager,
      QueryClient,
      QueryClientProvider
    } = await import("@tanstack/react-query");
    const { AdminPreferencesProvider, useAdminPreference } = await import(
      "../../../packages/web/src/hooks/useAdminPreferences.tsx"
    );
    const username = "preference-focus-test";
    const initialUpdatedAt = Date.now();
    const queryKey = [...queryKeys.adminPreferences, username] as const;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    client.setQueryData(queryKeys.me, {
      authenticated: true,
      username,
      role: "super",
      permissions: [],
      csrf_token: "preference-focus-token",
      application_version: "current-test",
      preferences: { color_scheme: "dark" },
      preferences_etag: preferenceEtag,
      version_settings: { enabled: true, link_enabled: true }
    });
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    let setColorScheme: ((value: "light" | "dark" | "system") => void)
      | undefined;

    function PreferenceProbe() {
      const [, setPreference] = useAdminPreference("color_scheme");
      setColorScheme = setPreference;
      return React.createElement("span", null, "ready");
    }

    await React.act(async () => {
      root.render(React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          AdminPreferencesProvider,
          {
            username,
            serverPreferences: { color_scheme: "dark" },
            serverPreferencesEtag: preferenceEtag,
            serverPreferencesUpdatedAt: initialUpdatedAt
          },
          React.createElement(PreferenceProbe)
        )
      ));
      await Promise.resolve();
    });
    assert.equal(preferenceReads, 0, "认证首帧快照新鲜时不得追加偏好 GET");

    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await Promise.resolve();
    });
    assert.equal(preferenceReads, 0, "五分钟内重新聚焦不得读取偏好");

    const current = client.getQueryData(queryKey);
    assert.ok(current);
    client.setQueryData(queryKey, current, {
      updatedAt: initialUpdatedAt - 5 * 60 * 1000 - 1
    });
    await React.act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      for (let attempt = 0; attempt < 20 && preferenceReads === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    assert.equal(preferenceReads, 1, "过期快照应在重新聚焦时重验证一次");
    assert.deepEqual(client.getQueryData(queryKey), {
      preferences: { color_scheme: "dark" },
      etag: preferenceEtag
    }, "304 应继续使用认证首帧的偏好快照");

    let authReadAborted = false;
    let authReadStarted = false;
    const staleAuthRead = client.fetchQuery({
      queryKey: queryKeys.me,
      staleTime: 0,
      queryFn: ({ signal }) => new Promise<never>((_resolve, reject) => {
        authReadStarted = true;
        signal.addEventListener("abort", () => {
          authReadAborted = true;
          reject(signal.reason);
        }, { once: true });
      })
    }).catch(() => undefined);
    assert.equal(authReadStarted, true);
    await React.act(async () => {
      setColorScheme?.("light");
      for (let attempt = 0; attempt < 30 && preferenceWrites === 0; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    });
    await staleAuthRead;
    assert.equal(preferenceWrites, 1);
    assert.equal(
      authReadAborted,
      true,
      "偏好 PATCH 必须取消可能携带旧偏好和 ETag 的在途 /auth/me"
    );
    assert.deepEqual(client.getQueryData(queryKeys.me), {
      authenticated: true,
      username,
      role: "super",
      permissions: [],
      csrf_token: "preference-focus-token",
      application_version: "current-test",
      preferences: { color_scheme: "light" },
      preferences_etag: updatedPreferenceEtag,
      version_settings: { enabled: true, link_enabled: true }
    });
    await React.act(async () => root.unmount());
    client.clear();
    focusManager.setFocused(undefined);
  } finally {
    const { focusManager } = await import("@tanstack/react-query");
    focusManager.setFocused(undefined);
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/后台访问] API 拒绝损坏成功响应且保留已有查询快照和安全 HTTP 错误", async () => {
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
      await assert.rejects(client.fetchQuery({
        queryKey: queryKeys.siteConfig,
        queryFn: () => api("/api/site-config")
      }), assertSafeError);
      assert.equal(client.getQueryData(queryKeys.siteConfig), undefined);
      assert.equal(client.getQueryState(queryKeys.siteConfig)?.status, "error");
      await assert.rejects(apiWithEtag("/api/site-config"), assertSafeError);
    }
    const prior = { site: { title: "可用快照" } };
    client.setQueryData(queryKeys.siteConfig, prior, { updatedAt: 123 });
    await assert.rejects(client.fetchQuery({
      queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config"), staleTime: 0
    }));
    assert.strictEqual(client.getQueryData(queryKeys.siteConfig), prior);
    assert.equal(client.getQueryState(queryKeys.siteConfig)?.dataUpdatedAt, 123);
    for (const value of [{ ok: true, items: [] }, [1, 2], null]) {
      globalThis.fetch = (async () => Response.json(value)) as typeof fetch;
      assert.deepEqual(await api("/api/site-config"), value);
    }
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as typeof fetch;
    assert.deepEqual(await api("/api/security-reports", { method: "POST" }), {});
    globalThis.fetch = (async () => new Response("<html>private proxy error</html>", { status: 502 })) as typeof fetch;
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
test("[Web/后台访问] 条件读取只让 304 复用旧 ETag，新的 200 表示必须自带验证器", async () => {
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
test("[Web/后台访问] 后台模块预加载只响应可执行意图并复用页面生命周期请求", async (t) => {
  let immediatePreloads = 0;
  const immediateBindings = preloadIntentProps(() => {
    immediatePreloads += 1;
  });
  immediateBindings.onPointerEnter?.();
  immediateBindings.onFocus?.();
  immediateBindings.onPointerDown?.();
  assert.equal(immediatePreloads, 3);

  assert.deepEqual(adminRoutePreloadPolicies.advancedConfig, {
    hover: "dwell",
    delayMs: 150
  });
  for (const [route, policy] of Object.entries(adminRoutePreloadPolicies)) {
    if (route !== "advancedConfig") assert.deepEqual(policy, { hover: "immediate" });
  }

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
  finishImport({ page: "advanced-config" });
  assert.deepEqual(await firstLoad, { page: "advanced-config" });
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
  Reflect.deleteProperty(globalThis, "window");
  try {
    const retryableLoader = createPublicRouteModuleLoader(() => {
      retryImportCount += 1;
      return new Promise<{ page: string }>((resolve, reject) => {
        attempts.push({ resolve, reject });
      });
    });
    retryableLoader.preload();
    retryableLoader.preload();
    const routeNavigation = retryableLoader.load();
    assert.equal(retryImportCount, 1);
    attempts[0]!.reject(new Error("passive preload failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(retryableLoader.passivePreloadFailed(), true);
    assert.equal(retryImportCount, 2);
    attempts[1]!.resolve({ page: "gallery" });
    assert.deepEqual(await routeNavigation, { page: "gallery" });
    assert.equal(retryableLoader.passivePreloadFailed(), false);
    assert.deepEqual(await retryableLoader.load(), { page: "gallery" });
    assert.equal(retryImportCount, 2);
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
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    writable: true,
    value: { location: { reload: () => { documentReloads += 1; } } }
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

  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  Object.assign(window, {
    matchMedia: (query: string) => ({
      matches: query === "(hover: hover) and (pointer: fine)",
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true
    })
  });
  const clock = installControlledClock(t, window as unknown as Window, {
    minimumControlledDelayMs: 150,
    includeGlobalTimers: true,
    includeDateNow: false
  });
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
    let dwellPreloads = 0;
    let bindings: ReturnType<typeof usePreloadIntentProps> | undefined;
    function Harness() {
      bindings = usePreloadIntentProps(() => {
        dwellPreloads += 1;
      }, adminRoutePreloadPolicies.advancedConfig);
      return React.createElement("button", bindings, "高级配置");
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });
    assert.ok(bindings);

    bindings.onPointerEnter({ pointerType: "mouse" } as never);
    await clock.advanceBy(60);
    bindings.onPointerLeave();
    await clock.advanceBy(110);
    assert.equal(dwellPreloads, 0, "短暂 hover 必须可取消");

    bindings.onPointerEnter({ pointerType: "touch" } as never);
    await clock.advanceBy(170);
    assert.equal(dwellPreloads, 0, "触摸进入不应伪装成 hover 意图");

    bindings.onPointerEnter({ pointerType: "mouse" } as never);
    await clock.advanceBy(149);
    assert.equal(dwellPreloads, 0, "dwell 门槛前不得预加载");
    await clock.advanceBy(1);
    assert.equal(dwellPreloads, 1, "持续鼠标 hover 应达到 dwell 门槛");

    bindings.onFocus();
    assert.equal(dwellPreloads, 2, "键盘 focus 应立即预加载");
    bindings.onPointerEnter({ pointerType: "mouse" } as never);
    bindings.onPointerDown();
    await clock.advanceBy(150);
    assert.equal(dwellPreloads, 3, "pointerdown 应立即加载并取消待定 dwell");

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
test("[Web/后台访问] 持久排序模型统一固定项、键盘移动、拖拽位置和分页焦点", () => {
  const entries = ["fixed", "one", "two", "three"].map((slug) => ({ slug }));
  const getKey = (entry: { slug: string }) => entry.slug;
  const isFixed = (entry: { slug: string }) => entry.slug === "fixed";

  assert.equal(
    reorderItemByDirection(entries, "one", "previous", getKey, isFixed).moved,
    false
  );
  const keyboard = reorderItemByDirection(
    entries,
    "two",
    "previous",
    getKey,
    isFixed
  );
  assert.deepEqual(keyboard.items.map(getKey), ["fixed", "two", "one", "three"]);
  const pointer = reorderItemByKey(
    keyboard.items,
    "two",
    "three",
    getKey,
    isFixed
  );
  assert.deepEqual(pointer.items.map(getKey), ["fixed", "one", "three", "two"]);
  assert.deepEqual(
    reorderPositionByKey(pointer.items, "three", getKey, isFixed),
    { position: 2, total: 3 }
  );
  assert.equal(reorderPageForKey(["fixed", "one", "three", "two"], "two", 2), 2);
});
test("[Web/后台访问] 后台图片数字页由单一目标查询直达并隔离分页 scope", async (t) => {
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
  const unsetScope = imageAdminPaginationScopeKey("unset", filters, 60);
  assert.notEqual(scope, pageSizeScope);
  assert.notEqual(scope, unsetScope);
  assert.equal(
    effectiveImageAdminPage({
      scopeKey: scope,
      page: 100,
      total: 6_000,
      totalUpdatedAt: 1
    }, scope),
    100
  );
  assert.equal(
    effectiveImageAdminPage({
      scopeKey: scope,
      page: 100,
      total: 6_000,
      totalUpdatedAt: 1
    }, unsetScope),
    1
  );
  const hiddenThemeScope = imageAdminPaginationScopeKey("unset", {
    ...emptyImageAdminFilters,
    theme: "night"
  }, 60);
  const emptyUnsetScope = imageAdminPaginationScopeKey(
    "unset",
    emptyImageAdminFilters,
    60
  );
  assert.equal(
    hiddenThemeScope,
    emptyUnsetScope,
    "无主题视图的隐藏主题值不得建立第二个查询 scope"
  );
  assert.deepEqual(
    resetImageAdminPage({
      scopeKey: hiddenThemeScope,
      page: 8,
      total: 480,
      totalUpdatedAt: 12
    }, hiddenThemeScope),
    {
      scopeKey: hiddenThemeScope,
      page: 1,
      total: 480,
      totalUpdatedAt: 12
    },
    "只清除无主题视图的隐藏主题值时也必须显式返回第一页"
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
    return new Response(JSON.stringify({
      ok: true,
      items: [],
      total: 6_000
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ETag: 'W/"admin-page"'
      }
    });
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

  const unsetOptions = adminImageListQuery(
    "unset",
    filters,
    unsetScope,
    1,
    60
  );
  const previousUnsetFetch = globalThis.fetch;
  let unsetUrl = "";
  globalThis.fetch = async (input) => {
    unsetUrl = String(input);
    return new Response(JSON.stringify({ ok: true, items: [], total: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  try {
    const { QueryClient } = await import("@tanstack/react-query");
    await unsetOptions.queryFn({
      client: new QueryClient(),
      signal: new AbortController().signal
    });
  } finally {
    globalThis.fetch = previousUnsetFetch;
  }
  const unsetTarget = new URL(unsetUrl, "https://imageshow.test");
  assert.equal(unsetTarget.searchParams.get("status"), "ready");
  assert.equal(unsetTarget.searchParams.get("theme"), "none");
  assert.equal(unsetTarget.searchParams.get("page"), "1");

});
test("[Web/后台访问] 后台数字页 Hook 在 Strict Mode 下直达、重试并一次夹紧", async (t) => {
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
    if (
      url.searchParams.get("status") === "ready"
      && page === 50
      && page50Attempts++ === 0
    ) {
      return new Response(JSON.stringify({
        ok: false,
        code: "controlled_failure",
        error: "controlled page failure",
        details: {}
      }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }
    if (url.searchParams.get("theme") === "none") {
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
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
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
    const tree = () => React.createElement(
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
    const finishPage100 = resolvePage100 as (
      ((response: Response) => void) | null
    );
    assert.ok(finishPage100);
    await React.act(async () => finishPage100(new Response(JSON.stringify({
      ok: true,
      items: [],
      total: 6_000
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
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
    props = { ...props, view: "unset" };
    await React.act(async () => root.render(tree()));
    await waitFor(() => resolveUnsetPage !== null && page75Aborted);
    assert.equal(latest.pageNumber, 1, "scope 变化的同一渲染必须立即使用第 1 页");
    assert.equal(latest.totalPages, 1, "新 scope 不得沿用旧总页数");
    assert.equal(latest.total, 0, "新 scope 不得沿用旧总项数");
    const finishUnsetPage = resolveUnsetPage as (
      ((response: Response) => void) | null
    );
    assert.ok(finishUnsetPage);
    await React.act(async () => finishUnsetPage(new Response(JSON.stringify({
      ok: true,
      items: [],
      total: 180
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
    await waitFor(() => page75Aborted && latest.total === 180);
    assert.equal(latest.totalPages, 3);
    assert.equal(requests.some((value) => {
      const url = new URL(value);
      return url.searchParams.get("theme") === "none"
        && url.searchParams.get("page") !== "1";
    }), false);

    const beforeRouteReturn = requests.length;
    props = { ...props, view: "ready" };
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
    await waitFor(() => (
      latest.pageNumber === 2
      && latest.total === 6_000
      && !latest.isFetching
    ));
    const readyPages = requests
      .map((value) => new URL(value))
      .filter((url) => (
        url.searchParams.get("status") === "ready"
        && url.searchParams.get("theme") !== "none"
      ))
      .map((url) => url.searchParams.get("page"));
    assert.equal(readyPages.filter((page) => page === "50").length, 2);
    assert.equal(readyPages.filter((page) => page === "2").length, 1);
    assert.equal(
      readyPages.some((page) => (
        Number(page) > 2
        && page !== "50"
        && page !== "75"
        && page !== "100"
      )),
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
    const finishPageSizeRequest = resolvePageSizeRequest as (
      ((response: Response) => void) | null
    );
    assert.ok(finishPageSizeRequest);
    await React.act(async () => finishPageSizeRequest(new Response(JSON.stringify({
      ok: true,
      items: [],
      total: 6_000
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));
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
test("[Web/后台访问] 图片后台真实挂载保持弹窗页码、操作后夹紧并按权限隐藏永久删除", async (t) => {
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
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
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
  const previousConsoleError = console.error;
  const expectedListErrors: unknown[][] = [];
  const expectedMutationErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    if (args[0] === "[ImageShow] image_admin.list_load") {
      expectedListErrors.push(args);
      return;
    }
    if (args[0] === "[ImageShow] image_admin.trash_or_purge") {
      expectedMutationErrors.push(args);
      return;
    }
    previousConsoleError(...args);
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider } = await import(
      "../../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { AdminPreferencesProvider } = await import(
      "../../../packages/web/src/hooks/useAdminPreferences.tsx"
    );
    const { ActionFeedbackProvider } = await import(
      "../../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx"
    );
    const { registerHooks } = await import("node:module");
    const cssHooks = registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith(".css")) {
          return { format: "module", source: "", shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    const { ImageAdmin } = await import(
      "../../../packages/web/src/pages/admin/images/ImageAdmin.tsx"
    ).finally(() => cssHooks.deregister());
    const { ADMIN_ICONS } = await import(
      "../../../packages/web/src/components/icon/admin-icons.generated.ts"
    );
    const container = document.getElementById("root");
    assert.ok(container);

    const jsonResponse = (value: unknown) => new Response(
      JSON.stringify({ ok: true, ...value as Record<string, unknown> }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
    const image = (serial: string): AdminImageListItemDto => ({
      ...galleryCard(`00000000-0000-7000-8000-${serial}`),
      description: "",
      object_url: `/full/${serial.slice(-2)}/00000000-0000-7000-8000-${serial}.webp`,
      source: "",
      thumb_url: "",
      status: "deleted",
      purge_pending: false,
      object_key: `${serial.slice(-2)}/00000000-0000-7000-8000-${serial}.webp`,
      storage_slug: "local",
      md5: serial.padStart(32, "0").slice(-32),
      original: "",
      image_size: 1,
      deleted_at: "2026-08-15T00:00:00.000Z",
      created_at: "2026-08-14T00:00:00.000Z",
      updated_at: "2026-08-15T00:00:00.000Z"
    });
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
        target.dispatchEvent(new window.Event("submit", {
          bubbles: true,
          cancelable: true
        }));
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };
    const buttonWithText = (text: string) => {
      const target = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((button) => button.textContent?.includes(text));
      assert.ok(target, `missing ${text} button`);
      return target;
    };

    const runMutationScenario = async (
      mode: "restore" | "purge" | "purge-unknown"
    ) => {
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
        backends: [{
          slug: "local",
          display_name: "本地存储",
          enabled: true,
          is_default: true
        }]
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
            return new Response(JSON.stringify({
              ok: false,
              code: "controlled_failure",
              error: "controlled page failure",
              details: {}
            }), {
              status: 500,
              headers: { "Content-Type": "application/json" }
            });
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
                results: [{
                  id: "00000000-0000-7000-8000-000000000002",
                  status: "restored"
                }]
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
          root.render(React.createElement(
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
          ));
        });
        await waitFor(
          () => listRequests.length === 1 && /第 1 \/ 2 页/.test(
            container.textContent ?? ""
          ),
          `${mode} scenario initial page did not load`
        );
        await click(buttonWithText("下一页"));
        await waitFor(
          () => [...container.querySelectorAll("button")].some(
            (button) => button.textContent?.includes("重试")
          ),
          `${mode} scenario page 2 failure did not render`
        );
        const pageStatus = container.querySelector<HTMLElement>(
          '.image-admin-head-copy > p[role="status"]'
        );
        assert.ok(pageStatus);
        assert.equal(
          pageStatus.textContent,
          "第 2 / 2 页 · 共 2 项",
          "失败且无页数据时不得伪造本页 0 项"
        );
        await click(buttonWithText("重试"));
        await waitFor(
          () => pageTwoStarted,
          `${mode} scenario page 2 request did not start`
        );
        assert.equal(
          pageStatus.textContent,
          "第 2 / 2 页 · 共 2 项 · 加载中",
          "加载期间只应显示稳定分页元数据和加载状态"
        );
        const finishPageTwo = resolvePageTwo as (
          ((response: Response) => void) | null
        );
        assert.ok(finishPageTwo);
        await React.act(async () => finishPageTwo(jsonResponse({
          items: [image("000000000002")],
          total: 2
        })));
        await waitFor(
          () => pageStatus.textContent === "第 2 / 2 页 · 共 2 项 · 本页 1 项",
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
            () => Boolean(document.querySelector('[data-dialog-frame]')),
            "purge confirmation did not open"
          );
          await click(buttonWithText("取消"));
          await waitFor(
            () => !document.querySelector('[data-dialog-frame]'),
            "purge confirmation did not close"
          );
          assert.equal(
            listRequests.length,
            listRequestsBeforeDialog,
            "关闭确认弹窗不得重取当前数字页"
          );
          assert.match(container.textContent ?? "", /第 2 \/ 2 页/);
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
            () => Boolean(document.querySelector('[data-dialog-frame]')),
            "single purge confirmation did not open"
          );
          assert.equal(mutationRequests, 0);
          const purgeDialog = document.querySelector<HTMLElement>(
            '[data-dialog-frame]'
          );
          assert.ok(purgeDialog);
          const permanentDelete = purgeDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="永久删除"]'
          );
          assert.ok(permanentDelete);
          assert.equal(
            permanentDelete.querySelector("path")?.getAttribute("d"),
            ADMIN_ICONS["delete-bin-7-line"]
          );
          const purgeForm = purgeDialog.querySelector<HTMLFormElement>("form");
          assert.ok(purgeForm);
          await submitForm(purgeForm);
          assert.equal(mutationRequests, 0, "首次弹窗确认只能进入二次确认态");
          await waitFor(
            () => Boolean(purgeDialog.querySelector(
              'button[aria-label="确认删除"]'
            )),
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
            () => Boolean(purgeDialog.querySelector(
              'button[aria-label="正在删除"]'
            )),
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
          const unknownMessage = "操作结果未能确认，图片列表已刷新，但无法确认操作已经收口，请稍后再次刷新";
          await waitFor(
            () => Boolean(document.querySelector(
              ".confirm-dialog-error"
            )?.textContent?.includes(unknownMessage)),
            "unknown purge result was not presented inside the dialog"
          );
          const purgeDialog = document.querySelector<HTMLElement>(
            '[data-dialog-frame]'
          );
          assert.ok(purgeDialog);
          const failedConfirm = purgeDialog.querySelector<HTMLButtonElement>(
            "button.danger-button"
          );
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
          assert.ok(document.querySelector('[data-dialog-frame]'));
          assert.match(
            document.querySelector(".confirm-dialog-error")?.textContent ?? "",
            /操作结果未能确认/,
            "弹窗内错误不得按页面反馈时长自动消失"
          );
          assert.equal(mutationRequests, 1);
          await click(buttonWithText("取消"));
          await waitFor(
            () => !document.querySelector('[data-dialog-frame]'),
            "unknown purge dialog did not close explicitly"
          );
          const reopenPurge = container.querySelector<HTMLButtonElement>(
            'button[aria-label^="永久删除图片："]'
          );
          assert.ok(reopenPurge);
          await click(reopenPurge);
          await waitFor(
            () => Boolean(document.querySelector('[data-dialog-frame]')),
            "purge dialog did not reopen after an unknown result"
          );
          const reopenedDialog = document.querySelector<HTMLElement>(
            '[data-dialog-frame]'
          );
          assert.ok(reopenedDialog);
          assert.equal(reopenedDialog.querySelector(".confirm-dialog-error"), null);
          const reopenedConfirm = reopenedDialog.querySelector<HTMLButtonElement>(
            'button[aria-label="永久删除"]'
          );
          assert.ok(reopenedConfirm);
          assert.equal(reopenedConfirm.disabled, false);
          await click(buttonWithText("取消"));
          await waitFor(
            () => !document.querySelector('[data-dialog-frame]'),
            "reopened purge dialog did not close"
          );
          return;
        }
        const expectedResult = mode === "restore"
          ? "已恢复 1 张"
          : "已永久删除 1 张";
        await waitFor(
          () => postMutationRefreshStarted
            && (mode === "purge"
              || (container.textContent ?? "").includes(expectedResult)),
          `${mode} list refresh did not start at the expected result boundary`
        );
        assert.ok(
          document.getElementById(
            "admin-image-select-00000000-0000-7000-8000-000000000002"
          ),
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
          assert.ok(document.querySelector('[data-dialog-frame]'));
          assert.equal(
            (container.textContent ?? "").includes(expectedResult),
            false
          );
        }
        const finishPostMutationRefresh = resolvePostMutationRefresh as (
          ((response: Response) => void) | null
        );
        assert.ok(finishPostMutationRefresh);
        await React.act(async () => finishPostMutationRefresh(jsonResponse({
          items: [],
          total: 1
        })));
        await waitFor(
          () => mutationRequests === 1
            && /第 1 \/ 1 页/.test(container.textContent ?? "")
            && listRequests.at(-1) === 1,
          `${mode} scenario did not clamp to the new last page`
        );
        assert.deepEqual(
          listRequests.slice(-2),
          [2, 1],
          `${mode} must refetch the target page once and clamp directly`
        );
        if (mode === "purge") {
          await waitFor(
            () => !document.querySelector('[data-dialog-frame]')
              && (container.textContent ?? "").includes(expectedResult),
            "purge result did not become visible after the slow dialog operation"
          );
          assert.ok(document.querySelector(
            ".image-admin-feedback-region .action-feedback-success"
          ));
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
      client.setQueryData(queryKeys.ingestionVocabulary, {
        themes: [],
        tags: [],
        authors: []
      });
      client.setQueryData(queryKeys.storageOptions, {
        backends: [{
          slug: "local",
          display_name: "本地存储",
          enabled: true,
          is_default: true
        }]
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
                reject: () => reject(new Error(
                  "controlled trash list refresh failure"
                ))
              });
            });
          }
          return response;
        }
        if (url.pathname === "/api/admin/ingestion/vocabulary") {
          return jsonResponse({ themes: [], tags: [], authors: [] });
        }
        if (url.pathname === "/api/admin/images/trash") {
          assert.equal(init?.method, "POST");
          const body = JSON.parse(String(init?.body)) as { ids: string[] };
          trashBodies.push(body);
          return new Promise<Response>((resolve) => {
            releaseTrashMutations.push(() => {
              for (const id of body.ids) trashedIds.add(id);
              deferNextTrashRefresh = true;
              resolve(jsonResponse({
                requested: body.ids.length,
                trashed: body.ids.length,
                ignored: 0,
                results: body.ids.map((id) => ({ id, status: "trashed" }))
              }));
            });
          });
        }
        if (url.pathname === "/api/admin/logs/client-errors") {
          return jsonResponse({});
        }
        throw new Error(`unexpected trash interface request: ${url.pathname}`);
      };

      const root = createRoot(container);
      try {
        await React.act(async () => {
          root.render(React.createElement(
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
                    React.createElement(ImageAdmin)
                  )
                )
              )
            )
          ));
        });
        await waitFor(
          () => container.querySelectorAll(".admin-image-card").length === 2,
          "trash interface scenario did not load ready items"
        );
        const selectionTargets = [
          ...container.querySelectorAll<HTMLElement>(
            ".admin-image-card-checkbox-hit-area"
          )
        ];
        assert.equal(selectionTargets.length, 2);
        await click(selectionTargets[0]!);
        await click(selectionTargets[1]!);
        await waitFor(
          () => /已选 2/.test(container.textContent ?? ""),
          "trash interface scenario did not select both items"
        );

        let batchTrash = buttonWithText("批量删除");
        await click(batchTrash);
        assert.equal(trashBodies.length, 0);
        assert.equal(batchTrash.getAttribute("aria-pressed"), "true");
        assert.match(batchTrash.textContent ?? "", /确认删除/);
        assert.equal(document.querySelector('[data-dialog-frame]'), null);

        await click(selectionTargets[0]!);
        await waitFor(
          () => /已选 1/.test(container.textContent ?? "")
            && Boolean(buttonWithText("批量删除")),
          "selection change did not disarm frozen batch delete"
        );
        assert.equal(trashBodies.length, 0);
        await click(selectionTargets[0]!);
        await waitFor(
          () => /已选 2/.test(container.textContent ?? ""),
          "trash interface scenario did not restore both selections"
        );

        batchTrash = buttonWithText("批量删除");
        await click(batchTrash);
        await click(buttonWithText("确认删除"));
        await waitFor(
          () => trashBodies.length === 1,
          "batch trash did not submit after the second click"
        );
        assert.deepEqual(trashBodies[0], {
          ids: initialReadyItems.map((item) => item.id)
        });
        const pendingBatchTrash = container.querySelector<HTMLButtonElement>(
          '.two-step-confirm-text-button[aria-label="正在删除"]'
        );
        assert.ok(pendingBatchTrash);
        assert.equal(
          pendingBatchTrash.querySelector("path")?.getAttribute("d"),
          ADMIN_ICONS["delete-bin-5-line"]
        );
        await React.act(async () => releaseTrashMutations.shift()?.());
        await waitFor(
          () => pendingTrashRefreshes.length === 1
            && (container.textContent ?? "").includes(
              "已移入回收站 2 张"
            ),
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
        assert.ok(container.querySelector(
          ".image-admin-feedback-region .action-feedback-success"
        ));
        assert.doesNotMatch(container.textContent ?? "", /0 张未处理/);
        await React.act(async () => pendingTrashRefreshes.shift()?.resolve());
        await waitFor(
          () => Boolean(buttonWithText("批量删除"))
            && !container.querySelector('[aria-busy="true"].two-step-confirm-text-button')
            && container.querySelectorAll(".admin-image-card").length === 1
            && Boolean(document.getElementById(
              `admin-image-select-${readyItems[2]!.id}`
            )),
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
        assert.equal(document.querySelector('[data-dialog-frame]'), null);
        await React.act(async () => releaseTrashMutations.shift()?.());
        await waitFor(
          () => pendingTrashRefreshes.length === 1
            && (container.textContent ?? "").includes(
              "已移入回收站 1 张"
            ),
          "single trash result was not rendered before list refresh"
        );
        assert.ok(document.getElementById(
          `admin-image-select-${readyItems[2]!.id}`
        ));
        await React.act(async () => pendingTrashRefreshes.shift()?.reject());
        await waitFor(
            () => !container.querySelector('button[aria-label^="删除中："]')
            && (container.textContent ?? "").includes(
              "已移入回收站 1 张；图片列表刷新失败，请重新加载页面"
            ),
          "single trash did not surface the real list refresh failure"
        );
        assert.equal(
          container.querySelectorAll(".admin-image-card").length,
          1,
          "刷新失败时必须保留缓存卡片并明确要求重新加载"
        );
        assert.ok(container.querySelector(
          ".image-admin-feedback-region .action-feedback-error"
        ));
      } finally {
        await React.act(async () => root.unmount());
        client.clear();
        globalThis.fetch = previousFetch;
        container.replaceChildren();
      }
    };

    await runMutationScenario("restore");
    await runMutationScenario("purge");
    await runMutationScenario("purge-unknown");
    await runTrashScenario();
    assert.deepEqual(
      expectedListErrors.map((args) => (
        args[1] as { code?: string } | undefined
      )?.code).filter((code) => code === "controlled_failure"),
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
test("[Web/后台访问] 图片元数据保存按实际字段失效投影并复用权威详情", async () => {
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
    ]) client.setQueryData(key, {});
    client.setQueryData([...queryKeys.publicImageDetail, "image-1"], {});
    client.setQueryData([...queryKeys.adminImageInfo, "image-1"], {});
    return client;
  };
  const invalidated = (
    client: InstanceType<typeof QueryClient>,
    key: readonly unknown[]
  ) => client.getQueryState(key)?.isInvalidated === true;

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
    invalidated(titleClient, [...queryKeys.publicImageDetail, "image-1"]),
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
  ]) assert.equal(invalidated(membershipClient, key), true, key[0]);
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
      [...queryKeys.publicImageDetail, "image-1"]
    ),
    true
  );

  titleClient.clear();
  membershipClient.clear();
  missingSnapshotClient.clear();
});
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
    "../../../packages/web/src/pages/admin/Overview.tsx"
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
test("[Web/后台访问] 图片详情原图入口真实挂载覆盖公开开关、认证状态与后台调用方", async () => {
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
      "../../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { ImageDetailModal } = await import(
      "../../../packages/web/src/components/image/ImageDetailModal.tsx"
    );
    const container = document.getElementById("root");
    assert.ok(container);
    const publicItem = (diffOriginal: boolean): PublicImageItem => ({
      id: "00000000-0000-7000-8000-000000000544",
      title: "原图入口真值表",
      description: "",
      source: "",
      object_url: "https://static.example.com/full/544.webp",
      thumb_url: "",
      device: "pc",
      brightness: "dark",
      theme: "night",
      author: "",
      tags: ["blue", "stars"],
      width: 1600,
      height: 900,
      diff_original: diffOriginal,
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
      publicOriginalButton,
      diffOriginal = true,
      admin = false,
      objectUrl,
      detailLoading = false,
      detailError = "",
      staticUrl = "https://static.example.com"
    }: {
      auth: AuthScenario;
      publicOriginalButton: boolean;
      diffOriginal?: boolean;
      admin?: boolean;
      objectUrl?: string;
      detailLoading?: boolean;
      detailError?: string;
      staticUrl?: string;
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
      client.setQueryData(queryKeys.siteConfig, {
        site: {
          static_url: staticUrl,
          gallery: { public_original_button: publicOriginalButton }
        }
      });
      client.setQueryData(queryKeys.galleryFacets, {
        devices: [],
        brightnesses: [],
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
                        id: publicItem(diffOriginal).id,
                        diff_original: diffOriginal
                      }),
                      admin: true,
                      storageLabel: "本地存储",
                      onClose() {}
                    })
                  : React.createElement(ImageDetailModal, {
                      item: { ...publicItem(diffOriginal), ...(objectUrl === undefined ? {} : { object_url: objectUrl }) },
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
      const pendingTitle = await renderScenario({ auth: "guest", publicOriginalButton: false, ...state });
      assert.equal(pendingTitle.titleText, "原图入口真值表");
      assert.equal(pendingTitle.titleHref, null, "占位标题不得生成当前页空链接");
      assert.equal(pendingTitle.titleFocusable, false, "无直链标题不占用 Tab 焦点");
    }
    const loadedTitle = await renderScenario({ auth: "guest", publicOriginalButton: false });
    assert.equal(loadedTitle.titleHref, "https://static.example.com/full/544.webp");
    assert.equal(loadedTitle.titleFocusable, true);

    for (const auth of ["pending", "expired", "guest"] as const) {
      assert.equal((await renderScenario({
        auth,
        publicOriginalButton: false
      })).present, false, `${auth} 不得绕过关闭的公开开关`);
    }
    const publicEnabled = await renderScenario({
      auth: "guest",
      publicOriginalButton: true
    });
    assert.equal(publicEnabled.present, true);
    assert.equal(
      publicEnabled.href,
      "https://static.example.com/link/00000000-0000-7000-8000-000000000544"
    );
    for (const admin of [false, true]) {
      const sameOrigin = await renderScenario({
        auth: admin ? "super" : "guest", publicOriginalButton: true, admin,
        staticUrl: "https://img.example.com/static"
      });
      assert.equal(sameOrigin.href, "https://img.example.com/static/link/00000000-0000-7000-8000-000000000544");
    }
    assert.equal(
      publicEnabled.sourceHref,
      null,
      "公开卡片不应把任意长度来源地址预载进列表响应"
    );
    assert.equal(publicEnabled.sourceAriaDisabled, "true");
    assert.match(publicEnabled.publicProperties, /主题夜景/);
    assert.match(publicEnabled.publicProperties, /标签蓝色星空/);
    assert.deepEqual(
      publicEnabled.actionClasses.map((className) => (
        className.includes("image-detail-source") ? "source" : "original"
      )),
      ["source", "original"],
      "来源必须位于原图左侧"
    );
    for (const auth of ["image", "super"] as const) {
      assert.equal((await renderScenario({
        auth,
        publicOriginalButton: false
      })).present, true, `${auth} 管理员必须复用既有认证结果显示原图`);
    }
    assert.equal((await renderScenario({
      auth: "pending",
      publicOriginalButton: false,
      admin: true
    })).present, true, "后台调用方必须继续由 admin 上下文显示原图");
    const unavailableOriginal = await renderScenario({
      auth: "guest",
      publicOriginalButton: true,
      diffOriginal: false
    });
    assert.equal(unavailableOriginal.present, true);
    assert.equal(unavailableOriginal.href, null);
    assert.equal(unavailableOriginal.ariaDisabled, "true");
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
test("[Web/后台访问] 作者链接保存直接采用权威 DTO 更新原生提示且不重读作者列表", async () => {
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
  let holdAuthorRead = false;
  let releaseAuthorRead!: (response: Response) => void;
  let oldReadSignal: AbortSignal | null | undefined;
  const requestedAuthorPaths: string[] = [];
  const submittedBodies: unknown[] = [];
  const initialAuthor = {
    slug: "author-profile-test",
    display_name: "Profile Test",
    link: "https://example.com/profile",
    image_count: 0,
    derived_identity: null
  };
  const committedAuthor = {
    ...initialAuthor,
    link: "https://weibo.com/u/4444444444",
    derived_identity: { provider: "weibo", id: "4444444444" }
  };
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  const fetchStub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://imageshow.test").pathname;
    const method = String(init?.method ?? "GET").toUpperCase();
    requestedAuthorPaths.push(`${method} ${path}`);
    if (path === "/api/admin/authors" && method === "GET") {
      authorGets += 1;
      if (holdAuthorRead) {
        oldReadSignal = init?.signal;
        return new Promise<Response>((resolve) => { releaseAuthorRead = resolve; });
      }
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
      "../../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const { ActionFeedbackProvider } = await import(
      "../../../packages/web/src/components/feedback/ActionFeedbackRegion.tsx"
    );
    const { VocabularyAdmin } = await import(
      "../../../packages/web/src/pages/admin/VocabularyAdmin.tsx"
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
      holdAuthorRead = true;
      await React.act(async () => {
        void client.refetchQueries({ queryKey: queryKeys.authors, exact: true });
      });
      assert.ok(releaseAuthorRead);
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
      assert.equal(oldReadSignal?.aborted, true, "发布保存结果前取消旧作者列表读取");
      await React.act(async () => {
        releaseAuthorRead(jsonResponse({ ok: true, items: [initialAuthor] }));
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      assert.deepEqual(client.getQueryData<{ items: unknown[] }>(queryKeys.authors),
        { ok: true, items: [committedAuthor] }, "不响应取消的旧 GET 也不能覆盖保存后的 DTO");
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
      "../../../packages/web/src/components/actions/TwoStepConfirmIconButton.tsx"
    );
    const { ADMIN_ICONS } = await import(
      "../../../packages/web/src/components/icon/admin-icons.generated.ts"
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
test("[Web/后台访问] 认证过期事件在同一在途窗口只触发一次权威刷新", async () => {
  const coordinator = new AuthSessionRefreshCoordinator();
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let refreshCount = 0;
  const refresh = async () => {
    refreshCount += 1;
    await refreshGate;
  };

  const first = coordinator.run(refresh);
  const second = coordinator.run(refresh);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(refreshCount, 1);
  releaseRefresh();
  await Promise.all([first, second]);

  await coordinator.run(async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 2);
});
test("[Web/后台访问] 认证刷新失败后会释放在途状态并允许成功重试", async () => {
  const coordinator = new AuthSessionRefreshCoordinator();
  let refreshCount = 0;

  await assert.rejects(
    coordinator.run(async () => {
      refreshCount += 1;
      throw new Error("refresh failed");
    }),
    /refresh failed/
  );

  await coordinator.run(async () => {
    refreshCount += 1;
  });
  assert.equal(refreshCount, 2);
});
test("[Web/后台访问] 认证会话恢复保持最新刷新并只注册一个过期监听器", async () => {
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
  Object.assign(window, { localStorage });

  const activeAuthListeners = new Set<EventListenerOrEventListenerObject>();
  let authListenerAdds = 0;
  let authListenerRemoves = 0;
  const addWindowEventListener = window.addEventListener.bind(window);
  const removeWindowEventListener = window.removeEventListener.bind(window);
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (type === authExpiredEvent && listener) {
      authListenerAdds += 1;
      activeAuthListeners.add(listener);
    }
    if (listener) addWindowEventListener(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) => {
    if (type === authExpiredEvent && listener) {
      authListenerRemoves += 1;
      activeAuthListeners.delete(listener);
    }
    if (listener) removeWindowEventListener(type, listener, options);
  }) as typeof window.removeEventListener;

  let fetchCount = 0;
  const fetchStub = async (input: RequestInfo | URL) => {
    assert.equal(String(input), "/api/admin/auth/me");
    fetchCount += 1;
    return new Response(JSON.stringify({
      ok: true,
      authenticated: true,
      username: `auth-recovery-${fetchCount}`,
      role: "super",
      permissions: [],
      csrf_token: `csrf-${fetchCount}`,
      application_version: "current-test",
      preferences: {},
      preferences_etag: `W/"auth-recovery-preferences-${fetchCount}"`,
      version_settings: { enabled: true, link_enabled: true }
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

  try {
    const { createRoot } = await import("react-dom/client");
    const { QueryClient, QueryClientProvider } = await import(
      "@tanstack/react-query"
    );
    const { MemoryRouter } = await import("react-router");
    const { AuthSessionProvider, useAuthMe } = await import(
      "../../../packages/web/src/hooks/useAuthSession.tsx"
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);

    let authIsFetching = true;
    function AuthProbe() {
      const query = useAuthMe();
      authIsFetching = query.isFetching;
      return React.createElement(
        "span",
        null,
        query.data?.authenticated ? query.data.username : "pending"
      );
    }
    const tree = () => React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/admin"] },
          React.createElement(
            AuthSessionProvider,
            null,
            React.createElement(AuthProbe)
          )
        )
      )
    );
    const settleUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await React.act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        if (predicate()) return;
      }
      assert.fail(
        "auth session recovery did not settle: "
          + `text=${container.textContent} fetches=${fetchCount} `
          + `listeners=${activeAuthListeners.size}`
      );
    };

    await React.act(async () => root.render(tree()));
    await settleUntil(() => (
      !authIsFetching
      && container.textContent === `auth-recovery-${fetchCount}`
    ));
    const initialFetchCount = fetchCount;
    assert.ok(initialFetchCount >= 1);
    assert.equal(activeAuthListeners.size, 1);
    const listenerCountsAfterMount = {
      adds: authListenerAdds,
      removes: authListenerRemoves
    };

    await React.act(async () => root.render(tree()));
    assert.deepEqual({
      adds: authListenerAdds,
      removes: authListenerRemoves
    }, listenerCountsAfterMount, "普通重渲染不得重绑认证过期监听器");

    await React.act(async () => {
      window.dispatchEvent(new window.Event(authExpiredEvent));
      window.dispatchEvent(new window.Event(authExpiredEvent));
      await Promise.resolve();
    });
    await settleUntil(() => (
      !authIsFetching
      && fetchCount === initialFetchCount + 1
      && container.textContent === `auth-recovery-${fetchCount}`
    ));
    assert.equal(
      fetchCount,
      initialFetchCount + 1,
      "同一在途窗口的过期事件应合并为一次最新 refetch"
    );
    assert.equal(activeAuthListeners.size, 1);
    assert.deepEqual({
      adds: authListenerAdds,
      removes: authListenerRemoves
    }, listenerCountsAfterMount);

    await React.act(async () => root.unmount());
    assert.equal(activeAuthListeners.size, 0);
    assert.equal(authListenerRemoves, authListenerAdds);
    window.dispatchEvent(new window.Event(authExpiredEvent));
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fetchCount, initialFetchCount + 1, "卸载后不得保留认证刷新入口");
    client.clear();
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
test("[Web/后台访问] 缩略图真实挂载只请求一次并忽略快速换源的迟到结果", async () => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body></body></html>"
  );
  const React = await import("react");
  const requestAnimationFrame = (callback: FrameRequestCallback) => (
    setTimeout(() => callback(Date.now()), 0) as unknown as number
  );
  const cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  Object.assign(window, { requestAnimationFrame, cancelAnimationFrame });

  const installedGlobals = {
    window,
    self: window,
    document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    HTMLImageElement: window.HTMLImageElement,
    Event: window.Event,
    EventTarget: window.EventTarget,
    MutationObserver: window.MutationObserver,
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

  const imagePrototype = window.HTMLImageElement.prototype;
  const originalSetAttribute = imagePrototype.setAttribute;
  const sourceWrites: string[] = [];
  imagePrototype.setAttribute = function setAttribute(name, value) {
    if (name.toLowerCase() === "src") sourceWrites.push(String(value));
    return originalSetAttribute.call(this, name, value);
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { flushSync } = await import("react-dom");
    const { ThumbImage } = await import(
      "../../../packages/web/src/components/image/ThumbImage.tsx"
    );

    const settleReact = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };
    const imageWithSource = (container: HTMLElement, source: string) => (
      [...container.querySelectorAll("img")].find(
        (image) => image.getAttribute("src") === source
      )
    );

    for (const lateOutcome of ["load", "error"] as const) {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      const prefix = `https://static.example.test/${lateOutcome}`;
      const sourceA = `${prefix}-a.webp`;
      const sourceB = `${prefix}-b.webp`;
      const sourceC = `${prefix}-c.webp`;
      const startWrite = sourceWrites.length;
      const renderThumb = (source: string) => React.createElement(
        React.StrictMode,
        null,
        React.createElement(ThumbImage, { src: source, alt: "测试缩略图" })
      );

      await React.act(async () => {
        root.render(renderThumb(sourceA));
        await settleReact();
      });
      const imageA = imageWithSource(container, sourceA);
      assert.ok(imageA);
      await React.act(async () => {
        imageA.dispatchEvent(new window.Event("load"));
        await settleReact();
      });
      assert.equal(
        container.querySelector("img.is-ready")?.getAttribute("src"),
        sourceA
      );

      await React.act(async () => {
        root.render(renderThumb(sourceB));
        await settleReact();
      });
      const imageB = imageWithSource(container, sourceB);
      assert.ok(imageB);

      await React.act(async () => {
        imageB.dispatchEvent(new window.Event(lateOutcome));
        flushSync(() => root.render(renderThumb(sourceC)));
        await settleReact();
      });
      assert.equal(
        container.querySelector("img.is-ready")?.getAttribute("src"),
        sourceA
      );
      const imageC = imageWithSource(container, sourceC);
      assert.ok(imageC);
      assert.deepEqual(
        sourceWrites.slice(startWrite),
        [sourceA, sourceB, sourceC]
      );

      await React.act(async () => {
        imageC.dispatchEvent(new window.Event("load"));
        await settleReact();
      });
      assert.equal(
        container.querySelector("img.is-ready")?.getAttribute("src"),
        sourceC
      );
      assert.equal(container.querySelectorAll("img").length, 1);

      await React.act(async () => root.unmount());
      container.remove();
    }
  } finally {
    imagePrototype.setAttribute = originalSetAttribute;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/后台访问] ready cache 检查面板区分当前数量与完整重建进度时间", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { ReadyImageCachePanel } = await import(
    "../../../packages/web/src/pages/admin/check/ReadyImageCachePanel.tsx"
  );
  const { readyImageProjectionUsage } = await import(
    "../../../packages/web/src/pages/admin/check/check-redis-inspection.ts"
  );
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { ReadyImageCacheMaintenancePanel } = await import(
    "../../../packages/web/src/pages/admin/check/CheckMaintenanceCapability.tsx"
  ).finally(() => cssHooks.deregister());
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
  const readOnlyHtml = renderToStaticMarkup(React.createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    React.createElement(ReadyImageCachePanel, {
      query: query as never
    })
  ));
  assert.doesNotMatch(readOnlyHtml, /重建图片投影/);

  const html = renderToStaticMarkup(React.createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    React.createElement(ReadyImageCacheMaintenancePanel, {
      query: query as never
    })
  ));

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

  const detectingHtml = renderToStaticMarkup(React.createElement(
    QueryClientProvider,
    { client: new QueryClient() },
    React.createElement(ReadyImageCachePanel, {
      query: query as never,
      projectionUsageNotice: "正在后台自动检测当前 Redis 占用。"
    })
  ));
  assert.match(detectingHtml, /正在后台自动检测当前 Redis 占用/);
  assert.match(detectingHtml, /aria-busy="true"/);

  const deepHtml = renderToStaticMarkup(React.createElement(
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
  ));
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
  assert.deepEqual(
    readyImageProjectionUsage(deepResult, "redis"),
    {
      measured_at: "2026-08-11T00:00:05.000Z",
      core: { key_count: 8, memory_bytes: 8_192 },
      derived: { key_count: 3, member_count: 41, memory_bytes: 2_048 }
    }
  );
  assert.deepEqual(
    readyImageProjectionUsage({
      redis: { status: "ok", data: deepResult }
    }, "all"),
    readyImageProjectionUsage(deepResult, "redis")
  );
  assert.equal(
    readyImageProjectionUsage({
      ...deepResult,
      deep_inspection: {
        ...deepResult.deep_inspection,
        complete: false
      }
    }, "redis"),
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
  const rebuildingHtml = renderToStaticMarkup(React.createElement(
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
  ));
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
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { useAdminRedisInspection } = await import(
    "../../../packages/web/src/pages/admin/check/check-redis-inspection.ts"
  );
  const { document, window } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
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
      : Promise.resolve(new Response(responseBody, {
          status: 200,
          headers: { "content-type": "application/json" }
        }));
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
  const renderProbe = () => React.createElement(
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
      resolveFirstFetch(new Response(responseBody, {
        status: 200,
        headers: { "content-type": "application/json" }
      }));
    });
    await settleUntil(() => container.textContent === "complete");
    assert.equal(container.textContent, "complete");
    assert.equal(fetchCount, 1);
    await React.act(async () => firstRoot.unmount());

    const secondRoot = createRoot(container);
    await React.act(async () => {
      secondRoot.render(renderProbe());
    });
    await settleUntil(() => (
      container.textContent === "complete" && fetchCount === 2
    ));
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
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { document, window } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
  );
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL("https://imageshow.test/admin/check")
  });
  Object.assign(window, {
    requestAnimationFrame: (callback: FrameRequestCallback) => (
      setTimeout(() => callback(Date.now()), 0) as unknown as number
    ),
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
    active_staging_files: [],
    retained_staging_files: [],
    orphan_staging_files: [],
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
        kind: "missing_job_reference",
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
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { CheckStorageMaintenanceActions } = await import(
    "../../../packages/web/src/pages/admin/check/CheckMaintenanceCapability.tsx"
  ).finally(() => cssHooks.deregister());
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
      target.dispatchEvent(new window.Event("click", {
        bubbles: true,
        cancelable: true
      }));
      await settle();
    });
  };

  try {
    await React.act(async () => {
      root.render(React.createElement(
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
      ));
      await settle();
    });

    const topLevelButtons = [...container.querySelectorAll<HTMLButtonElement>(
      "button"
    )];
    const maintenanceButton = topLevelButtons.find((button) => (
      button.textContent?.includes("存储维护")
    ));
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
    assert.match(document.body.textContent ?? "", /将修复异常引用2/);
    assert.match(document.body.textContent ?? "", /停滞任务只报告/);

    const cancelButton = [...document.querySelectorAll<HTMLButtonElement>(
      '[role="dialog"] button'
    )].find((button) => button.textContent?.trim() === "取消");
    assert.ok(cancelButton);
    await click(cancelButton);
    await React.act(async () => {
      maintenanceDialog.dispatchEvent(new window.Event("animationend", {
        bubbles: true
      }));
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
      delete (window.HTMLElement.prototype as unknown as Record<
        string,
        unknown
      >).getClientRects;
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
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { MemoryRouter } = await import("react-router");
  const { AuthSessionProvider } = await import(
    "../../../packages/web/src/hooks/useAuthSession.tsx"
  );
  const { registerHooks } = await import("node:module");
  const cssHooks = registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith(".css")) {
        return { format: "module", source: "", shortCircuit: true };
      }
      return nextLoad(url, context);
    }
  });
  const { CheckPage } = await import(
    "../../../packages/web/src/pages/admin/check/CheckPage.tsx"
  ).finally(() => cssHooks.deregister());
  const { document, window } = parseHTML(
    "<!doctype html><html><body><div id=\"root\"></div></body></html>"
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
    candidates: [{
      id: "00000000-0000-7000-8000-000000000001",
      object_key: "01/00000000-0000-7000-8000-000000000001.webp",
      deleted_at: "2026-08-11T00:00:03.000Z",
      purge_pending: false
    }]
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
  const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), {
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
    const match = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent?.includes(label)
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
      root.render(React.createElement(
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
      ));
      await settle();
    });

    assert.equal(button("全部").disabled, true);
    assert.equal(allRequests, 0);
    assert.equal(redisRequests, 0);
    assert.equal(
      [...container.querySelectorAll("button")].some(
        (candidate) => candidate.textContent?.includes("彻底删除维护")
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
    assert.ok([...container.querySelectorAll("[title]")].some((element) => (
      element.getAttribute("title")?.includes("本次检测未完成")
      && element.getAttribute("title")?.includes("最近一次完整 Redis 深检快照")
    )));

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
