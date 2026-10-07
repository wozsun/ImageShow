import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import type {
  AdminImageListItemDto,
  CompletedIngestionImageDto
} from "../../../packages/shared/src/browser.ts";
import type { EditableImageSnapshotDto, GalleryImageCardDto } from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../packages/web/src/pages/admin/ingestion/queue/model/ingestion-job.ts";
import { publicNavigationAutoHideDelayMs } from "../../../packages/web/src/lib/ui/public-navigation.ts";

export function galleryCard(
  id: string,
  width = 100,
  height = 100
): GalleryImageCardDto {
  return {
    id,
    title: id,
    theme: null,
    base_url: "/images",
    width,
    height,
    tags: []
  };
}
export function ingestionJob(patch: Partial<IngestionJob> = {}): IngestionJob {
  return {
    id: "job-1",
    attemptKey: "attempt-1",
    batchKey: "batch-1",
    kind: "import",
    status: "queued",
    message: "等待下载",
    preview: "",
    draft: {
      title: "",
      description: "",
      source: "",
      original: "https://example.com/image.jpg",
      device: "pc",
      brightness: "dark",
      theme: "existing-theme",
      author: "existing-author",
      tags: ["existing-tag"]
    },
    width: 0,
    height: 0,
    md5: "f".repeat(32),
    duplicates: [],
    duplicateDecision: "upload",
    storageSlug: "local",
    ...patch
  };
}
/** Serves as an admin list item and as a completed ingestion image, which also carries its MD5. */
export function adminImageListItem(
  patch: Partial<AdminImageListItemDto & CompletedIngestionImageDto> = {}
): AdminImageListItemDto & CompletedIngestionImageDto {
  const timestamp = "2026-08-13T00:00:00.000Z";
  return {
    id: "00000000-0000-7000-8000-000000000001",
    title: "fixture",
    description: "",
    source: null,
    original: "fixture.jpg",
    base_url: "/images",
    variants: { large: {width:1600,height:900,byte_size:1}, medium: {width:1200,height:675,byte_size:1}, small: {width:600,height:338,byte_size:1} },
    device: "pc",
    brightness: "dark",
    theme: null,
    author: null,
    tags: [],
    width: 1600,
    height: 900,
    original_url: null,
    image_time: timestamp,
    status: "ready",
    purge_pending: false,
    storage_slug: "local",
    large_md5: "00000000000000000000000000000000",
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...patch
  };
}
export function editableImage(
  id: string,
  overrides: Partial<EditableImageSnapshotDto> = {}
): EditableImageSnapshotDto {
  return {
    id,
    title: id + "-title",
    description: id + "-description",
    source: "https://example.com/" + id,
    original: "https://example.com/" + id + ".jpg",
    device: "pc",
    brightness: "dark",
    theme: "theme",
    author: "author",
    tags: ["tag"],
    base_url: "/images",
    variants: { large: {width:1920,height:1080,byte_size:1024}, medium: {width:1200,height:675,byte_size:800}, small: {width:600,height:338,byte_size:200} },
    original_url: "/images/original/" + id,
    width: 1920,
    height: 1080,
    storage_slug: "local",
    ...overrides
  };
}
export async function createPublicNavigationHarness(
  t: TestContext,
  {
    movement = "manual",
    headerPresent = true,
    mobileLayout = false
  }: {
    movement?: "manual" | "page";
    headerPresent?: boolean;
    mobileLayout?: boolean;
  } = {}
) {
  const { window: domWindow, document } = parseHTML(
    "<html><body><div id=root></div></body></html>"
  );
  const React = await import("react");
  let now = 0;
  let serial = 0;
  let hovered = false;
  let focused = false;
  let keyboardFocus = false;
  let activeElement: HTMLElement | null = null;
  let toolbarVisible = false;
  let filtersOpen = false;
  let setPlaying: (playing: boolean) => void;
  let setPaused: (paused: boolean) => void;
  let hidden = false;
  let advanceManualNavigation: (delta: number, pointerType?: string) => void;
  const timers = new Map<number, { due: number; callback: () => void }>();
  const schedule = (callback: () => void, delay = 0) => {
    const id = ++serial;
    timers.set(id, { due: now + delay, callback });
    return id;
  };
  const overrides: Record<string, unknown> = {
    innerWidth: mobileLayout ? 390 : 1440,
    innerHeight: 900,
    scrollY: 0,
    setTimeout: schedule,
    clearTimeout: (id: number) => timers.delete(id),
    requestAnimationFrame: (callback: FrameRequestCallback) => schedule(() => callback(now), 16),
    cancelAnimationFrame: (id: number) => timers.delete(id),
    matchMedia: (media: string) => ({
      matches:
        media === "(max-width: 760px)"
          ? mobileLayout
          : media === "(hover: hover) and (pointer: fine)" && !mobileLayout,
      media,
      addEventListener() {},
      removeEventListener() {}
    })
  };
  const window = new Proxy(domWindow, {
    get: (target, key) =>
      typeof key === "string" && key in overrides
        ? overrides[key]
        : Reflect.get(target, key),
    set: (_target, key, value) => {
      overrides[String(key)] = value;
      return true;
    }
  });
  for (const element of [document.documentElement, document.body]) {
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 10_000 });
  }
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => activeElement
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  const globals = {
    window,
    self: window,
    document,
    navigator: domWindow.navigator,
    Node: domWindow.Node,
    Element: domWindow.Element,
    HTMLElement: domWindow.HTMLElement,
    Event: domWindow.Event,
    MutationObserver: domWindow.MutationObserver,
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    React,
    IS_REACT_ACT_ENVIRONMENT: true
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let unmount: (() => Promise<void>) | undefined;
  t.after(async () => {
    try {
      await unmount?.();
      assert.equal(timers.size, 0, "卸载清理导航计时与滚动帧");
    } finally {
      timers.clear();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { usePublicImageViewportControls } =
    await import("../../../packages/web/src/hooks/usePublicImageViewportControls.ts");
  const installed = new WeakSet<HTMLElement>();
  function Harness() {
    const [playing, updatePlaying] = React.useState(true);
    setPlaying = updatePlaying;
    const [paused, updatePaused] = React.useState(false);
    setPaused = updatePaused;
    const [filterActive, setFilterActive] = React.useState(false);
    const controls = usePublicImageViewportControls({
      movement,
      headerPresent,
      paused: paused || filterActive,
      autoHideAfterMs:
        movement === "manual" && playing ? publicNavigationAutoHideDelayMs : undefined
    });
    toolbarVisible = controls.toolbarVisible;
    filtersOpen = filterActive;
    advanceManualNavigation = controls.advanceManualNavigation;
    return React.createElement(
      "div",
      {
        className: "public-navigation-stack",
        ref: (element: HTMLElement | null) => {
          if (!element || installed.has(element)) return;
          installed.add(element);
          const nativeMatches = element.matches.bind(element);
          const nativeQuerySelector = element.querySelector.bind(element);
          Object.defineProperty(element, "matches", {
            configurable: true,
            value: (selector: string) =>
              selector === ":hover"
                ? hovered
                : selector === ":hover, :focus-within"
                  ? hovered || focused
                  : selector === ":focus-visible"
                    ? false
                    : nativeMatches(selector)
          });
          element.querySelector = ((selector: string) =>
            selector === ":focus-visible"
              ? focused && keyboardFocus
                ? nativeQuerySelector("button")
                : null
              : nativeQuerySelector(selector)) as typeof element.querySelector;
          element.getBoundingClientRect = () => ({ height: 96 }) as DOMRect;
        }
      },
      React.createElement(
        "div",
        {
          ref: (element: HTMLElement | null) => {
            controls.toolbarRef.current = element;
            if (element) element.getBoundingClientRect = () => ({ height: 36 }) as DOMRect;
          }
        },
        React.createElement(
          "button",
          {
            "aria-expanded": filterActive,
            onClick: () => setFilterActive((current) => !current),
            ref: (element: HTMLButtonElement | null) => {
              if (!element) return;
              element.getBoundingClientRect = () => ({ bottom: 96, height: 36 }) as DOMRect;
              element.focus = () => {
                focused = true;
                activeElement = element;
              };
              element.blur = () => {
                focused = false;
                activeElement = null;
              };
            }
          },
          "筛选"
        )
      )
    );
  }
  const root = createRoot(document.getElementById("root")!);
  unmount = async () => {
    await React.act(async () => root.unmount());
  };
  await React.act(async () => root.render(React.createElement(Harness)));
  const navigation = document.querySelector<HTMLElement>(".public-navigation-stack")!;
  const dispatch = async (
    target: EventTarget,
    type: string,
    values: Record<string, unknown> = {}
  ) => {
    await React.act(async () => {
      const event = new domWindow.Event(type, { bubbles: true });
      Object.assign(event, values);
      target.dispatchEvent(event);
      await Promise.resolve();
    });
  };
  return {
    visible: () => toolbarVisible,
    filtersOpen: () => filtersOpen,
    timerCount: () => timers.size,
    advance: async (milliseconds: number) => {
      await React.act(async () => {
        const until = now + milliseconds;
        while (true) {
          const next = [...timers]
            .filter(([, value]) => value.due <= until)
            .sort((left, right) => left[1].due - right[1].due)[0];
          if (!next) break;
          now = next[1].due;
          timers.delete(next[0]);
          next[1].callback();
        }
        now = until;
      });
    },
    pointer: (clientY: number, buttons = 0, isTrusted = true) =>
      dispatch(document, "pointermove", { clientY, buttons, pointerType: "mouse", isTrusted }),
    pointerOver: (relatedTarget: EventTarget | null) =>
      dispatch(document, "pointerover", {
        clientY: 10,
        buttons: 0,
        pointerType: "mouse",
        isTrusted: true,
        relatedTarget
      }),
    documentBody: document.body,
    playing: async (playing: boolean) => {
      await React.act(async () => setPlaying(playing));
    },
    paused: async (paused: boolean) => {
      await React.act(async () => setPaused(paused));
    },
    hidden: async (value: boolean) => {
      hidden = value;
      await dispatch(document, "visibilitychange");
    },
    click: () => dispatch(document.body, "click"),
    toggleFilters: () => dispatch(navigation.querySelector("button")!, "click"),
    manual: async (delta: number, pointerType?: string) => {
      await React.act(async () => advanceManualNavigation(delta, pointerType));
    },
    hover: async (value: boolean) => {
      hovered = value;
      await dispatch(navigation, value ? "mouseenter" : "mouseleave");
    },
    focus: async (value: boolean, visible = true) => {
      focused = value;
      keyboardFocus = visible;
      activeElement = value ? navigation.querySelector("button") : null;
      await dispatch(navigation, value ? "focusin" : "focusout");
    },
    scroll: async (scrollY: number) => {
      overrides.scrollY = scrollY;
      await dispatch(window, "scroll");
    }
  };
}
export async function createConfigStreamHarness(
  t: TestContext,
  {
    honorAbort = true,
    animationFrame
  }: {
    honorAbort?: boolean;
    animationFrame?: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;
  } = {}
) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { window, document } = parseHTML("<html><body><div id=root></div></body></html>");
  const pending: Array<{
    path: string;
    body?: BodyInit | null;
    headers?: HeadersInit;
    cache?: RequestCache;
    credentials?: RequestCredentials;
    signal: AbortSignal | null | undefined;
    resolve: (response: Response) => void;
  }> = [];
  const globals = {
    window,
    document,
    self: window,
    navigator: window.navigator,
    innerWidth: 1024,
    innerHeight: 768,
    requestAnimationFrame:
      animationFrame?.requestAnimationFrame ??
      ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0)),
    cancelAnimationFrame:
      animationFrame?.cancelAnimationFrame
        ?? ((id: number) => window.clearTimeout(id)),
    location: new URL("https://img.example/show"),
    matchMedia: (media: string) => ({
      media,
      matches: false,
      addEventListener() {},
      removeEventListener() {}
    }),
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (path: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        if (String(path).endsWith("/logs/client-errors")) {
          resolve(Response.json({ ok: true }));
          return;
        }
        pending.push({
          path: String(path),
          body: init?.body,
          headers: init?.headers,
          cache: init?.cache,
          credentials: init?.credentials,
          signal: init?.signal,
          resolve
        });
        if (honorAbort)
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true }
          );
      })
  };
  const originals = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  t.after(async () => {
    try {
      await React.act(async () => root.unmount());
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
  const flush = async () => {
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  return {
    React,
    root,
    window: window as unknown as Window,
    document,
    pending,
    flush,
    render: async (node: import("react").ReactNode) => {
      await React.act(async () => root.render(node));
    },
    respond: async (index: number, body: unknown, status = 200) => {
      await React.act(async () => pending[index].resolve(Response.json(body, { status })));
      await flush();
    }
  };
}
