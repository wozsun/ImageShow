import assert from "node:assert/strict";
import {
  readFileSync
} from "node:fs";
import {
  type TestContext
} from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  Texture,
  type Rectangle,
  type Renderer
} from "pixi.js";
import {
  type AdminImageListItemDto,
  type GalleryImageCardDto,
  type ImageUpdateResponseDto,
  type PublicImageListResponseDto,
  type ShowImageCardDto
} from "../../../packages/shared/src/browser.ts";
import type {
  EditableImageSnapshot,
  GalleryImageCard,
  IngestionJob
} from "../../../packages/web/src/lib/types.ts";
import {
  defaultShowFloatSizeIndex
} from "../../../packages/web/src/pages/show/pixi/show-pixi-layout.ts";
import {
  ShowPixiFloatScene
} from "../../../packages/web/src/pages/show/pixi/show-pixi-float-scene.ts";
import type {
  ShowPixiTextureCache
} from "../../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts";
import type {
  ShowPixiVisibleItem
} from "../../../packages/web/src/pages/show/pixi/show-pixi-types.ts";
import {
  publicNavigationAutoHideDelayMs
} from "../../../packages/web/src/lib/ui/public-navigation.ts";
import {
  GalleryDataWindow,
  type GalleryPageIntent
} from "../../../packages/web/src/pages/gallery/gallery-data-window.ts";

