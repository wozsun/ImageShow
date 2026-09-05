import "pixi.js/unsafe-eval";
import { AccessibilitySystem, Application, extensions, loadEnvironmentExtensions, type Ticker } from "pixi.js";
import type { ShowOrder } from "@imageshow/shared/browser";
import type { ShowImage } from "../show-layout.js";
import { ShowPixiFloatScene } from "./show-pixi-float-scene.js";
import { ShowPixiTextureCache } from "./show-pixi-texture-cache.js";
import type {
  ShowPixiRuntimeSnapshot,
  ShowPixiSceneController,
  ShowPixiSceneKind,
  ShowPixiVisibleItem
} from "./show-pixi-types.js";
import { emptyShowPixiSceneStats } from "./show-pixi-types.js";
import { ShowPixiWaterfallScene } from "./show-pixi-waterfall-scene.js";

type ShowPixiRuntimeOptions = {
  scene: ShowPixiSceneKind;
  images: readonly ShowImage[];
  dataKey: string;
  order: ShowOrder;
  waterfallColumns: number;
  floatSizeIndex: number;
  running: boolean;
  reducedMotion: boolean;
  speed: number;
  statsElement: HTMLOutputElement | null;
  onColumnsChange: (columns: number) => number;
  onFloatSizeIndexChange: (index: number) => number;
  onManualVerticalMovement: (delta: number, pointerType?: string) => void;
  onMotionActiveChange: (active: boolean) => void;
  onNeedImages: () => void;
  onOpen: (image: ShowImage, key: string) => void;
  onVisibleItems: (items: readonly ShowPixiVisibleItem[]) => void;
};

export type ShowPixiDebugApi = {
  snapshot: () => ShowPixiRuntimeSnapshot;
  loseContext: () => boolean;
  restoreContext: () => boolean;
  resetMetrics: () => void;
  setFloatSizeIndex: (index: number) => void;
  setScene: (scene: ShowPixiSceneKind) => void;
  setWaterfallColumns: (columns: number) => void;
};

type ShowPixiCleanupSnapshot = {
  activePointers: number;
  canvasConnected: boolean;
  inputListenerCount: number;
  runtimeTickerRemoved: boolean;
  sceneActive: boolean;
  textureEntries: number;
  tickerStarted: boolean;
};

declare global {
  interface Window {
    __imageShowPixiDiagnostics?: boolean;
    __imageShowPixiDebug?: ShowPixiDebugApi;
    __imageShowPixiLastCleanup?: ShowPixiCleanupSnapshot;
  }
}

const frameSampleCapacity = 36_000;

export class ShowPixiRuntime {
  readonly app: Application;
  readonly #host: HTMLElement;
  readonly #textureCache: ShowPixiTextureCache;
  readonly #resizeObserver: ResizeObserver;
  readonly #motionQuery: MediaQueryList;
  readonly #options: Omit<ShowPixiRuntimeOptions, "statsElement">;
  readonly #tick: (ticker: Ticker) => void;
  readonly #onVisibilityChange: () => void;
  readonly #onOnline: () => void;
  readonly #onImageLoad: (event: Event) => void;
  readonly #onPointerPresence: (event: PointerEvent) => void;
  readonly #onPointerLeave: () => void;
  readonly #onMotionChange: () => void;
  readonly #onContextLost: (event: Event) => void;
  readonly #onContextRestored: () => void;
  readonly #longTaskObserver: PerformanceObserver | null;
  readonly #debugApi: ShowPixiDebugApi;
  #scene: ShowPixiSceneController | null = null;
  #sceneKind: ShowPixiSceneKind;
  #images: readonly ShowImage[];
  #dataKey: string;
  #order: ShowOrder;
  #waterfallColumns: number;
  #floatSizeIndex: number;
  #running: boolean;
  #motionActive = false;
  #reducedMotion: boolean;
  #dialogOpen = false;
  #pointerInside = false;
  #hidden = document.hidden;
  #contextLost = false;
  #contextLosses = 0;
  #contextRestores = 0;
  #contextLossExtension: WEBGL_lose_context | null = null;
  #speed: number;
  #destroyed = false;
  #debugExposed = false;
  #statsElement: HTMLOutputElement | null;
  #lastStatsAt = 0;
  #frameSamples: number[] = [];
  #frameCursor = 0;
  #frames = 0;
  #frameTotal = 0;
  #longFrames = 0;
  #longTasks = 0;
  #longTaskMs = 0;

