import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  applyPointerMagnet,
  resetPointerMagnet
} from "../../../packages/web/src/lib/ui/pointer-magnet.ts";
import {
  webUuidV7
} from "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-identity.ts";
import {
  settleConfirmedImageAdminMutation
} from "../../../packages/web/src/pages/admin/images/useImageAdminOperations.ts";
import {
  createDialogTouchBoundary
} from "../../../packages/web/src/lib/ui/dialog-touch-boundary.ts";
import {
  canDialogHorizontalScrollOwnerConsumeTouchMove,
  canDialogScrollOwnerConsumeTouchMove,
  consumeDialogHorizontalTouchMove,
  findDialogHorizontalTouchScrollOwner,
  findDialogTouchScrollOwner
} from "../../../packages/web/src/lib/ui/dialog-scroll-boundary.ts";
import {
  installPropertyDescriptors,
  installProperties
} from "../support/property-descriptors.ts";

test("[Web/共享交互] 媒体查询保持当前快照、独立订阅及卸载清理", async (t) => {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { renderToString } = await import("react-dom/server");
  const { useMediaQuery, mobileViewportMediaQuery } = await import(
    "../../../packages/web/src/hooks/useMediaQuery.ts"
  );
  const { window, document } = parseHTML("<html><body><div id=root></div></body></html>");
  const restore = installProperties(globalThis, { window, document });
  const queries = new Map<string, { matches: boolean; listeners: Set<() => void>; added: number }>();
  const state = (query: string) => {
    if (!queries.has(query)) queries.set(query, { matches: false, listeners: new Set(), added: 0 });
    return queries.get(query)!;
  };
  const motionQuery = "(prefers-reduced-motion: reduce)";
  state(mobileViewportMediaQuery).matches = true;
  const restoreMedia = installProperties(window, {
    matchMedia: (query: string) => ({
      get matches() { return state(query).matches; },
      addEventListener(type: string, listener: () => void) {
        assert.equal(type, "change");
        state(query).added++;
        state(query).listeners.add(listener);
      },
      removeEventListener(type: string, listener: () => void) {
        assert.equal(type, "change");
        assert.equal(state(query).listeners.delete(listener), true);
      }
    })
  });
  const root = createRoot(document.getElementById("root")!);
  let unmounted = false;
  t.after(async () => {
    if (!unmounted) await React.act(async () => root.unmount());
    restoreMedia();
    restore();
  });
  const commits: { query: string; matches: boolean }[] = [];
  function Probe({ query }: { query: string }) {
    const matches = useMediaQuery(query);
    React.useLayoutEffect(() => { commits.push({ query, matches }); });
    return React.createElement("output", null, String(matches));
  }
  const pendingRender = Promise.withResolvers<void>();
  let suspended = 0;
  function Block({ active }: { active: boolean }) {
    if (active) { suspended++; throw pendingRender.promise; }
    return null;
  }
  const render = (query: string, second = false, blocked = false) => root.render(
    React.createElement(React.StrictMode, null,
      React.createElement(React.Suspense, { fallback: "pending" },
        React.createElement(Probe, { query }),
        second ? React.createElement(Probe, { query: motionQuery }) : null,
        React.createElement(Block, { active: blocked })))
  );
  await React.act(async () => render(mobileViewportMediaQuery));
  assert.ok(commits.every((commit) => commit.matches), "首帧即使用当前移动视口");
  assert.equal(state(mobileViewportMediaQuery).listeners.size, 1);
  const added = state(mobileViewportMediaQuery).added;
  await React.act(async () => render(mobileViewportMediaQuery));
  assert.equal(state(mobileViewportMediaQuery).added, added, "无关重渲染不重新订阅");
  await React.act(async () => {
    state(mobileViewportMediaQuery).matches = false;
    for (const listener of state(mobileViewportMediaQuery).listeners) listener();
  });
  assert.equal(document.querySelector("output")!.textContent, "false");
  await React.act(async () => {
    state(mobileViewportMediaQuery).matches = true;
    for (const listener of state(mobileViewportMediaQuery).listeners) listener();
  });
  assert.equal(document.querySelector("output")!.textContent, "true");
  await React.act(async () => React.startTransition(() => render(motionQuery, false, true)));
  assert.ok(suspended > 0);
  assert.equal(state(motionQuery).listeners.size, 0, "未提交的查询不开始订阅");
  assert.equal(state(mobileViewportMediaQuery).listeners.size, 1);
  await React.act(async () => {
    state(mobileViewportMediaQuery).matches = false;
    for (const listener of state(mobileViewportMediaQuery).listeners) listener();
  });
  assert.equal(document.querySelector("output")!.textContent, "false", "等待中的渲染不阻断已提交查询更新");
  await React.act(async () => render(mobileViewportMediaQuery));
  await React.act(async () => {
    state(mobileViewportMediaQuery).matches = true;
    for (const listener of state(mobileViewportMediaQuery).listeners) listener();
  });
  commits.length = 0;
  await React.act(async () => render(motionQuery, true));
  assert.ok(commits.every((commit) => !commit.matches), "切换 query 的提交不混入前一 query 快照");
  assert.equal(state(mobileViewportMediaQuery).listeners.size, 0);
  assert.equal(state(motionQuery).listeners.size, 2);
  await React.act(async () => {
    state(motionQuery).matches = true;
    for (const listener of state(motionQuery).listeners) listener();
  });
  assert.deepEqual([...document.querySelectorAll("output")].map((el) => el.textContent), ["true", "true"]);
  await React.act(async () => render(motionQuery));
  assert.equal(state(motionQuery).listeners.size, 1, "一个消费者卸载不撤销另一个订阅");
  await React.act(async () => root.unmount());
  unmounted = true;
  assert.ok([...queries.values()].every((query) => query.listeners.size === 0));
  const restoreNoWindow = installProperties(globalThis, { window: undefined });
  try {
    assert.equal(renderToString(React.createElement(Probe, { query: motionQuery })), "<output>false</output>");
  } finally {
    restoreNoWindow();
  }
});