export function galleryCardDto(
  id: string,
  width = 100,
  height = 100
): GalleryImageCardDto {
  return {
    id,
    title: id,
    device: "pc",
    brightness: "dark",
    theme: "none",
    author: "",
    thumb_url: "/images/thumbs/" + id + ".webp",
    width,
    height,
    tags: [],
    image_time: "2026-09-01T00:00:00.000Z"
  };
}
export function galleryCard(id: string, width = 100, height = 100): GalleryImageCard {
  return galleryCardDto(id, width, height);
}
export function syntheticGalleryPage({
  count,
  start,
  total
}: {
  count: number;
  start: number;
  total: number;
}): PublicImageListResponseDto {
  const end = Math.min(total, start + count);
  return {
    items: Array.from({ length: end - start }, (_, offset) => {
      const index = start + offset;
      const serial = String(index).padStart(12, "0");
      return galleryCard(
        `00000000-0000-7000-8000-${serial}`,
        index % 3 === 0 ? 900 : 1600,
        index % 3 === 0 ? 1600 : 900
      );
    }),
    next_cursor: end < total ? `cursor-${end}` : null
  };
}
export function resolveGalleryIntent(
  window: GalleryDataWindow,
  intent: GalleryPageIntent,
  payload: PublicImageListResponseDto
) {
  const request = window.claimRequest(intent);
  assert.ok(request);
  assert.equal(window.resolvePage(request, payload), true);
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
export function adminImageListItem(
  patch: Partial<AdminImageListItemDto> = {}
): AdminImageListItemDto {
  const timestamp = "2026-08-13T00:00:00.000Z";
  return {
    id: "00000000-0000-7000-8000-000000000001",
    title: "fixture",
    description: "",
    source: null,
    original: "fixture.jpg",
    object_url: "/images/full/01/00000000-0000-7000-8000-000000000001.jpg",
    thumb_url: "/images/thumbs/01/00000000-0000-7000-8000-000000000001.webp",
    device: "pc",
    brightness: "dark",
    theme: "none",
    author: "",
    tags: [],
    width: 1600,
    height: 900,
    original_url: null,
    image_time: timestamp,
    status: "ready",
    purge_pending: false,
    object_key: "01/00000000-0000-7000-8000-000000000001.jpg",
    storage_slug: "local",
    md5: "00000000000000000000000000000000",
    image_size: 1,
    deleted_at: null,
    created_at: timestamp,
    updated_at: timestamp,
    ...patch
  };
}
export function editableImage(
  id: string,
  overrides: Partial<EditableImageSnapshot> = {}
): EditableImageSnapshot {
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
    thumb_url: "/thumb/" + id,
    object_url: "/image/" + id,
    original_url: "/images/original/" + id,
    width: 1920,
    height: 1080,
    image_size: 1024,
    object_key: id + ".webp",
    storage_slug: "local",
    ...overrides
  };
}
export function imageUpdateResponse(
  updatedIds: string[],
  failedIds: string[] = []
): ImageUpdateResponseDto {
  return {
    updated: updatedIds.length,
    failed: failedIds.length,
    results: [
      ...updatedIds.map((id) => ({ id, status: "updated" as const })),
      ...failedIds.map((id) => ({
        id,
        status: "failed" as const,
        code: "update_failed",
        message: "failed"
      }))
    ]
  };
}
export async function createPublicNavigationHarness(
  t: TestContext,
  { movement = "manual", headerPresent = true, mobileLayout = false }: {
    movement?: "manual" | "page";
    headerPresent?: boolean;
    mobileLayout?: boolean;
  } = {}
) {
  const { window: domWindow, document } = parseHTML('<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id=root></div></body></html>');
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]')!;
  const originalViewport = viewport.content;
  const React = await import("react");
  let now = 0;
  let serial = 0;
  let hovered = false;
  let focused = false;
  let keyboardFocus = false;
  let activeElement: HTMLElement | null = null;
  let readOnlyLink: HTMLElement | null = null;
  let readOnlyLinkSelection = false;
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
      matches: media === "(max-width: 760px)" ? mobileLayout
        : media === "(hover: hover) and (pointer: fine)" && !mobileLayout,
      media, addEventListener() {}, removeEventListener() {}
    })
  };
  const window = new Proxy(domWindow, {
    get: (target, key) => typeof key === "string" && key in overrides
      ? overrides[key] : Reflect.get(target, key),
    set: (_target, key, value) => { overrides[String(key)] = value; return true; }
  });
  for (const element of [document.documentElement, document.body]) {
    Object.defineProperty(element, "scrollHeight", { configurable: true, value: 10_000 });
  }
  Object.defineProperty(document, "activeElement", { configurable: true, get: () => activeElement });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  Object.defineProperty(document, "getSelection", {
    configurable: true,
    value: () => ({
      anchorNode: readOnlyLink?.firstChild ?? readOnlyLink,
      focusNode: readOnlyLink?.firstChild ?? readOnlyLink,
      isCollapsed: !readOnlyLinkSelection
    })
  });
  const globals = {
    window, self: window, document, navigator: domWindow.navigator,
    Node: domWindow.Node, Element: domWindow.Element, HTMLElement: domWindow.HTMLElement,
    Event: domWindow.Event, MutationObserver: domWindow.MutationObserver,
    ResizeObserver: class { observe() {} disconnect() {} },
    React, IS_REACT_ACT_ENVIRONMENT: true
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let unmount: (() => Promise<void>) | undefined;
  t.after(async () => {
    try {
      await unmount?.();
      assert.equal(timers.size, 0, "卸载清理导航计时与滚动帧");
      assert.equal(viewport.content, originalViewport, "离开图片页后恢复视口，不影响首页和后台");
    } finally {
      timers.clear();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
  const { createRoot } = await import("react-dom/client");
  const { usePublicImageViewportControls } = await import("../../../packages/web/src/hooks/usePublicImageViewportControls.ts");
  const installed = new WeakSet<HTMLElement>();
  function Harness() {
    const [playing, updatePlaying] = React.useState(true);
    setPlaying = updatePlaying;
    const [paused, updatePaused] = React.useState(false);
    setPaused = updatePaused;
    const controls = usePublicImageViewportControls({
      movement, headerPresent, paused,
      autoHideAfterMs: movement === "manual" && playing ? publicNavigationAutoHideDelayMs : undefined
    });
    toolbarVisible = controls.toolbarVisible;
    filtersOpen = controls.filtersOpen;
    advanceManualNavigation = controls.advanceManualNavigation;
    return React.createElement("div", {
      className: "public-navigation-stack",
      ref: (element: HTMLElement | null) => {
        if (!element || installed.has(element)) return;
        installed.add(element);
        const nativeMatches = element.matches.bind(element);
        const nativeQuerySelector = element.querySelector.bind(element);
        Object.defineProperty(element, "matches", {
          configurable: true,
          value: (selector: string) => selector === ":hover"
            ? hovered
            : selector === ":hover, :focus-within"
            ? hovered || focused
            : selector === ":focus-visible"
              ? false
              : nativeMatches(selector)
        });
        element.querySelector = ((selector: string) => selector === ":focus-visible"
          ? focused && keyboardFocus ? nativeQuerySelector("button") : null
          : nativeQuerySelector(selector)) as typeof element.querySelector;
        element.getBoundingClientRect = () => ({ height: 96 } as DOMRect);
      }
    }, React.createElement("div", {
      ref: (element: HTMLElement | null) => {
        controls.toolbarRef.current = element;
        if (element) element.getBoundingClientRect = () => ({ height: 36 } as DOMRect);
      }
    }, React.createElement("button", {
      "aria-expanded": controls.filtersOpen,
      onClick: controls.toggleFilters,
      ref: (element: HTMLButtonElement | null) => {
        controls.filterToggleRef.current = element;
        if (!element) return;
        element.getBoundingClientRect = () => ({ bottom: 96, height: 36 } as DOMRect);
        element.focus = () => { focused = true; activeElement = element; };
        element.blur = () => { focused = false; activeElement = null; };
      }
    }, "筛选"), React.createElement("div", {
      ref: controls.filterPanelRef,
      "aria-hidden": controls.filterPanelHidden,
      inert: controls.filterPanelHidden
    }), React.createElement("span", {
      ref: (element: HTMLElement | null) => {
        readOnlyLink = element;
        if (!element) return;
        const nativeMatches = element.matches.bind(element);
        Object.defineProperty(element, "matches", {
          configurable: true,
          value: (selector: string) => selector === ":focus-visible"
            ? activeElement === element && keyboardFocus
            : nativeMatches(selector)
        });
        element.blur = () => {
          focused = false;
          activeElement = null;
          readOnlyLinkSelection = false;
        };
      },
      role: "textbox",
      tabIndex: 0,
      "aria-readonly": "true"
    }, "https://example.com/random")));
  }
  const root = createRoot(document.getElementById("root")!);
  unmount = async () => { await React.act(async () => root.unmount()); };
  await React.act(async () => root.render(React.createElement(Harness)));
  assert.equal(viewport.content, `${originalViewport}, viewport-fit=cover`, "普通及嵌入图片页统一启用安全区布局");
  const navigation = document.querySelector<HTMLElement>(".public-navigation-stack")!;
  const dispatch = async (target: EventTarget, type: string, values: Record<string, unknown> = {}) => {
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
          const next = [...timers].filter(([, value]) => value.due <= until)
            .sort((left, right) => left[1].due - right[1].due)[0];
          if (!next) break;
          now = next[1].due;
          timers.delete(next[0]);
          next[1].callback();
        }
        now = until;
      });
    },
    pointer: (clientY: number, buttons = 0, isTrusted = true) => dispatch(document, "pointermove", { clientY, buttons, pointerType: "mouse", isTrusted }),
    pointerOver: (relatedTarget: EventTarget | null) => dispatch(document, "pointerover", {
      clientY: 10, buttons: 0, pointerType: "mouse", isTrusted: true, relatedTarget
    }),
    documentBody: document.body,
    playing: async (playing: boolean) => { await React.act(async () => setPlaying(playing)); },
    paused: async (paused: boolean) => { await React.act(async () => setPaused(paused)); },
    hidden: async (value: boolean) => { hidden = value; await dispatch(document, "visibilitychange"); },
    click: () => dispatch(document.body, "click"),
    toggleFilters: () => dispatch(navigation.querySelector("button")!, "click"),
    readOnlySelection: async (selected: boolean) => {
      assert.ok(readOnlyLink);
      readOnlyLinkSelection = selected;
      if (activeElement !== readOnlyLink) {
        focused = true;
        keyboardFocus = false;
        activeElement = readOnlyLink;
        await dispatch(readOnlyLink, "focusin");
      }
      await dispatch(document, "selectionchange");
    },
    manual: async (delta: number, pointerType?: string) => {
      await React.act(async () => advanceManualNavigation(delta, pointerType));
    },
    hover: async (value: boolean) => { hovered = value; await dispatch(navigation, value ? "mouseenter" : "mouseleave"); },
    focus: async (value: boolean, visible = true) => {
      focused = value;
      keyboardFocus = visible;
      activeElement = value ? navigation.querySelector("button") : null;
      await dispatch(navigation, value ? "focusin" : "focusout");
    },
    scroll: async (scrollY: number) => { overrides.scrollY = scrollY; await dispatch(window, "scroll"); }
  };
}
export function showImages(count: number): ShowImageCardDto[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `00000000-0000-7000-8000-${String(index).padStart(12, "0")}`,
    title: `Image ${index}`,
    thumb_url: `/images/thumbs/${index}.webp`,
    width: index % 2 ? 1600 : 900,
    height: index % 2 ? 900 : 1600
  }));
}
export function createCameraTestElement(width = 800, height = 600) {
  const listeners = new Map<string, Set<(event: Record<string, unknown>) => void>>();
  const capturedPointers = new Set<number>();
  const element = {
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      const entries = listeners.get(type) ?? new Set();
      entries.add(listener);
      listeners.set(type, entries);
    },
    removeEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      listeners.get(type)?.delete(listener);
    },
    getBoundingClientRect: () => ({
      bottom: height,
      height,
      left: 0,
      right: width,
      top: 0,
      width,
      x: 0,
      y: 0,
      toJSON: () => ({})
    }),
    hasPointerCapture: (pointerId: number) => capturedPointers.has(pointerId),
    releasePointerCapture: (pointerId: number) => capturedPointers.delete(pointerId),
    setPointerCapture: (pointerId: number) => capturedPointers.add(pointerId)
  } as unknown as HTMLElement;
  return {
    element,
    emit(type: string, values: Record<string, unknown>) {
      let prevented = false;
      const event = {
        button: 0,
        cancelable: true,
        clientX: 0,
        clientY: 0,
        deltaMode: 0,
        deltaY: 0,
        pointerId: 1,
        pointerType: "mouse",
        preventDefault: () => {
          prevented = true;
        },
        timeStamp: 0,
        ...values
      };
      for (const listener of listeners.get(type) ?? []) listener(event);
      return prevented;
    },
    listenerCount: () => [...listeners.values()].reduce(
      (total, entries) => total + entries.size,
      0
    )
  };
}
export function installPixiPaletteFixture(t: TestContext) {
  // Exercise the production palette using its real CSS values. Geometry tests
  // do not need a GPU, but cards now correctly share the browser color owner.
  const css = ["semantic-colors.css", "gallery-semantic-colors.css"]
    .map((name) => readFileSync(`packages/web/src/styles/${name}`, "utf8")).join("\n");
  const tokens = new Map([...css.matchAll(/(--[\w-]+):\s*([^;]+);/gu)]
    .map((match) => [match[1], match[2].trim()]));
  const globals = {
    document: { documentElement: {} },
    getComputedStyle: () => ({ getPropertyValue: (key: string) => tokens.get(key) ?? "" })
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  t.after(() => {
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
}
export function createFloatSceneHarness(
  t: TestContext,
  { width = 1440, height = 900, sizeIndex = defaultShowFloatSizeIndex, count = 700, hasMore = count > 500 }: {
    width?: number; height?: number; sizeIndex?: number; count?: number; hasMore?: boolean;
  } = {}
) {
  installPixiPaletteFixture(t);
  const dpr = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
  Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 1 });
  t.after(() => {
    if (dpr) Object.defineProperty(globalThis, "devicePixelRatio", dpr);
    else delete (globalThis as Record<string, unknown>).devicePixelRatio;
  });
  type Acquisition = {
    key: string;
    active: boolean;
    shared: boolean;
    readyAtAcquire: boolean;
    notify: Parameters<ShowPixiTextureCache["acquire"]>[2];
  };
  const acquisitions: Acquisition[] = [];
  const ready = new Set<string>();
  const cache = {
    acquire(
      url: string,
      lod: Parameters<ShowPixiTextureCache["acquire"]>[1],
      notify: Acquisition["notify"]
    ) {
      const key = `${url}:${lod.pixelWidth}x${lod.pixelHeight}`;
      const acquisition: Acquisition = {
        key,
        active: true,
        shared: acquisitions.some((entry) => entry.active && entry.key === key),
        readyAtAcquire: ready.has(key),
        notify
      };
      acquisitions.push(acquisition);
      if (ready.has(key)) queueMicrotask(() => {
        if (acquisition.active) notify(Texture.EMPTY, false);
      });
      return { release: () => { acquisition.active = false; } };
    }
  } as unknown as ShowPixiTextureCache;
  let visibleItems: readonly ShowPixiVisibleItem[] = [];
  let requests = 0;
  let pointerY = height / 2;
  let pointerTime = 0;
  const movements: number[] = [];
  const movementPointerTypes: Array<string | undefined> = [];
  const target = createCameraTestElement(width, height);
  const scene = new ShowPixiFloatScene({
    width,
    height,
    sizeIndex,
    images: showImages(count),
    hasMore,
    dataKey: "desktop-float",
    order: "latest",
    inputElement: target.element,
    textureCache: cache,
    // Geometry/stream tests never create a renderer or open the browser.
    renderer: {} as Renderer,
    running: false,
    reducedMotion: false,
    speed: 28,
    onNeedImages: () => { requests += 1; },
    onOpen: () => undefined,
    onVisibleItems: (items) => { visibleItems = items; },
    onSizeIndexChange: (index) => index,
    onManualVerticalMovement: (delta, pointerType) => {
      movements.push(delta);
      movementPointerTypes.push(pointerType);
    }
  });
  scene.update(0);
  t.after(() => {
    scene.destroy();
    scene.destroy();
    assert.equal(target.listenerCount(), 0);
    assert.equal(acquisitions.filter((entry) => entry.active).length, 0);
    assert.deepEqual(visibleItems, []);
  });
  return {
    scene,
    target,
    visibleItems: () => visibleItems,
    acquisitions,
    movements,
    movementPointerTypes,
    requests: () => requests,
    activeLeases: () => acquisitions.filter((entry) => entry.active),
    resolveTextures() {
      for (const entry of acquisitions) {
        if (!entry.active) continue;
        ready.add(entry.key);
        entry.notify(Texture.EMPTY, false);
      }
    },
    advance(frames: number) {
      for (let frame = 0; frame < frames; frame += 1) scene.update(16);
    },
    dragBy(delta: number) {
      if (scene.stats().activePointers === 0) {
        target.emit("pointerdown", { clientY: pointerY, timeStamp: pointerTime });
      }
      pointerY += delta;
      pointerTime += 16;
      target.emit("pointermove", { clientY: pointerY, timeStamp: pointerTime });
      scene.update(16);
    }
  };
}
export function floatCardPositions(scene: ShowPixiFloatScene) {
  return scene.root.children.map((root) => {
    const bounds = root.hitArea as Rectangle;
    return { root, x: root.x, y: root.y, width: bounds.width, height: bounds.height, rotation: root.rotation };
  });
}
type TextureRecoveryHarnessOptions = {
  maximumEntries?: number;
  maximumPixels?: number;
  maximumUnreferenced?: number;
};

export async function createTextureRecoveryHarness(t: TestContext, {
  maximumEntries = 1,
  maximumPixels = maximumEntries * 128 * 128,
  maximumUnreferenced = 0
}: TextureRecoveryHarnessOptions = {}) {
  installPixiPaletteFixture(t);
  const { ShowPixiTextureCache } = await import("../../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts");
  const { ShowPixiCard, ShowPixiPerspectiveCoordinator } = await import("../../../packages/web/src/pages/show/pixi/show-pixi-card.ts");
  const requests: string[] = [];
  const holds = new Map<string, Promise<void>>();
  const statuses = new Map<string, number>();
  let offline = false;
  let decodeFails = false;
  let failurePhase: "headers" | "body" = "headers";
  const globals = {
    window: { location: new URL("https://img.example/show") },
    devicePixelRatio: 1,
    fetch: async (url: string) => {
      requests.push(url);
      await holds.get(url);
      if (offline) {
        if (failurePhase === "headers") throw new TypeError("Failed to fetch");
        return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("Response interrupted")); } }));
      }
      return new Response(new Blob(["image"]), { status: statuses.get(url) ?? (url.includes("missing") ? 404 : 200) });
    },
    createImageBitmap: async (_blob: Blob, options: ImageBitmapOptions = {}) => {
      if (decodeFails) throw new Error("Invalid image bytes");
      return { width: options.resizeWidth ?? 128, height: options.resizeHeight ?? 128, close() {} };
    }
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const cache = new ShowPixiTextureCache({
    maximumEntries, maximumPixels, maximumInFlight: 1,
    maximumUnreferenced, generateMipmaps: false
  });
  const cards: InstanceType<typeof ShowPixiCard>[] = [];
  const coordinator = new ShowPixiPerspectiveCoordinator();
  t.after(() => {
    for (const card of cards) card.destroy();
    cache.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  return {
    cache, requests,
    hold(id: string) {
      const pending = Promise.withResolvers<void>();
      holds.set(`https://textures.example/${id}.webp`, pending.promise);
      t.after(() => pending.resolve());
      return pending.resolve;
    },
    setOffline(value: boolean, phase: "headers" | "body" = "headers") { offline = value; failurePhase = phase; },
    setStatus(id: string, status: number) { statuses.set(`https://textures.example/${id}.webp`, status); },
    setDecodeFailure(value: boolean) { decodeFails = value; },
    async flush() {
      for (let turn = 0; turn < 200; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        if (cache.stats().inFlight === 0 && cache.stats().queued === 0) return;
      }
      assert.fail(`纹理队列未收敛: ${JSON.stringify(cache.stats())}`);
    },
    card(id: string, onOpen: (image: { id: string }, key: string) => void = () => undefined,
      thumbUrl = `https://textures.example/${id}.webp`) {
      const card = new ShowPixiCard(cache, onOpen, {} as Renderer, coordinator);
      cards.push(card);
      card.assign(id, { ...showImages(1)[0], id, width: 128, height: 128, thumb_url: thumbUrl }, 100, 100, .04);
      return card;
    }
  };
}
export async function createConfigStreamHarness(t: TestContext, {
  honorAbort = true,
  animationFrame
}: {
  honorAbort?: boolean;
  animationFrame?: Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame">;
} = {}) {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { window, document } = parseHTML("<html><body><div id=root></div></body></html>");
  const pending: Array<{ path: string; body?: BodyInit | null; cache?: RequestCache; credentials?: RequestCredentials; signal: AbortSignal | null | undefined; resolve: (response: Response) => void }> = [];
  const globals = {
    window, document, self: window, navigator: window.navigator,
    innerWidth: 1024, innerHeight: 768,
    requestAnimationFrame: animationFrame?.requestAnimationFrame
      ?? ((callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 0)),
    cancelAnimationFrame: animationFrame?.cancelAnimationFrame
      ?? ((id: number) => window.clearTimeout(id)),
    location: new URL("https://img.example/show"),
    matchMedia: (media: string) => ({ media, matches: false, addEventListener() {}, removeEventListener() {} }),
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    React, IS_REACT_ACT_ENVIRONMENT: true,
    fetch: (path: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      if (String(path).endsWith("/logs/client-errors")) { resolve(Response.json({ ok: true })); return; }
      pending.push({ path: String(path), body: init?.body, cache: init?.cache, credentials: init?.credentials, signal: init?.signal, resolve });
      if (honorAbort) init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    })
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const root = createRoot(document.getElementById("root")!);
  t.after(async () => {
    try { await React.act(async () => root.unmount()); }
    finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
  const flush = async () => {
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  return {
    React, root, window: window as unknown as Window, document, pending, flush,
    render: async (node: import("react").ReactNode) => { await React.act(async () => root.render(node)); },
    respond: async (index: number, body: unknown, status = 200) => {
      await React.act(async () => pending[index].resolve(Response.json(body, { status })));
      await flush();
    }
  };
}