  static async create(host: HTMLElement, options: ShowPixiRuntimeOptions) {
    await loadEnvironmentExtensions(false);
    // The bounded React proxy list owns keyboard and screen-reader access.
    // Remove Pixi's separate mobile activation button before systems initialize.
    extensions.remove(AccessibilitySystem);
    const app = new Application();
    const width = Math.max(1, host.clientWidth || window.innerWidth);
    const height = Math.max(1, host.clientHeight || window.innerHeight);
    await app.init({
      width,
      height,
      autoStart: true,
      sharedTicker: false,
      preference: "webgl",
      preferWebGLVersion: 2,
      powerPreference: "high-performance",
      antialias: true,
      autoDensity: true,
      backgroundAlpha: 0,
      resolution: Math.min(1.5, Math.max(1, window.devicePixelRatio || 1))
    });
    return new ShowPixiRuntime(host, app, options);
  }

  private constructor(
    host: HTMLElement,
    app: Application,
    options: ShowPixiRuntimeOptions
  ) {
    this.#host = host;
    this.app = app;
    this.#options = options;
    this.#sceneKind = options.scene;
    this.#images = options.images;
    this.#dataKey = options.dataKey;
    this.#order = options.order;
    this.#waterfallColumns = options.waterfallColumns;
    this.#floatSizeIndex = options.floatSizeIndex;
    this.#running = options.running;
    this.#reducedMotion = options.reducedMotion;
    this.#speed = options.speed;
    this.#statsElement = options.statsElement;
    const initialWidth = host.clientWidth || window.innerWidth;
    const compact = initialWidth <= 760;
    const renderer = app.renderer as typeof app.renderer & {
      gl?: WebGLRenderingContext | WebGL2RenderingContext;
    };
    this.#textureCache = new ShowPixiTextureCache({
      maximumEntries: compact ? 720 : 1_800,
      maximumPixels: compact ? 24_000_000 : 52_000_000,
      maximumInFlight: compact ? 8 : 12,
      maximumUnreferenced: compact ? 48 : 96,
      generateMipmaps: typeof WebGL2RenderingContext !== "undefined"
        && renderer.gl instanceof WebGL2RenderingContext
    });
    app.canvas.className = "show-pixi-canvas";
    app.canvas.dataset.showPixiCanvas = "";
    app.canvas.setAttribute("aria-hidden", "true");
    host.appendChild(app.canvas);
    this.#onPointerPresence = (event) => {
      if (
        !event.isTrusted || event.target !== app.canvas
        || this.#dialogOpen || this.#hidden || this.#contextLost
      ) return;
      // A second touch may land on another card. Cancel the whole stage's
      // click intents before Pixi dispatches it; the camera owns pinch state.
      if (event.type === "pointerdown" && !event.isPrimary) this.#scene?.clearPointerHover();
      const bounds = app.canvas.getBoundingClientRect();
      this.#setPointerInside(
        event.clientX >= bounds.left && event.clientX < bounds.right
        && event.clientY >= bounds.top && event.clientY < bounds.bottom
      );
    };
    this.#onPointerLeave = () => this.#setPointerInside(false);
    // Listen above the canvas so a real pointer can enable hit testing before
    // Pixi handles a down/over event. Its synthetic document moves never pass
    // through this host and cannot reactivate the last pointer position.
    for (const type of ["pointerover", "pointermove", "pointerdown"] as const) {
      host.addEventListener(type, this.#onPointerPresence, { capture: true, passive: true });
    }
    app.canvas.addEventListener("pointerleave", this.#onPointerLeave);
    app.canvas.addEventListener("pointercancel", this.#onPointerLeave);
    window.addEventListener("blur", this.#onPointerLeave);
    this.#onOnline = () => this.#textureCache.resumeTransportRequests();
    window.addEventListener("online", this.#onOnline);
    this.#onImageLoad = (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || image.naturalWidth === 0) return;
      this.#textureCache.retryFailedUrl(image.currentSrc || image.src);
    };
    // DOM detail images and WebGL textures have separate loaders. Their native
    // success event can release a matching failed URL without resetting cards.
    document.addEventListener("load", this.#onImageLoad, true);
    this.#tick = (ticker) => {
      const frameMs = Math.max(0, ticker.elapsedMS);
      this.#scene?.update(frameMs);
      if (this.#statsElement) {
        this.#recordFrame(frameMs);
        const now = performance.now();
        if (now - this.#lastStatsAt >= 250) {
          this.#lastStatsAt = now;
          this.#publishStats();
        }
      }
    };
    app.ticker.add(this.#tick);
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(host);
    this.#motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.#onMotionChange = () => {
      this.#reducedMotion = this.#motionQuery.matches;
      this.#applyMotionState();
    };
    this.#motionQuery.addEventListener("change", this.#onMotionChange);
    this.#onVisibilityChange = () => {
      this.#hidden = document.hidden;
      if (this.#hidden) this.#setPointerInside(false);
      this.#applyMotionState();
      if (this.#hidden) app.stop();
      else if (!this.#contextLost) app.start();
    };
    document.addEventListener("visibilitychange", this.#onVisibilityChange);
    this.#onContextLost = (event) => {
      event.preventDefault();
      this.#contextLost = true;
      this.#setPointerInside(false);
      this.#contextLosses += 1;
      this.#applyMotionState();
      app.stop();
      this.#publishStats();
    };
    this.#onContextRestored = () => {
      this.#contextLost = false;
      this.#contextRestores += 1;
      this.#applyMotionState();
      if (!this.#hidden) app.start();
      this.#publishStats();
    };
    app.canvas.addEventListener("webglcontextlost", this.#onContextLost);
    app.canvas.addEventListener("webglcontextrestored", this.#onContextRestored);
    this.#longTaskObserver = this.#createLongTaskObserver();
    this.#createScene(options.scene);
    this.#applyMotionState();
    this.#resize();
    // A route can be mounted while its document is already backgrounded. In
    // that case no visibilitychange edge is guaranteed after initialization.
    if (this.#hidden) app.stop();
    this.#debugApi = {
      snapshot: () => this.snapshot(),
      loseContext: () => this.#invokeContextExtension("loseContext"),
      restoreContext: () => this.#invokeContextExtension("restoreContext"),
      resetMetrics: () => this.#resetMetrics(),
      setFloatSizeIndex: (index) => this.setFloatSizeIndex(index),
      setScene: (kind) => this.setScene(kind),
      setWaterfallColumns: (columns) => this.setWaterfallColumns(columns)
    };
  }

  exposeDebug() {
    if (this.#destroyed) return;
    this.#debugExposed = true;
    delete window.__imageShowPixiLastCleanup;
    window.__imageShowPixiDebug = this.#debugApi;
  }

  setScene(kind: ShowPixiSceneKind) {
    if (kind === this.#sceneKind && this.#scene) return;
    this.#scene?.destroy();
    this.#scene = null;
    this.#sceneKind = kind;
    this.#createScene(kind);
    this.#applyMotionState();
    this.#publishStats();
  }

  setImages(images: readonly ShowImage[], dataKey: string, order: ShowOrder) {
    this.#images = images;
    this.#dataKey = dataKey;
    this.#order = order;
    this.#scene?.setImages(images, dataKey, order);
  }

  setWaterfallColumns(columns: number) {
    this.#waterfallColumns = columns;
    if (this.#scene instanceof ShowPixiWaterfallScene) {
      this.#scene.setColumns(columns);
    }
  }

  setFloatSizeIndex(index: number) {
    this.#floatSizeIndex = index;
    if (this.#scene instanceof ShowPixiFloatScene) this.#scene.setSizeIndex(index);
  }

  setSpeed(speed: number) {
    this.#speed = speed;
    if (this.#scene instanceof ShowPixiWaterfallScene) this.#scene.setSpeed(speed);
    if (this.#scene instanceof ShowPixiFloatScene) this.#scene.setSpeed(speed);
  }

  setRunning(running: boolean) {
    if (running && !this.#running) this.#textureCache.resumeTransportRequests();
    this.#running = running;
    this.#applyMotionState();
  }

  setDialogOpen(open: boolean) {
    this.#dialogOpen = open;
    // Reopening hit testing must wait for a fresh canvas pointer event, rather
    // than reusing the coordinates captured before the modal covered it.
    if (open) this.#pointerInside = false;
    this.#applyMotionState();
  }

  focusCard(key: string | null) {
    this.#scene?.focusCard(key);
  }

  snapshot(): ShowPixiRuntimeSnapshot {
    const samples = [...this.#frameSamples].sort((left, right) => left - right);
    const p95 = samples.length
      ? samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]
      : 0;
    return {
      ...(this.#scene?.stats() ?? emptyShowPixiSceneStats()),
      renderer: this.app.renderer.constructor.name,
      scene: this.#sceneKind,
      running: this.#running,
      motionActive: this.#motionActive,
      reducedMotion: this.#reducedMotion,
      hidden: this.#hidden,
      dialogOpen: this.#dialogOpen,
      contextLost: this.#contextLost,
      contextLosses: this.#contextLosses,
      contextRestores: this.#contextRestores,
      frames: this.#frames,
      averageFrameMs: this.#frames ? this.#frameTotal / this.#frames : 0,
      p95FrameMs: p95,
      longFrames: this.#longFrames,
      longTasks: this.#longTasks,
      longTaskMs: this.#longTaskMs,
      tickerListeners: this.app.ticker.count,
      textures: this.#textureCache.stats()
    };
  }

  destroy() {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#applyMotionState();
    const publishCleanup = this.#debugExposed
      && window.__imageShowPixiDebug === this.#debugApi;
    if (publishCleanup) {
      delete window.__imageShowPixiDebug;
    }
    this.#longTaskObserver?.disconnect();
    this.#resizeObserver.disconnect();
    this.#motionQuery.removeEventListener("change", this.#onMotionChange);
    document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    for (const type of ["pointerover", "pointermove", "pointerdown"] as const) {
      this.#host.removeEventListener(type, this.#onPointerPresence, true);
    }
    this.app.canvas.removeEventListener("pointerleave", this.#onPointerLeave);
    this.app.canvas.removeEventListener("pointercancel", this.#onPointerLeave);
    window.removeEventListener("blur", this.#onPointerLeave);
    window.removeEventListener("online", this.#onOnline);
    document.removeEventListener("load", this.#onImageLoad, true);
    this.app.canvas.removeEventListener("webglcontextlost", this.#onContextLost);
    this.app.canvas.removeEventListener("webglcontextrestored", this.#onContextRestored);
    const tickerListenersBeforeRemoval = this.app.ticker.count;
    this.app.ticker.remove(this.#tick);
    const runtimeTickerRemoved = this.app.ticker.count < tickerListenersBeforeRemoval;
    this.app.stop();
    const tickerStarted = this.app.ticker.started;
    const destroyedScene = this.#scene;
    destroyedScene?.destroy();
    const destroyedSceneStats = destroyedScene?.stats();
    this.#scene = null;
    this.#textureCache.destroy();
    this.#statsElement = null;
    const canvas = this.app.canvas;
    this.app.destroy(
      { removeView: true },
      { children: true, texture: false, textureSource: false }
    );
    if (publishCleanup) {
      window.__imageShowPixiLastCleanup = {
        activePointers: destroyedSceneStats?.activePointers ?? 0,
        canvasConnected: canvas.isConnected,
        inputListenerCount: destroyedSceneStats?.inputListenerCount ?? 0,
        runtimeTickerRemoved,
        sceneActive: this.#scene !== null,
        textureEntries: this.#textureCache.stats().entries,
        tickerStarted
      };
    }
  }

  #createScene(kind: ShowPixiSceneKind) {
    const common = {
      images: this.#images,
      dataKey: this.#dataKey,
      order: this.#order,
      width: Math.max(1, this.#host.clientWidth),
      height: Math.max(1, this.#host.clientHeight),
      renderer: this.app.renderer,
      running: this.#running,
      reducedMotion: this.#reducedMotion,
      speed: this.#speed,
      textureCache: this.#textureCache,
      onNeedImages: this.#options.onNeedImages,
      onOpen: this.#options.onOpen,
      onVisibleItems: this.#options.onVisibleItems
    };
    this.#scene = kind === "waterfall"
      ? new ShowPixiWaterfallScene({
        ...common,
        columns: this.#waterfallColumns,
        inputElement: this.app.canvas,
        onColumnsChange: this.#options.onColumnsChange,
        onManualVerticalMovement: this.#options.onManualVerticalMovement
      })
      : new ShowPixiFloatScene({
        ...common,
        inputElement: this.app.canvas,
        onManualVerticalMovement: this.#options.onManualVerticalMovement,
        onSizeIndexChange: this.#options.onFloatSizeIndexChange,
        sizeIndex: this.#floatSizeIndex
      });
    this.app.stage.addChild(this.#scene.root);
  }

  #applyMotionState() {
    const inputEnabled = !this.#destroyed && !this.#dialogOpen
      && !this.#hidden && !this.#contextLost;
    const running = this.#running && inputEnabled;
    this.#scene?.setInputEnabled(inputEnabled);
    this.#scene?.setMotion(running, this.#reducedMotion);
    const motionActive = Boolean(this.#scene) && running && !this.#reducedMotion;
    if (motionActive !== this.#motionActive) {
      this.#motionActive = motionActive;
      this.#options.onMotionActiveChange(motionActive);
    }
    this.#applyPointerState();
  }

  #setPointerInside(inside: boolean) {
    if (inside === this.#pointerInside) return;
    this.#pointerInside = inside;
    this.#applyPointerState();
  }

  #applyPointerState() {
    const enabled = this.#pointerInside && !this.#destroyed
      && !this.#dialogOpen && !this.#hidden && !this.#contextLost;
    this.app.stage.eventMode = enabled ? "passive" : "none";
    if (!enabled) {
      this.#scene?.clearPointerHover();
      this.app.renderer.events.setCursor("default");
    }
  }

  #resize() {
    if (this.#destroyed) return;
    const width = Math.max(1, this.#host.clientWidth || window.innerWidth);
    const height = Math.max(1, this.#host.clientHeight || window.innerHeight);
    this.app.renderer.resize(width, height);
    this.#scene?.resize(width, height);
  }

  #recordFrame(frameMs: number) {
    this.#frames += 1;
    this.#frameTotal += frameMs;
    if (frameMs > 50) this.#longFrames += 1;
    if (this.#frameSamples.length < frameSampleCapacity) {
      this.#frameSamples.push(frameMs);
      return;
    }
    this.#frameSamples[this.#frameCursor] = frameMs;
    this.#frameCursor = (this.#frameCursor + 1) % frameSampleCapacity;
  }

  #publishStats() {
    const element = this.#statsElement;
    if (!element) return;
    const snapshot = this.snapshot();
    element.dataset.scene = snapshot.scene;
    element.dataset.renderer = snapshot.renderer;
    element.dataset.activeSprites = String(snapshot.activeSprites);
    element.dataset.visibleSprites = String(snapshot.visibleSprites);
    element.dataset.retainedDtos = String(snapshot.retainedDtos);
    element.dataset.textures = String(snapshot.textures.entries);
    element.dataset.readyTextures = String(snapshot.textures.ready);
    element.dataset.pending = String(snapshot.textures.queued);
    element.dataset.inFlight = String(snapshot.textures.inFlight);
    element.dataset.texturePixels = String(snapshot.textures.reservedPixels);
    element.dataset.averageFrameMs = snapshot.averageFrameMs.toFixed(3);
    element.dataset.p95FrameMs = snapshot.p95FrameMs.toFixed(3);
    element.dataset.longFrames = String(snapshot.longFrames);
    element.dataset.longTasks = String(snapshot.longTasks);
    element.dataset.recycledSprites = String(snapshot.recycledSprites);
    element.dataset.overlapRatio = snapshot.overlapRatio.toFixed(4);
    element.dataset.coverageRatio = snapshot.coverageRatio.toFixed(4);
    element.dataset.horizontalConcentration = snapshot.horizontalConcentration.toFixed(4);
    element.dataset.inputEnabled = String(snapshot.inputEnabled);
    element.dataset.inputListenerCount = String(snapshot.inputListenerCount);
    element.dataset.activePointers = String(snapshot.activePointers);
    element.dataset.contextLost = String(snapshot.contextLost);
    element.dataset.contextLosses = String(snapshot.contextLosses);
    element.dataset.contextRestores = String(snapshot.contextRestores);
    element.dataset.motionActive = String(snapshot.motionActive);
    element.dataset.waterfallColumns = String(snapshot.waterfallColumns ?? "");
    element.dataset.waterfallCameraX = String(snapshot.waterfallCameraX ?? "");
    element.dataset.waterfallCameraY = String(snapshot.waterfallCameraY ?? "");
    element.dataset.waterfallScale = String(snapshot.waterfallScale ?? "");
    element.dataset.floatSizeIndex = String(snapshot.floatSizeIndex ?? "");
    element.dataset.floatMeanY = String(snapshot.floatMeanY ?? "");
  }

  #createLongTaskObserver() {
    if (
      !this.#statsElement
      || typeof PerformanceObserver === "undefined"
      || !PerformanceObserver.supportedEntryTypes.includes("longtask")
    ) return null;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        this.#longTasks += 1;
        this.#longTaskMs += entry.duration;
      }
    });
    observer.observe({ entryTypes: ["longtask"] });
    return observer;
  }

  #contextExtension() {
    if (this.#contextLossExtension) return this.#contextLossExtension;
    const renderer = this.app.renderer as typeof this.app.renderer & {
      gl?: WebGLRenderingContext | WebGL2RenderingContext;
    };
    this.#contextLossExtension = renderer.gl?.getExtension("WEBGL_lose_context") ?? null;
    return this.#contextLossExtension;
  }

  #invokeContextExtension(method: "loseContext" | "restoreContext") {
    const extension = this.#contextExtension();
    if (!extension) return false;
    extension[method]();
    return true;
  }

  #resetMetrics() {
    this.#frameSamples = [];
    this.#frameCursor = 0;
    this.#frames = 0;
    this.#frameTotal = 0;
    this.#longFrames = 0;
    this.#longTasks = 0;
    this.#longTaskMs = 0;
    this.#publishStats();
  }
}