test("[Web/共享交互] Web UUID 只使用安全随机源并设置 UUIDv7 时间、版本与 variant", () => {
  const timestamp = Date.UTC(2026, 7, 23, 1, 2, 3, 456);
  const uuid = webUuidV7(timestamp);
  assert.match(
    uuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  const compact = uuid.replaceAll("-", "");
  assert.equal(Number.parseInt(compact.slice(0, 12), 16), timestamp);
  assert.notEqual(webUuidV7(timestamp), uuid);
  assert.throws(() => webUuidV7(-1));
});
test("[Web/共享交互] 公开图片磁吸按指针全域连续映射并可同步复位", () => {
  const properties = new Map<string, string>();
  const element = {
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value)
    },
    getBoundingClientRect: () => ({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }),
    offsetParent: null
  } as unknown as HTMLElement;
  assert.equal(applyPointerMagnet(
    element,
    element,
    { clientX: 100, clientY: 50, pointerType: "mouse" },
    { maximumAngleDegrees: 10, maximumShadowOffsetPixels: 9 }
  ), true);
  assert.equal(properties.get("--public-card-magnet-axis-x"), "0");
  assert.equal(properties.get("--public-card-magnet-axis-y"), "-1");
  assert.equal(properties.get("--public-card-magnet-angle"), "10deg");
  assert.equal(properties.get("--public-card-magnet-shadow-x"), "9px");
  assert.equal(properties.get("--public-card-magnet-shadow-y"), "0px");
  assert.equal(properties.get("--public-card-magnet-light-x"), "100%");
  assert.equal(properties.get("--public-card-magnet-light-strength"), "1");
  applyPointerMagnet(element, element,
    { clientX: 75, clientY: 50, pointerType: "mouse" },
    { maximumAngleDegrees: 10, maximumShadowOffsetPixels: 9 });
  assert.equal(properties.get("--public-card-magnet-light-strength"), "0.25");
  assert.equal(applyPointerMagnet(
    element,
    element,
    { clientX: 100, clientY: 50, pointerType: "touch" },
    { maximumAngleDegrees: 10, maximumShadowOffsetPixels: 9 }
  ), false);
  resetPointerMagnet(element);
  assert.equal(properties.get("--public-card-magnet-angle"), "0deg");
  assert.equal(properties.get("--public-card-magnet-shadow-x"), "0px");
  assert.equal(properties.get("--public-card-magnet-light-strength"), "0");
});
test("[Web/共享交互] 直接激活在键盘视口中延后目标聚焦并区分保留与释放", async () => {

  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  class TestResizeObserver {
    constructor(_callback: ResizeObserverCallback) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  const matchMedia = (query: string) => ({
    matches: query.includes("max-width: 760px"),
    media: query,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true
  });
  let animationFrame = 0;
  const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = ++animationFrame;
    frameTimers.set(id, setTimeout(() => {
      frameTimers.delete(id);
      callback(0);
    }, 0));
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    const timer = frameTimers.get(id);
    if (timer) clearTimeout(timer);
    frameTimers.delete(id);
  };
  Object.assign(window, {
    matchMedia,
    requestAnimationFrame,
    cancelAnimationFrame,
    ResizeObserver: TestResizeObserver
  });
  const eventWindow = window as unknown as Window;
  const captureListeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();
  const nativeAddEventListener = eventWindow.addEventListener.bind(eventWindow);
  const nativeRemoveEventListener = eventWindow.removeEventListener.bind(eventWindow);
  eventWindow.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) => {
    const capture = options === true || (
      typeof options === "object" && options.capture === true
    );
    if (listener && capture) {
      const listeners = captureListeners.get(type) ?? new Set();
      listeners.add(listener);
      captureListeners.set(type, listeners);
    }
    if (listener) nativeAddEventListener(type, listener, options);
  }) as typeof eventWindow.addEventListener;
  eventWindow.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) => {
    const capture = options === true || (
      typeof options === "object" && options.capture === true
    );
    if (listener && capture) {
      captureListeners.get(type)?.delete(listener);
    }
    if (listener) nativeRemoveEventListener(type, listener, options);
  }) as typeof eventWindow.removeEventListener;
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
    ResizeObserver: TestResizeObserver,
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

  const dispatch = (target: Element, type: string, properties: object) => {
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
  const runWindowCapture = (
    target: EventTarget,
    type: string,
    properties: Record<string, unknown>
  ) => {
    let defaultPrevented = false;
    let immediatePropagationStopped = false;
    const event = {
      type,
      target,
      currentTarget: eventWindow,
      cancelable: true,
      ...properties,
      preventDefault() {
        defaultPrevented = true;
      },
      stopPropagation() {},
      stopImmediatePropagation() {
        immediatePropagationStopped = true;
      }
    } as unknown as Event;
    for (const listener of [...(captureListeners.get(type) ?? [])]) {
      if (typeof listener === "function") {
        listener.call(eventWindow, event);
      } else {
        listener.handleEvent(event);
      }
      if (immediatePropagationStopped) break;
    }
    return { defaultPrevented, immediatePropagationStopped };
  };
  const dispatchThroughWindowCapture = (
    target: Element,
    type: string,
    properties: Record<string, unknown>
  ) => {
    const capture = runWindowCapture(target, type, properties);
    if (capture.immediatePropagationStopped) {
      return { ...capture, targetDispatched: false };
    }
    const targetEvent = dispatch(target, type, properties);
    return {
      defaultPrevented: capture.defaultPrevented || targetEvent.defaultPrevented,
      immediatePropagationStopped: false,
      targetDispatched: true
    };
  };

  try {
    const { createRoot } = await import("react-dom/client");
    const { WorkflowCollapsePanel } = await import(
      "../../../packages/web/src/components/layout/WorkflowCollapsePanel.tsx"
    );
    const { DirectActivationButton } = await import(
      "../../../packages/web/src/components/feedback/DirectActivationButton.tsx"
    );
    const { TagInput } = await import(
      "../../../packages/web/src/components/form/TagInput.tsx"
    );

    function Harness() {
      const [expanded, setExpanded] = React.useState(false);
      const [drafts, setDrafts] = React.useState(
        () => Array.from({ length: 200 }, () => false)
      );
      const [applyCount, setApplyCount] = React.useState(0);
      const [targetCount, setTargetCount] = React.useState(0);
      const [tags, setTags] = React.useState<string[]>([]);
      const [targetTags, setTargetTags] = React.useState<string[]>([]);
      const [appliedTags, setAppliedTags] = React.useState<string[]>([]);
      return React.createElement(
        "div",
        null,
        React.createElement(
          WorkflowCollapsePanel,
          {
            className: "extreme-panel",
            contentClassName: "extreme-content",
            title: "批量默认属性",
            summary: `${drafts.filter(Boolean).length} 项已应用`,
            expanded,
            onExpandedChange: setExpanded,
            children: null
          },
          React.createElement(TagInput, {
            className: "active-tag-editor",
            value: tags,
            onChange: setTags,
            suggestions: [],
            ariaLabel: "默认标签"
          }),
          React.createElement(DirectActivationButton, {
            type: "button",
            className: "target-focus-button",
            onActivate: () => {
              setTargetCount((current) => current + 1);
              setTargetTags(tags);
            }
          }, "亮暗不变"),
          React.createElement(DirectActivationButton, {
            type: "button",
            className: "apply-to-all-button",
            onActivate: () => {
              setDrafts((current) => current.map(() => true));
              setApplyCount((current) => current + 1);
              setAppliedTags(tags);
            }
          }, "应用到全部"),
          React.createElement(
            "output",
            { className: "activation-output" },
            `${targetCount}:${applyCount}:${drafts.filter(Boolean).length}`
          ),
          React.createElement(
            "output",
            { className: "settled-output" },
            targetTags.join(",")
          ),
          React.createElement(
            "output",
            { className: "applied-tags-output" },
            appliedTags.join(",")
          )
        ),
        React.createElement("button", {
          type: "button",
          className: "dialog-close-button"
        }, "关闭")
      );
    }

    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);
    await React.act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    const toggle = document.querySelector<HTMLButtonElement>(
      ".workflow-collapse-toggle"
    );
    const apply = document.querySelector<HTMLButtonElement>(
      ".apply-to-all-button"
    );
    const targetFocusButton = document.querySelector<HTMLButtonElement>(
      ".target-focus-button"
    );
    const editor = document.querySelector<HTMLInputElement>(
      ".active-tag-editor input"
    );
    const dialogClose = document.querySelector<HTMLButtonElement>(
      ".dialog-close-button"
    );
    assert.ok(toggle && apply && targetFocusButton && editor && dialogClose);
    let toggleBlurCount = 0;
    let toggleFocusCount = 0;
    let editorBlurCount = 0;
    let dialogCloseFocusCount = 0;
    let applyFocusCount = 0;
    let targetFocusCount = 0;
    let keyboardOpen = false;
    let activeElement: HTMLElement = document.body;
    Object.defineProperty(document, "activeElement", {
      configurable: true,
      get: () => activeElement
    });
    const nativeToggleBlur = toggle.blur.bind(toggle);
    const nativeToggleFocus = toggle.focus.bind(toggle);
    const nativeEditorBlur = editor.blur.bind(editor);
    const nativeEditorFocus = editor.focus.bind(editor);
    const nativeDialogCloseFocus = dialogClose.focus.bind(dialogClose);
    const nativeApplyFocus = apply.focus.bind(apply);
    const nativeTargetFocus = targetFocusButton.focus.bind(targetFocusButton);
    const settleEditorFocus = (nextTarget: HTMLElement) => {
      if (activeElement !== editor) return;
      dispatch(editor, "focusout", { relatedTarget: nextTarget });
    };
    Object.defineProperty(toggle, "blur", {
      configurable: true,
      value: () => {
        toggleBlurCount += 1;
        if (activeElement === toggle) activeElement = document.body;
        nativeToggleBlur();
      }
    });
    Object.defineProperty(toggle, "focus", {
      configurable: true,
      value: () => {
        toggleFocusCount += 1;
        keyboardOpen = false;
        settleEditorFocus(toggle);
        activeElement = toggle;
        nativeToggleFocus();
      }
    });
    Object.defineProperty(editor, "focus", {
      configurable: true,
      value: () => {
        activeElement = editor;
        nativeEditorFocus();
      }
    });
    Object.defineProperty(editor, "blur", {
      configurable: true,
      value: () => {
        editorBlurCount += 1;
        keyboardOpen = false;
        if (activeElement === editor) activeElement = document.body;
        nativeEditorBlur();
      }
    });
    Object.defineProperty(dialogClose, "focus", {
      configurable: true,
      value: () => {
        dialogCloseFocusCount += 1;
        settleEditorFocus(dialogClose);
        activeElement = dialogClose;
        nativeDialogCloseFocus();
      }
    });
    Object.defineProperty(apply, "focus", {
      configurable: true,
      value: () => {
        applyFocusCount += 1;
        keyboardOpen = false;
        settleEditorFocus(apply);
        activeElement = apply;
        nativeApplyFocus();
      }
    });
    Object.defineProperty(targetFocusButton, "focus", {
      configurable: true,
      value: () => {
        targetFocusCount += 1;
        keyboardOpen = false;
        settleEditorFocus(targetFocusButton);
        activeElement = targetFocusButton;
        nativeTargetFocus();
      }
    });
    Object.defineProperty(toggle, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const top = keyboardOpen ? 0 : 100;
        return {
          left: 0,
          top,
          right: 320,
          bottom: top + 48,
          width: 320,
          height: 48,
          x: 0,
          y: top,
          toJSON() { return this; }
        };
      }
    });
    Object.defineProperty(targetFocusButton, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const top = keyboardOpen ? 48 : 148;
        return {
          left: 0,
          top,
          right: 320,
          bottom: top + 48,
          width: 320,
          height: 48,
          x: 0,
          y: top,
          toJSON() { return this; }
        };
      }
    });
    Object.defineProperty(apply, "getBoundingClientRect", {
      configurable: true,
      value: () => {
        const top = keyboardOpen ? 96 : 196;
        return {
          left: 0,
          top,
          right: 320,
          bottom: top + 48,
          width: 320,
          height: 48,
          x: 0,
          y: top,
          toJSON() { return this; }
        };
      }
    });
    const touchProperties = {
      pointerType: "touch",
      pointerId: 7,
      isPrimary: true,
      button: 0,
      clientX: 24,
      clientY: 24
    };

    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "click", { detail: 1 });
      await Promise.resolve();
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    editor.focus();
    keyboardOpen = true;
    await React.act(async () => {
      editor.value = "after-blur";
      dispatch(editor, "input", {});
      await Promise.resolve();
    });
    assert.equal(
      document.activeElement === editor,
      true,
      `测试编辑器必须先取得焦点，实际为 ${document.activeElement?.className}`
    );
    const targetTouchProperties = {
      ...touchProperties,
      pointerId: 70,
      clientY: 72
    };
    await React.act(async () => {
      dispatchThroughWindowCapture(
        targetFocusButton,
        "pointerdown",
        targetTouchProperties
      );
      await Promise.resolve();
    });
    assert.equal(targetFocusCount, 0, "目标聚焦策略不得在触控按下时收起键盘");
    assert.equal(keyboardOpen, true);
    assert.equal(
      document.activeElement === editor,
      true,
      `pointerdown 后焦点不得改变，实际为 ${document.activeElement?.className}`
    );
    await React.act(async () => {
      dispatchThroughWindowCapture(
        targetFocusButton,
        "pointerup",
        targetTouchProperties
      );
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:0:0",
      "目标聚焦策略必须先按原位置提交手势再激活动作"
    );
    assert.equal(targetFocusCount, 1);
    assert.equal(keyboardOpen, false);
    assert.equal(document.activeElement === targetFocusButton, true);
    assert.equal(
      document.querySelector(".settled-output")?.textContent,
      "after-blur",
      "目标激活必须读取同次焦点转移已结算的最新草稿"
    );

    editor.focus();
    keyboardOpen = true;
    await React.act(async () => {
      editor.value = "apply-blur";
      dispatch(editor, "input", {});
      await Promise.resolve();
    });

    const applyTouchProperties = {
      ...touchProperties,
      pointerId: 8,
      clientY: 120
    };
    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", applyTouchProperties);
      dispatchThroughWindowCapture(apply, "pointermove", {
        ...applyTouchProperties,
        clientX: 48
      });
      dispatchThroughWindowCapture(apply, "pointerup", {
        ...applyTouchProperties,
        clientX: 48
      });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:0:0",
      "超过 5px 的移动必须取消应用"
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    const movedRetarget = dispatchThroughWindowCapture(
      toggle,
      "click",
      { detail: 1 }
    );
    assert.deepEqual(movedRetarget, {
      defaultPrevented: true,
      immediatePropagationStopped: true,
      targetDispatched: false
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", {
        ...applyTouchProperties,
        pointerId: 9
      });
      dispatchThroughWindowCapture(apply, "pointercancel", {
        ...applyTouchProperties,
        pointerId: 9
      });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:0:0",
      "取消手势不得应用"
    );
    const cancelledRetarget = dispatchThroughWindowCapture(
      toggle,
      "click",
      { detail: 1 }
    );
    assert.equal(cancelledRetarget.immediatePropagationStopped, true);
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", {
        ...applyTouchProperties,
        pointerId: 10
      });
      await Promise.resolve();
    });
    assert.equal(applyFocusCount, 0, "应用按钮不得在 pointerdown 转移焦点");
    assert.equal(keyboardOpen, true, "应用按钮按下时必须保持键盘视口");
    assert.equal(document.activeElement === editor, true);
    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerup", {
        ...applyTouchProperties,
        pointerId: 10
      });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:1:200"
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    assert.equal(applyFocusCount, 1, "应用按钮必须在 pointerup 提交后取得焦点");
    assert.equal(keyboardOpen, false);
    assert.equal(document.activeElement === apply, true);
    assert.equal(
      document.querySelector(".applied-tags-output")?.textContent,
      "after-blur,apply-blur",
      "应用动作必须一次读取 TagInput 失焦结算后的最后标签"
    );

    for (const type of ["mousedown", "mouseup", "click"]) {
      const compatibilityEvent = dispatchThroughWindowCapture(
        toggle,
        type,
        { detail: 1 }
      );
      assert.equal(
        compatibilityEvent.defaultPrevented,
        true,
        `迟到的 ${type} 必须被兼容守卫取消`
      );
      assert.equal(compatibilityEvent.immediatePropagationStopped, true);
      assert.equal(compatibilityEvent.targetDispatched, false);
    }
    assert.equal(
      toggle.getAttribute("aria-expanded"),
      "true",
      "应用后的迟到 click 即使重命中折叠按钮也不得收起面板"
    );

    editor.focus();
    keyboardOpen = true;
    const localHTMLElement = globalThis.HTMLElement;
    Object.defineProperty(globalThis, "HTMLElement", {
      configurable: true,
      writable: true,
      value: class ForeignRealmHTMLElement {}
    });
    try {
      await React.act(async () => {
        dispatchThroughWindowCapture(toggle, "pointerdown", {
          ...touchProperties,
          pointerId: 11
        });
        await Promise.resolve();
      });
      assert.equal(toggleFocusCount, 0, "折叠触控不得在按下阶段转移焦点");
      assert.equal(keyboardOpen, true, "折叠触控按下时必须保持键盘视口");
      assert.equal(document.activeElement === editor, true);
      await React.act(async () => {
        dispatchThroughWindowCapture(toggle, "pointerup", {
          ...touchProperties,
          pointerId: 11
        });
        await Promise.resolve();
      });
    } finally {
      Object.defineProperty(globalThis, "HTMLElement", {
        configurable: true,
        writable: true,
        value: localHTMLElement
      });
    }
    assert.equal(
      toggle.getAttribute("aria-expanded"),
      "false",
      "下一次物理按下必须释放旧守卫并在本次 pointerup 折叠"
    );
    assert.equal(editorBlurCount, 1, "指针折叠提交后必须释放原编辑焦点");
    assert.equal(keyboardOpen, false);
    assert.equal(document.activeElement === editor, false);
    assert.equal(document.activeElement === toggle, false);

    for (const type of ["mousedown", "mouseup", "click"]) {
      const restoredPositionEvent = dispatchThroughWindowCapture(
        dialogClose,
        type,
        { detail: 1 }
      );
      assert.equal(restoredPositionEvent.defaultPrevented, true);
      assert.equal(restoredPositionEvent.immediatePropagationStopped, true);
      assert.equal(restoredPositionEvent.targetDispatched, false);
    }
    assert.equal(
      dialogCloseFocusCount,
      0,
      "视口复位后的迟到兼容序列不得聚焦关闭按钮"
    );

    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "pointerdown", {
        ...touchProperties,
        pointerId: 12,
        clientY: 124
      });
      await Promise.resolve();
    });
    assert.equal(toggleFocusCount, 0, "目标按钮仍不得在 pointerdown 聚焦");
    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "pointerup", {
        ...touchProperties,
        pointerId: 12,
        clientY: 124
      });
      await Promise.resolve();
    });
    assert.equal(
      toggle.getAttribute("aria-expanded"),
      "true",
      "新的物理手势必须释放上一手势的旧守卫并正常展开"
    );
    assert.equal(toggleFocusCount, 1, "目标焦点必须在 pointerup 提交后转移");
    assert.equal(document.activeElement === toggle, true);
    assert.equal(toggleBlurCount, 0, "指针展开不能释放焦点");

    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "click", { detail: 0 });
      await Promise.resolve();
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.equal(toggleBlurCount, 0, "键盘折叠必须保留披露按钮焦点");
    assert.equal(document.activeElement === toggle, true);
    await React.act(async () => {
      dispatchThroughWindowCapture(toggle, "click", { detail: 0 });
      await Promise.resolve();
    });
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    const mouseProperties = {
      pointerType: "mouse",
      pointerId: 13,
      isPrimary: true,
      button: 0,
      clientX: 24,
      clientY: 120
    };
    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", mouseProperties);
      dispatchThroughWindowCapture(apply, "pointerup", mouseProperties);
      assert.equal(
        document.querySelector(".activation-output")?.textContent,
        "1:1:200"
      );
      dispatchThroughWindowCapture(apply, "click", { detail: 1 });
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:2:200",
      "鼠标必须只由原生 click 激活一次"
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    await React.act(async () => {
      dispatchThroughWindowCapture(apply, "pointerdown", {
        ...applyTouchProperties,
        pointerId: 14
      });
      dispatchThroughWindowCapture(apply, "pointercancel", {
        ...applyTouchProperties,
        pointerId: 14
      });
      const keyboardClick = dispatchThroughWindowCapture(
        apply,
        "click",
        { detail: 0 }
      );
      assert.equal(keyboardClick.immediatePropagationStopped, false);
      assert.equal(keyboardClick.targetDispatched, true);
      await Promise.resolve();
    });
    assert.equal(
      document.querySelector(".activation-output")?.textContent,
      "1:3:200",
      "键盘 detail=0 激活不得被触控兼容守卫吞掉"
    );
    assert.equal(toggle.getAttribute("aria-expanded"), "true");

    const cleanupClick = runWindowCapture(apply, "click", { detail: 1 });
    assert.equal(cleanupClick.immediatePropagationStopped, true);

    await React.act(async () => root.unmount());
  } finally {
    for (const timer of frameTimers.values()) clearTimeout(timer);
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
test("[Web/共享交互] 图片成员已知结果必须先呈现再刷新移出当前标签页", async () => {
  const calls: string[] = [];
  const present = (text: string, status: "error" | "success") => {
    calls.push(`present:${status}:${text}`);
  };

  const refreshFailed = await settleConfirmedImageAdminMutation({
    startedAt: Date.now() - 1_000,
    text: "已恢复 199 张，1 张未处理",
    status: "error",
    feedbackTiming: "before-list-refresh",
    refresh: async () => {
      calls.push("refresh");
    },
    present
  });
  assert.equal(refreshFailed, false);
  assert.deepEqual(calls, [
    "present:error:已恢复 199 张，1 张未处理",
    "refresh"
  ]);

  calls.length = 0;
  const failed = await settleConfirmedImageAdminMutation({
    startedAt: Date.now() - 1_000,
    text: "已永久删除 200 张",
    status: "success",
    feedbackTiming: "after-list-refresh",
    refresh: async () => {
      calls.push("refresh");
      throw new Error("refresh failed");
    },
    present
  });
  assert.equal(failed, true);
  assert.deepEqual(calls, [
    "refresh",
    "present:error:已永久删除 200 张；图片列表刷新失败，请重新加载页面"
  ]);
});
test("[Web/共享交互] 弹窗触摸边界按意图区分纵向与标签横向 owner", () => {
  const metrics = (
    scrollTop: number,
    clientHeight = 100,
    scrollHeight = 300
  ) => ({ scrollTop, clientHeight, scrollHeight });
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(0), -20),
    true,
    "顶部向上拖动应继续向内容底部滚动"
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(0), 20),
    false,
    "顶部向下拖动不得交给背景页"
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(100), -20),
    true
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(100), 20),
    true
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(200), -20),
    false,
    "底部向上拖动不得交给背景页"
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(metrics(200), 20),
    true
  );
  assert.equal(
    canDialogScrollOwnerConsumeTouchMove(
      metrics(0, 100, 100),
      -20
    ),
    false
  );
  const horizontalMetrics = (
    scrollLeft: number,
    clientWidth = 100,
    scrollWidth = 300
  ) => ({ scrollLeft, clientWidth, scrollWidth });
  assert.equal(
    canDialogHorizontalScrollOwnerConsumeTouchMove(
      horizontalMetrics(0),
      -20
    ),
    true
  );
  assert.equal(
    canDialogHorizontalScrollOwnerConsumeTouchMove(
      horizontalMetrics(0),
      20
    ),
    false
  );
  const horizontalOwner = {
    ...horizontalMetrics(50),
    scrollTo(options: ScrollToOptions | number = {}, _y?: number) {
      assert.equal(typeof options, "object");
      if (typeof options === "number") return;
      assert.equal(options.behavior, "instant", "触摸位移不应再次经过平滑插值");
      this.scrollLeft = options.left ?? this.scrollLeft;
    }
  };
  assert.equal(consumeDialogHorizontalTouchMove(horizontalOwner, -20), true);
  assert.equal(horizontalOwner.scrollLeft, 70);

  const { window, document } = parseHTML(
    "<!doctype html><html><body>"
      + "<div data-dialog-frame id=frame>"
      + "<div data-overflow=auto id=article>"
      + "<div data-overflow=auto id=inner><span id=target>目标</span></div>"
      + "<div data-overflow-x=auto data-dialog-horizontal-scroll-owner id=tags>"
      + "<span id=tag-target>标签</span><input id=input>"
      + "</div>"
      + "</div></div><span id=outside>外部</span>"
      + "</body></html>"
  );
  Object.assign(window, {
    getComputedStyle(element: Element) {
      return {
        overflow: "visible",
        overflowX: element.getAttribute("data-overflow-x") ?? "visible",
        overflowY: element.getAttribute("data-overflow") ?? "visible"
      };
    }
  });
  const installedGlobals = {
    window,
    self: window,
    document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement
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

  const frame = document.getElementById("frame") as HTMLElement;
  const article = document.getElementById("article") as HTMLElement;
  const inner = document.getElementById("inner") as HTMLElement;
  const target = document.getElementById("target") as HTMLElement;
  const tags = document.getElementById("tags") as HTMLElement;
  const tagTarget = document.getElementById("tag-target") as HTMLElement;
  const input = document.getElementById("input") as HTMLElement;
  const outside = document.getElementById("outside") as HTMLElement;
  const setMetrics = (
    element: HTMLElement,
    values: { clientHeight: number; scrollHeight: number; scrollTop: number }
  ) => {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(element, key, {
        configurable: true,
        writable: true,
        value
      });
    }
  };
  setMetrics(frame, metrics(0, 300, 300));
  setMetrics(article, metrics(25, 100, 500));
  setMetrics(inner, metrics(0, 100, 100));
  const setHorizontalMetrics = (
    element: HTMLElement,
    values: { clientWidth: number; scrollLeft: number; scrollWidth: number }
  ) => {
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(element, key, {
        configurable: true,
        writable: true,
        value
      });
    }
  };
  setHorizontalMetrics(tags, horizontalMetrics(0));
  tags.scrollTo = ((options: ScrollToOptions) => {
    assert.equal(options.behavior, "instant");
    tags.scrollLeft = options.left ?? tags.scrollLeft;
  }) as HTMLElement["scrollTo"];

  try {
    assert.equal(findDialogTouchScrollOwner(target, frame), article);
    setMetrics(inner, metrics(0, 100, 300));
    assert.equal(findDialogTouchScrollOwner(target, frame), inner);
    assert.equal(findDialogTouchScrollOwner(outside, frame), null);
    assert.equal(findDialogHorizontalTouchScrollOwner(tagTarget, frame), tags);
    assert.equal(findDialogHorizontalTouchScrollOwner(input, frame), tags);
    assert.equal(findDialogHorizontalTouchScrollOwner(target, frame), null);

    setHorizontalMetrics(tags, horizontalMetrics(0, 100, 100));
    assert.equal(
      findDialogHorizontalTouchScrollOwner(input, frame),
      null,
      "没有横向溢出时输入框应保留原生光标与选择手势"
    );
    setHorizontalMetrics(tags, horizontalMetrics(0));

    const touchList = (...points: Array<{
      identifier: number;
      clientX: number;
      clientY: number;
    }>) => ({
      length: points.length,
      item: (index: number) => points[index] ?? null
    }) as unknown as TouchList;
    let prevented = 0;
    const touchEvent = (
      eventTarget: EventTarget,
      points: Array<{ identifier: number; clientX: number; clientY: number }>
    ) => ({
      cancelable: true,
      target: eventTarget,
      touches: touchList(...points),
      preventDefault() {
        prevented += 1;
      }
    }) as unknown as TouchEvent;
    const boundary = createDialogTouchBoundary(document);
    const point = (identifier: number, clientX: number, clientY: number) => ({
      identifier,
      clientX,
      clientY
    });

    boundary.onTouchStart(touchEvent(target, [point(7, 100, 100)]));
    boundary.onTouchMove(touchEvent(target, [point(7, 100, 120)]));
    assert.equal(prevented, 1, "顶部边界应阻止滚动链回到文档");

    inner.scrollTop = 50;
    boundary.onTouchStart(touchEvent(target, [point(8, 100, 100)]));
    boundary.onTouchMove(touchEvent(target, [point(8, 100, 120)]));
    assert.equal(prevented, 1, "owner 有可用方向时保留浏览器原生滚动");

    inner.scrollTop = 0;
    boundary.onTouchStart(touchEvent(input, [point(9, 100, 100)]));
    boundary.onTouchMove(touchEvent(input, [point(9, 100, 120)]));
    assert.equal(prevented, 1, "输入控件保留原生文本手势");

    boundary.onTouchStart(touchEvent(target, [
      point(10, 100, 100),
      point(11, 120, 100)
    ]));
    boundary.onTouchMove(touchEvent(target, [
      point(10, 100, 120),
      point(11, 120, 120)
    ]));
    assert.equal(prevented, 1, "双指缩放不得被滚动边界接管");

    boundary.onTouchStart(touchEvent(tagTarget, [point(12, 100, 100)]));
    boundary.onTouchMove(touchEvent(tagTarget, [point(12, 76, 102)]));
    assert.equal(tags.scrollLeft, 24, "chip 起手应移动共享标签 viewport");
    assert.equal(prevented, 2);

    boundary.onTouchStart(touchEvent(input, [point(13, 100, 100)]));
    boundary.onTouchMove(touchEvent(input, [point(13, 80, 101)]));
    assert.equal(tags.scrollLeft, 44, "输入区起手也应移动同一 viewport");
    assert.equal(prevented, 3);

    const beforeDiagonal = tags.scrollLeft;
    boundary.onTouchStart(touchEvent(tags, [point(14, 100, 100)]));
    boundary.onTouchMove(touchEvent(tags, [point(14, 98, 78)]));
    assert.equal(tags.scrollLeft, beforeDiagonal);
    assert.equal(prevented, 3, "纵向意图应继续交给弹窗纵向 owner");

    tags.scrollLeft = 200;
    boundary.onTouchStart(touchEvent(tags, [point(15, 100, 100)]));
    boundary.onTouchMove(touchEvent(tags, [point(15, 78, 100)]));
    assert.equal(tags.scrollLeft, 200);
    assert.equal(prevented, 4, "标签末端必须锁住横向滚动链");

    tags.scrollLeft = 0;
    const beforeSubpixel = prevented;
    boundary.onTouchStart(touchEvent(tagTarget, [point(16, 100, 100)]));
    for (let step = 1; step <= 12; step += 1) {
      boundary.onTouchMove(touchEvent(tagTarget, [
        point(16, 100 - step * 0.5, 100)
      ]));
    }
    assert.equal(
      tags.scrollLeft,
      1.5,
      "越过意图阈值后的连续亚像素样本必须逐帧保留"
    );
    assert.equal(prevented - beforeSubpixel, 3);

    setHorizontalMetrics(tags, horizontalMetrics(0, 100, 100));
    boundary.onTouchStart(touchEvent(input, [point(17, 100, 100)]));
    boundary.onTouchMove(touchEvent(input, [point(17, 78, 100)]));
    assert.equal(
      prevented,
      beforeSubpixel + 3,
      "无溢出输入框的横向文本手势不得被显式取消"
    );
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
test("[Web/共享交互] 页面滚动 Effect Event 更新回调时不重绑监听器并清理待执行帧", async (t) => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let scrollY = 0;
  const restoreWindowProperties = installPropertyDescriptors(window, {
    scrollY: { configurable: true, get: () => scrollY }
  });
  t.after(restoreWindowProperties);
  Object.defineProperty(document.documentElement, "scrollHeight", {
    configurable: true,
    value: 2_000
  });
  Object.defineProperty(document.body, "scrollHeight", {
    configurable: true,
    value: 2_000
  });

  const frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame;
    nextFrame += 1;
    frameCallbacks.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    frameCallbacks.delete(id);
  };
  const flushFrames = () => {
    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    for (const callback of callbacks) callback(Date.now());
  };
  const restoreAnimationProperties = installProperties(window, {
    innerHeight: 600,
    requestAnimationFrame,
    cancelAnimationFrame
  });
  t.after(restoreAnimationProperties);

  const activeScrollListeners = new Set<EventListenerOrEventListenerObject>();
  let scrollListenerAdds = 0;
  let scrollListenerRemoves = 0;
  const addWindowEventListener = window.addEventListener.bind(window);
  const removeWindowEventListener = window.removeEventListener.bind(window);
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (type === "scroll" && listener) {
      scrollListenerAdds += 1;
      activeScrollListeners.add(listener);
    }
    if (listener) addWindowEventListener(type, listener, options);
  }) as typeof window.addEventListener;
  window.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) => {
    if (type === "scroll" && listener) {
      scrollListenerRemoves += 1;
      activeScrollListeners.delete(listener);
    }
    if (listener) removeWindowEventListener(type, listener, options);
  }) as typeof window.removeEventListener;

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
    const { usePageScrollMovement } = await import(
      "../../../packages/web/src/hooks/usePageScrollMovement.ts"
    );
    const movements: Array<{ version: number; delta: number; top: number }> = [];

    function ScrollProbe({ version }: { version: number }) {
      usePageScrollMovement(({ delta, position }) => {
        movements.push({ version, delta, top: position.top });
      });
      return null;
    }
    const tree = (version: number) => React.createElement(
      React.StrictMode,
      null,
      React.createElement(ScrollProbe, { version })
    );
    const container = document.getElementById("root");
    assert.ok(container);
    const root = createRoot(container);

    await React.act(async () => root.render(tree(1)));
    assert.equal(activeScrollListeners.size, 1, "Strict Mode 重放后只能保留一个 scroll listener");
    const listenerCountsAfterMount = {
      adds: scrollListenerAdds,
      removes: scrollListenerRemoves
    };

    scrollY = 120;
    window.dispatchEvent(new window.Event("scroll"));
    assert.equal(frameCallbacks.size, 1);
    await React.act(async () => flushFrames());
    assert.deepEqual(movements, [{ version: 1, delta: 120, top: 120 }]);

    await React.act(async () => root.render(tree(2)));
    assert.deepEqual({
      adds: scrollListenerAdds,
      removes: scrollListenerRemoves
    }, listenerCountsAfterMount, "回调 identity 变化不得重绑 scroll listener");

    scrollY = 175;
    window.dispatchEvent(new window.Event("scroll"));
    await React.act(async () => flushFrames());
    assert.deepEqual(movements.at(-1), { version: 2, delta: 55, top: 175 });

    scrollY = 200;
    window.dispatchEvent(new window.Event("scroll"));
    assert.equal(frameCallbacks.size, 1);
    await React.act(async () => root.unmount());
    assert.equal(frameCallbacks.size, 0, "卸载必须取消尚未执行的滚动帧");
    assert.equal(activeScrollListeners.size, 0);
    assert.equal(scrollListenerRemoves, scrollListenerAdds);
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
test("[Web/共享交互] 共享页面锁计数化冻结根节点并按层级归还滚动与焦点", async (t) => {
  const { window, document } = parseHTML(
    "<!doctype html><html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  const { createPortal } = await import("react-dom");
  const frameCallbacks = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const requestAnimationFrame = (callback: FrameRequestCallback) => {
    const id = nextFrame;
    nextFrame += 1;
    frameCallbacks.set(id, callback);
    return id;
  };
  const cancelAnimationFrame = (id: number) => {
    frameCallbacks.delete(id);
  };
  const flushFrame = () => {
    const callbacks = [...frameCallbacks.values()];
    frameCallbacks.clear();
    for (const callback of callbacks) callback(Date.now());
  };
  const scrollCalls: number[] = [];
  const restoreWindowProperties = installProperties(window, {
    innerWidth: 1200,
    requestAnimationFrame,
    cancelAnimationFrame,
    scrollTo(_x: number, y: number) {
      scrollCalls.push(y);
    },
    scrollY: 137
  });
  t.after(restoreWindowProperties);
  Object.defineProperty(document.documentElement, "clientWidth", {
    configurable: true,
    value: 1180
  });

  let activeElement: HTMLElement = document.body;
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
    if (activeElement === this) activeElement = document.body;
  };

  const activeKeydownListeners = new Set<EventListenerOrEventListenerObject>();
  let keydownListenerAdds = 0;
  let keydownListenerRemoves = 0;
  const addDocumentEventListener = document.addEventListener.bind(document);
  const removeDocumentEventListener = document.removeEventListener.bind(document);
  document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (type === "keydown" && listener) {
      keydownListenerAdds += 1;
      activeKeydownListeners.add(listener);
    }
    if (listener) addDocumentEventListener(type, listener, options);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) => {
    if (type === "keydown" && listener) {
      keydownListenerRemoves += 1;
      activeKeydownListeners.delete(listener);
    }
    if (listener) removeDocumentEventListener(type, listener, options);
  }) as typeof document.removeEventListener;

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
    const { usePageScrollLock } = await import(
      "../../../packages/web/src/hooks/usePageScrollLock.ts"
    );
    const { useDialogFocus } = await import(
      "../../../packages/web/src/hooks/useDialogFocus.ts"
    );
    const pageRoot = document.getElementById("root") as HTMLElement;
    Object.assign(pageRoot.style, {
      position: "relative",
      top: "3px",
      left: "4px",
      right: "5px",
      width: "91%"
    });
    pageRoot.setAttribute("aria-hidden", "preexisting");
    pageRoot.inert = false;
    const root = createRoot(pageRoot);

    const escapeVersions: number[] = [];

    function LockProbe({
      index,
      escapeVersion
    }: {
      index: number;
      escapeVersion: number;
    }) {
      const frameRef = React.useRef<HTMLDivElement | null>(null);
      const closeRef = React.useRef<HTMLButtonElement | null>(null);
      usePageScrollLock();
      useDialogFocus({
        containerRef: frameRef,
        initialFocusRef: closeRef,
        onEscape() {
          escapeVersions.push(escapeVersion);
        }
      });
      return createPortal(React.createElement(
        "div",
        {
          ref: frameRef,
          "data-dialog-frame": "",
          tabIndex: -1
        },
        React.createElement("button", {
          ref: closeRef,
          id: `dialog-close-${index}`
        }, "关闭")
      ), document.body);
    }

    function Harness({
      locks,
      escapeVersion = 0
    }: {
      locks: number;
      escapeVersion?: number;
    }) {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement("button", { id: "page-opener" }, "打开"),
        ...Array.from({ length: locks }, (_, index) => (
          React.createElement(LockProbe, { index, escapeVersion, key: index })
        ))
      );
    }

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 0 }));
    });
    const opener = document.getElementById("page-opener") as HTMLElement;
    opener.focus();

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 1, escapeVersion: 1 }));
    });
    assert.equal(pageRoot.inert, true);
    assert.equal(pageRoot.getAttribute("aria-hidden"), "true");
    assert.equal(pageRoot.style.position, "fixed");
    assert.equal(pageRoot.style.top, "-137px");
    assert.equal(pageRoot.style.right, "20px");
    assert.equal(activeElement.id, "dialog-close-0");
    assert.equal(activeKeydownListeners.size, 1);
    const keydownCountsBeforeCallbackUpdate = {
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    };

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 1, escapeVersion: 2 }));
    });
    assert.deepEqual({
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    }, keydownCountsBeforeCallbackUpdate, "Escape 回调更新不得重绑 keydown listener");
    const escapeEvent = new window.Event("keydown", {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperties(escapeEvent, {
      key: { value: "Escape" },
      keyCode: { value: 27 },
      isComposing: { value: false }
    });
    document.dispatchEvent(escapeEvent);
    assert.deepEqual(escapeVersions, [2], "Escape 必须读取最新已提交回调");
    assert.equal(escapeEvent.defaultPrevented, true);

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 2, escapeVersion: 2 }));
    });
    assert.equal(activeElement.id, "dialog-close-1");
    assert.equal(pageRoot.inert, true);

    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 1, escapeVersion: 2 }));
    });
    assert.equal(activeElement.id, "dialog-close-0");
    assert.equal(pageRoot.inert, true, "子弹窗释放不得解冻页面根");
    assert.equal(pageRoot.getAttribute("aria-hidden"), "true");

    let restoredEvents = 0;
    window.addEventListener("imageshow:page-scroll-restored", () => {
      restoredEvents += 1;
    });
    await React.act(async () => {
      root.render(React.createElement(Harness, { locks: 0 }));
    });
    assert.equal(pageRoot.inert, false);
    assert.equal(pageRoot.getAttribute("aria-hidden"), "preexisting");
    assert.deepEqual({
      position: pageRoot.style.position,
      top: pageRoot.style.top,
      left: pageRoot.style.left,
      right: pageRoot.style.right,
      width: pageRoot.style.width
    }, {
      position: "relative",
      top: "3px",
      left: "4px",
      right: "5px",
      width: "91%"
    });
    assert.equal(activeElement, opener, "最后释放应在根恢复后归还 opener 焦点");
    assert.deepEqual(scrollCalls, [137]);
    flushFrame();
    assert.deepEqual(scrollCalls, [137, 137]);
    flushFrame();
    assert.equal(restoredEvents, 1);

    const strictReturnTarget = document.createElement("button");
    strictReturnTarget.id = "strict-dialog-return-target";
    document.body.append(strictReturnTarget);
    strictReturnTarget.focus();
    const strictReturnFocusRef = { current: strictReturnTarget };
    function StrictDialogProbe({
      active,
      escapeVersion
    }: {
      active: boolean;
      escapeVersion: number;
    }) {
      const frameRef = React.useRef<HTMLDivElement | null>(null);
      const closeRef = React.useRef<HTMLButtonElement | null>(null);
      useDialogFocus({
        containerRef: frameRef,
        initialFocusRef: closeRef,
        returnFocusRef: strictReturnFocusRef,
        onEscape() {
          escapeVersions.push(escapeVersion);
        },
        active
      });
      return React.createElement(
        "div",
        { ref: frameRef, "data-dialog-frame": "", tabIndex: -1 },
        React.createElement("button", {
          ref: closeRef,
          id: "strict-dialog-close"
        }, "关闭")
      );
    }
    const strictDialogTree = (active: boolean, escapeVersion: number) => (
      React.createElement(
        React.StrictMode,
        null,
        React.createElement(StrictDialogProbe, { active, escapeVersion })
      )
    );
    const strictCountsBeforeMount = {
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    };
    await React.act(async () => root.render(strictDialogTree(true, 3)));
    assert.deepEqual({
      adds: keydownListenerAdds - strictCountsBeforeMount.adds,
      removes: keydownListenerRemoves - strictCountsBeforeMount.removes
    }, {
      adds: 2,
      removes: 1
    }, "Strict Mode 应重放一次 keydown listener setup 与 cleanup");
    assert.equal(activeKeydownListeners.size, 1);
    assert.equal(activeElement.id, "strict-dialog-close");
    const strictCountsBeforeCallbackUpdate = {
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    };

    await React.act(async () => root.render(strictDialogTree(true, 4)));
    assert.deepEqual({
      adds: keydownListenerAdds,
      removes: keydownListenerRemoves
    }, strictCountsBeforeCallbackUpdate);
    const strictEscapeEvent = new window.Event("keydown", {
      bubbles: true,
      cancelable: true
    });
    Object.defineProperties(strictEscapeEvent, {
      key: { value: "Escape" },
      keyCode: { value: 27 },
      isComposing: { value: false }
    });
    document.dispatchEvent(strictEscapeEvent);
    assert.deepEqual(escapeVersions, [2, 4]);

    const replacementTarget = document.createElement("button");
    replacementTarget.id = "replacement-dialog-return-target";
    document.body.append(replacementTarget);
    strictReturnTarget.remove();
    strictReturnFocusRef.current = replacementTarget;
    await React.act(async () => root.render(strictDialogTree(false, 4)));
    assert.equal(activeKeydownListeners.size, 0);
    assert.equal(activeElement, replacementTarget, "关闭应归还到调用方更新后的可用目标");
    await React.act(async () => root.render(strictDialogTree(true, 5)));
    document.body.append(strictReturnTarget);
    replacementTarget.remove();
    strictReturnFocusRef.current = strictReturnTarget;
    await React.act(async () => root.unmount());
    assert.equal(activeElement, strictReturnTarget, "卸载关闭也应读取最新归还目标");
    assert.equal(activeKeydownListeners.size, 0);
    assert.equal(keydownListenerRemoves, keydownListenerAdds);
    strictReturnTarget.remove();
  } finally {
    window.HTMLElement.prototype.focus = originalFocus;
    window.HTMLElement.prototype.blur = originalBlur;
    for (const [key, descriptor] of previousGlobals) {
      if (descriptor) {
        Object.defineProperty(globalThis, key, descriptor);
      } else {
        delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});
