import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  Container,
  Point,
  Texture,
  type FederatedPointerEvent,
  type Rectangle,
  type Renderer
} from "pixi.js";
import {
  emptyGalleryFilters
} from "../../../packages/web/src/lib/gallery/gallery-query.ts";
import {
  showCardGeometry,
  showCardRect,
  showRectsIntersect,
  showViewportWindow,
  type ShowResidencePolicy
} from "../../../packages/web/src/pages/show/show-layout.ts";
import {
  ShowDataPool
} from "../../../packages/web/src/pages/show/show-data-pool.ts";
import {
  ShowWindowController
} from "../../../packages/web/src/pages/show/show-window-controller.ts";
import {
  clampShowFloatSizeIndex,
  clampShowWaterfallColumns,
  defaultShowFloatSizeIndex,
  largerShowWaterfallImages,
  showFloatSizeSteps,
  showFloatDefaultWidth,
  showWaterfallDensity,
  smallerShowWaterfallImages
} from "../../../packages/web/src/pages/show/pixi/show-pixi-layout.ts";
import {
  ShowPixiCamera
} from "../../../packages/web/src/pages/show/pixi/show-pixi-camera.ts";
import {
  ShowPixiWaterfallScene
} from "../../../packages/web/src/pages/show/pixi/show-pixi-waterfall-scene.ts";
import {
  ShowPixiRuntime,
  showPixiTextureCacheOptions
} from "../../../packages/web/src/pages/show/pixi/show-pixi-runtime.ts";
import type {
  ShowPixiTextureCache
} from "../../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts";
import type {
  ShowPixiVisibleItem
} from "../../../packages/web/src/pages/show/pixi/show-pixi-types.ts";
import {
  createPublicNavigationHarness,
  showImages,
  createCameraTestElement,
  installPixiPaletteFixture,
  createFloatSceneHarness,
  floatCardPositions,
  createTextureRecoveryHarness,
  editableImage,
  createConfigStreamHarness
} from "../support/web-test-context.ts";
import {
  installProperties
} from "../support/property-descriptors.ts";
import { imageMatchesFilters, shuffledImageBatch } from "../../../packages/web/src/lib/gallery/image-browse.ts";
import { imageBatchTier } from "../../../packages/web/src/lib/gallery/image-browse.ts";
import { showInitialBatchLimit } from "../../../packages/web/src/pages/show/show-browse.ts";

function pixiPointerEvent(
  x: number,
  y: number,
  overrides: Partial<Pick<
    FederatedPointerEvent,
    "button" | "isPrimary" | "pointerId" | "pointerType"
  >> = {}
): FederatedPointerEvent {
  return {
    global: new Point(x, y),
    button: 0,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
    ...overrides
  } as unknown as FederatedPointerEvent;
}

test("[Web/展映] Pixi waterfall 的按钮步长和密度边界严格限制为 0.5G 至 8G", () => {
  const desktop = showWaterfallDensity(1440);
  assert.deepEqual(desktop, {
    galleryColumns: 4,
    minimumColumns: 2,
    defaultColumns: 4,
    normalMaximumColumns: 6,
    warningColumns: 12,
    maximumColumns: 32
  });
  assert.equal(smallerShowWaterfallImages(4, desktop), 5);
  assert.equal(smallerShowWaterfallImages(31, desktop), 32);
  assert.equal(smallerShowWaterfallImages(32, desktop), 32);
  assert.equal(largerShowWaterfallImages(4, desktop), 3);
  assert.equal(largerShowWaterfallImages(2, desktop), 2);
  assert.equal(clampShowWaterfallColumns(-100, desktop), 2);
  assert.equal(clampShowWaterfallColumns(100, desktop), 32);

  const compact = showWaterfallDensity(1080);
  assert.equal(compact.galleryColumns, 3);
  assert.equal(compact.minimumColumns, 1.5);
  assert.equal(compact.normalMaximumColumns, 4.5);
  assert.equal(compact.warningColumns, 9);
  assert.equal(compact.maximumColumns, 24);
});
test("[Web/展映] waterfall 在窄屏与宽屏高密度视口执行各自 Sprite 驻留上限", async (t) => {
  for (const { width, maximum } of [
    { width: 760, maximum: 960 },
    { width: 761, maximum: 2_800 }
  ]) {
    await t.test(`${width}px`, (t) => {
      installPixiPaletteFixture(t);
      t.after(installProperties(globalThis, { devicePixelRatio: 1 }));
      const target = createCameraTestElement(width, 5_000);
      const scene = new ShowPixiWaterfallScene({ hasMore: false,
        width,
        height: 5_000,
        columns: showWaterfallDensity(width).maximumColumns,
        images: showImages(800),
        dataKey: `sprite-cap-${width}`,
        order: "latest",
        running: false,
        reducedMotion: false,
        speed: 28,
        inputElement: target.element,
        textureCache: {
          acquire: () => ({ release() {} })
        } as unknown as ShowPixiTextureCache,
        renderer: {} as Renderer,
        onNeedImages() {},
        onOpen() {},
        onVisibleItems() {},
        onColumnsChange: (columns) => columns,
        onManualVerticalMovement() {}
      });
      t.after(() => {
        scene.destroy();
        assert.equal(target.listenerCount(), 0);
      });
      const stats = scene.stats();
      assert.equal(stats.activeSprites, maximum);
      assert.ok(stats.rejectedSprites > 0, "测试视口必须实际越过驻留上限");
    });
  }
});
test("[Web/展映] Pixi 纹理策略在窄屏与宽屏执行 12 / 16 个真实请求并发", async (t) => {
  for (const { width, maximumInFlight } of [
    { width: 760, maximumInFlight: 12 },
    { width: 761, maximumInFlight: 16 }
  ]) {
    await t.test(`${width}px`, async (t) => {
      const { ShowPixiTextureCache } = await import(
        "../../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts"
      );
      let requests = 0;
      const requestSignals: AbortSignal[] = [];
      const restoreGlobals = installProperties(globalThis, {
        fetch: (_input: RequestInfo | URL, init?: RequestInit) => {
          requests += 1;
          return new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) {
              reject(new Error("纹理请求必须可取消"));
              return;
            }
            if (signal.aborted) {
              reject(signal.reason);
              return;
            }
            requestSignals.push(signal);
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true
            });
          });
        }
      });
      let cache: InstanceType<typeof ShowPixiTextureCache> | undefined;
      const leases: Array<{ release: () => void }> = [];
      t.after(async () => {
        const errors: unknown[] = [];
        for (const lease of leases) {
          try {
            lease.release();
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          cache?.destroy();
        } catch (error) {
          errors.push(error);
        }
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.ok(
            requestSignals.every((signal) => signal.aborted),
            "销毁缓存必须取消全部活动纹理请求"
          );
        } catch (error) {
          errors.push(error);
        }
        try {
          restoreGlobals();
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, "纹理并发用例资源未能全部清理");
        }
      });
      cache = new ShowPixiTextureCache(
        showPixiTextureCacheOptions(width, false)
      );
      for (let index = 0; index < 32; index += 1) {
        leases.push(cache.acquire(
          `https://images.example/${index}.webp`,
          { pixelWidth: 128, pixelHeight: 128 },
          () => undefined
        ));
      }
      const textures = cache.stats();
      assert.equal(textures.inFlight, maximumInFlight);
      assert.equal(requests, maximumInFlight);
      assert.equal(textures.queued, 32 - maximumInFlight);
    });
  }
});
test("[Web/展映] Pixi float 只暴露有界图片尺寸档位", () => {
  assert.deepEqual([...showFloatSizeSteps], [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5]);
  assert.equal(defaultShowFloatSizeIndex, 5);
  assert.equal(clampShowFloatSizeIndex(-100), 0);
  assert.equal(clampShowFloatSizeIndex(100), 10);
  assert.equal(clampShowFloatSizeIndex(2.6), 3);
});
test("[Web/展映] 模式切换提示和状态播报使用瀑布与漂浮显示名", async (t) => {
  const React = await import("react");
  t.after(installProperties(globalThis, { React }));
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { MemoryRouter } = await import("react-router");
  const { ShowControls } = await import(
    "../../../packages/web/src/pages/show/ShowControls.tsx"
  );
  const render = (scene: "waterfall" | "float") => renderToStaticMarkup(
    React.createElement(
      MemoryRouter,
      null,
      React.createElement(ShowControls, {
        decreaseButtonRef: { current: null },
        largerDisabled: false,
        onDecreaseSize() {},
        onIncreaseSize() {},
        onOrderChange() {},
        onReset() {},
        onRunningChange() {},
        getSceneHref: (nextScene) => `/show?mode=${nextScene}`,
        order: "random",
        reducedMotion: false,
        running: true,
        scene,
        sizeDescription: "当前约 4 列",
        smallerDisabled: false
      })
    )
  );

  const assertModeLabels = (
    scene: "waterfall" | "float",
    currentLabel: string,
    nextLabel: string
  ) => {
    const { document } = parseHTML(`<html><body>${render(scene)}</body></html>`);
    const sceneControl = document.querySelector(".show-scene-control");
    const expectedControlLabel = `当前模式：${currentLabel}；点击切换为${nextLabel}`;
    assert.equal(sceneControl?.getAttribute("aria-label"), expectedControlLabel);
    assert.equal(sceneControl?.getAttribute("title"), expectedControlLabel);
    const liveRegion = document.querySelector('.sr-only[aria-live="polite"]');
    assert.equal(
      liveRegion?.textContent?.replaceAll(/\s/gu, ""),
      `当前排列顺序：乱序；当前模式：${currentLabel}`
    );
  };

  assertModeLabels("waterfall", "瀑布", "漂浮");
  assertModeLabels("float", "漂浮", "瀑布");
});
test("[Web/展映] Show Pixi 窄相机保持中心缩放、坐标换算与 resize 不漂移", () => {
  const target = createCameraTestElement();
  const camera = new ShowPixiCamera({
    element: target.element,
    width: 800,
    height: 600,
    initialScale: 1,
    minimumScale: 0.5,
    maximumScale: 2
  });
  camera.moveCorner(100, 50);
  assert.deepEqual(camera.getVisibleBounds(), {
    x: 100,
    y: 50,
    width: 800,
    height: 600
  });
  const center = camera.center;
  camera.setZoom(2);
  assert.ok(Math.abs(camera.center.x - center.x) < 0.0001);
  assert.ok(Math.abs(camera.center.y - center.y) < 0.0001);
  assert.deepEqual(camera.getVisibleBounds(), {
    x: 300,
    y: 200,
    width: 400,
    height: 300
  });
  camera.resize(1_000, 700);
  assert.ok(Math.abs(camera.center.x - center.x) < 0.0001);
  assert.ok(Math.abs(camera.center.y - center.y) < 0.0001);
  const world = { x: 420, y: 260 };
  const roundTrip = camera.screenToWorld(camera.worldToScreen(world));
  assert.ok(Math.abs(roundTrip.x - world.x) < 0.0001);
  assert.ok(Math.abs(roundTrip.y - world.y) < 0.0001);
  camera.destroy();
});
test("[Web/展映] Show Pixi 窄相机覆盖 drag、惯性、输入禁用与事件清理", () => {
  const target = createCameraTestElement();
  const movements: number[] = [];
  const camera = new ShowPixiCamera({
    element: target.element,
    width: 800,
    height: 600,
    initialScale: 1,
    minimumScale: 0.5,
    maximumScale: 2,
    onManualVerticalMovement: (delta) => movements.push(delta)
  });
  assert.equal(camera.listenerCount, 7);
  assert.equal(target.listenerCount(), 7);
  target.emit("pointerdown", {
    clientX: 100,
    clientY: 100,
    pointerId: 7,
    timeStamp: 10
  });
  target.emit("pointermove", {
    clientX: 180,
    clientY: 132,
    pointerId: 7,
    timeStamp: 26
  });
  assert.equal(camera.activePointers, 1);
  assert.equal(camera.left, -80);
  assert.equal(camera.top, -32);
  target.emit("pointerup", { pointerId: 7, timeStamp: 30 });
  const beforeInertia = camera.left;
  camera.update(16);
  assert.ok(camera.left < beforeInertia);
  assert.ok(movements.length >= 2);
  assert.ok(movements.every((delta) => delta < 0));
  camera.setInputEnabled(false);
  assert.equal(camera.activePointers, 0);
  assert.equal(camera.moving, false);
  const disabledLeft = camera.left;
  target.emit("pointerdown", { clientX: 10, clientY: 10, pointerId: 8 });
  target.emit("pointermove", { clientX: 80, clientY: 80, pointerId: 8 });
  assert.equal(camera.left, disabledLeft);
  camera.destroy();
  assert.equal(camera.listenerCount, 0);
  assert.equal(target.listenerCount(), 0);
});
test("[Web/展映] waterfall 导航位移保留拖动和惯性的指针类型，滚轮独立上报", async (t) => {
  for (const pointerType of ["mouse", "touch"]) {
    await t.test(pointerType, (t) => {
      const target = createCameraTestElement();
      const pointerTypes: Array<string | undefined> = [];
      const camera = new ShowPixiCamera({
        element: target.element, width: 800, height: 600,
        initialScale: 1, minimumScale: 0.5, maximumScale: 2,
        onManualVerticalMovement: (_delta, type) => pointerTypes.push(type)
      });
      t.after(() => camera.destroy());
      target.emit("pointerdown", { clientY: 100, timeStamp: 0, pointerType });
      target.emit("pointermove", { clientY: 180, timeStamp: 16, pointerType });
      assert.deepEqual(pointerTypes, [pointerType]);
      target.emit("pointerup", { timeStamp: 20, pointerType });
      camera.update(16);
      assert.deepEqual(pointerTypes, [pointerType, pointerType], "松手后的惯性沿用输入类型");
      pointerTypes.length = 0;
      target.emit("wheel", { deltaY: -120 });
      camera.update(16);
      assert.ok(pointerTypes.length > 0);
      assert.ok(pointerTypes.every((type) => type === undefined), "后续滚轮不继承鼠标拖动限制");
    });
  }
});
test("[Web/展映] 相机在应用滚轮或双指缩放前取得允许的尺寸，程序化调整不再次请求", (t) => {
  const target = createCameraTestElement();
  const requests: Array<{ requested: number; before: number }> = [];
  const movements: number[] = [];
  const camera = new ShowPixiCamera({
    element: target.element, width: 800, height: 600,
    initialScale: 1, minimumScale: 0.1, maximumScale: 2,
    onManualVerticalMovement: (delta) => movements.push(delta),
    onZoomRequest: (requested) => {
      requests.push({ requested, before: camera.scale });
      return Math.max(0.5, requested);
    }
  });
  t.after(() => camera.destroy());
  target.emit("wheel", { ctrlKey: true, deltaY: 720, clientX: 400, clientY: 300 });
  assert.ok(requests[0].requested < 0.5);
  assert.equal(requests[0].before, 1);
  assert.equal(camera.scale, 0.5, "未应用请求中尚未允许的缩放");
  camera.setZoom(1);
  assert.equal(requests.length, 1);
  target.emit("pointerdown", { pointerId: 1, pointerType: "touch", clientX: 100, clientY: 200 });
  target.emit("pointerdown", { pointerId: 2, pointerType: "touch", clientX: 300, clientY: 200 });
  target.emit("pointermove", { pointerId: 2, pointerType: "touch", clientX: 150, clientY: 200, timeStamp: 16 });
  assert.equal(requests[1].requested, 0.25);
  assert.equal(requests[1].before, 1);
  assert.equal(camera.scale, 0.5);
  camera.setZoom(0.2);
  assert.equal(camera.scale, 0.2, "确认后的程序化调整不再请求");
  assert.equal(requests.length, 2);
  assert.deepEqual(movements, [], "提示和缩放不产生导航位移");
});
test("[Web/展映] waterfall 超过 3G 前停在边界，允许后继续缩放，窄屏和宽屏同源", async (t) => {
  for (const width of [760, 761, 1440]) {
    await t.test(`${width}px`, (t) => {
      const density = showWaterfallDensity(width);
      const target = createCameraTestElement(width, 600);
      const requests: number[] = [];
      let confirmed = false;
      const scene = new ShowPixiWaterfallScene({ hasMore: false,
        width, height: 600, columns: density.warningColumns - 1,
        images: [], dataKey: "density-warning", order: "latest",
        running: false, reducedMotion: false, speed: 28,
        inputElement: target.element,
        textureCache: {} as ShowPixiTextureCache,
        renderer: {} as Renderer,
        onNeedImages: () => undefined,
        onOpen: () => undefined,
        onVisibleItems: () => undefined,
        onManualVerticalMovement: () => undefined,
        onColumnsChange: (columns) => {
          requests.push(columns);
          return confirmed ? columns : Math.min(columns, density.warningColumns);
        }
      });
      t.after(() => scene.destroy());
      target.emit("wheel", { ctrlKey: true, deltaY: 720, clientX: width / 2, clientY: 300 });
      assert.ok(requests[0] > density.warningColumns);
      assert.equal(scene.stats().waterfallColumns, density.warningColumns);
      const boundaryScale = scene.stats().waterfallScale!;
      for (let frame = 0; frame < 6; frame += 1) scene.update(48);
      assert.ok(Math.abs(scene.stats().waterfallScale! - boundaryScale) < 0.00001);
      confirmed = true;
      target.emit("wheel", { ctrlKey: true, deltaY: 120, clientX: width / 2, clientY: 300 });
      assert.ok(scene.stats().waterfallColumns! > density.warningColumns);
      assert.ok(scene.stats().waterfallScale! < boundaryScale, "确认后可以显示更多图片");
    });
  }
});
test("[Web/展映] Show Pixi 窄相机 wheel 与 pinch 按锚点缩放、夹取边界并结束租约", () => {
  const target = createCameraTestElement();
  const zoomEnds: number[] = [];
  const camera = new ShowPixiCamera({
    element: target.element,
    width: 800,
    height: 600,
    initialScale: 1,
    minimumScale: 0.5,
    maximumScale: 2,
    onZoomEnd: (scale) => zoomEnds.push(scale)
  });
  const wheelAnchor = { x: 300, y: 240 };
  const wheelWorld = camera.screenToWorld(wheelAnchor);
  assert.equal(target.emit("wheel", {
    ctrlKey: true,
    clientX: wheelAnchor.x,
    clientY: wheelAnchor.y,
    deltaY: -180
  }), true);
  assert.ok(camera.scale > 1 && camera.scale < 2);
  const wheelScreen = camera.worldToScreen(wheelWorld);
  assert.ok(Math.abs(wheelScreen.x - wheelAnchor.x) < 0.0001);
  assert.ok(Math.abs(wheelScreen.y - wheelAnchor.y) < 0.0001);
  camera.update(64);
  camera.update(64);
  camera.update(64);
  assert.equal(zoomEnds.length, 1);

  camera.setZoom(1);
  target.emit("pointerdown", {
    clientX: 200,
    clientY: 300,
    pointerId: 1,
    pointerType: "touch",
    timeStamp: 10
  });
  target.emit("pointerdown", {
    clientX: 600,
    clientY: 300,
    pointerId: 2,
    pointerType: "touch",
    timeStamp: 10
  });
  const pinchCenter = camera.center;
  target.emit("pointermove", {
    clientX: 100,
    clientY: 300,
    pointerId: 1,
    pointerType: "touch",
    timeStamp: 26
  });
  target.emit("pointermove", {
    clientX: 700,
    clientY: 300,
    pointerId: 2,
    pointerType: "touch",
    timeStamp: 26
  });
  assert.ok(Math.abs(camera.scale - 1.5) < 0.0001);
  assert.ok(Math.abs(camera.center.x - pinchCenter.x) < 0.0001);
  assert.ok(Math.abs(camera.center.y - pinchCenter.y) < 0.0001);
  target.emit("pointerup", { pointerId: 1, pointerType: "touch", timeStamp: 30 });
  target.emit("pointerup", { pointerId: 2, pointerType: "touch", timeStamp: 30 });
  assert.equal(zoomEnds.length, 2);
  camera.setZoom(100);
  assert.equal(camera.scale, 2);
  camera.setScaleLimits(0.75, 1.25);
  assert.equal(camera.scale, 1.25);
  camera.destroy();
});
test("[Web/展映] waterfall 只有手动纵向平移上报导航，缩放、resize 和自动平移不触发", () => {
  const target = createCameraTestElement();
  const movements: number[] = [];
  const camera = new ShowPixiCamera({
    element: target.element,
    width: 800,
    height: 600,
    initialScale: 1,
    minimumScale: 0.5,
    maximumScale: 2,
    onManualVerticalMovement: (delta) => movements.push(delta)
  });
  try {
    camera.moveCorner(80, 140);
    camera.setZoom(1.5);
    camera.resize(1000, 700);
    target.emit("wheel", { ctrlKey: true, deltaY: -120, clientX: 300, clientY: 200 });
    for (let frame = 0; frame < 12; frame += 1) camera.update(16);
    assert.deepEqual(movements, []);

    const scale = camera.scale;
    const top = camera.top;
    target.emit("wheel", { deltaY: 180 });
    assert.equal(camera.top, top, "滚轮位移由 ticker 平滑消费");
    camera.update(16);
    assert.equal(camera.scale, scale);
    assert.ok(camera.top > top);
    assert.ok(movements.some((delta) => delta > 0));
    for (let frame = 0; frame < 120; frame += 1) camera.update(16);
    assert.equal(camera.moving, false, "余量结束即释放运动，不附加固定等待");

    movements.length = 0;
    target.emit("pointerdown", { clientX: 200, clientY: 200, pointerId: 1, pointerType: "touch" });
    target.emit("pointerdown", { clientX: 600, clientY: 200, pointerId: 2, pointerType: "touch" });
    target.emit("pointermove", { clientX: 700, clientY: 260, pointerId: 2, pointerType: "touch", timeStamp: 16 });
    target.emit("pointerup", { pointerId: 1, pointerType: "touch", timeStamp: 20 });
    target.emit("pointerup", { pointerId: 2, pointerType: "touch", timeStamp: 20 });
    camera.update(16);
    assert.deepEqual(movements, [], "双指锚点修正不冒充手动纵移");
  } finally {
    camera.destroy();
  }
});
test("[Web/展映] 纹理缓存保留原图比例做居中裁剪，共享引用且释放全部解码资源", async (t) => {
  const { ShowPixiTextureCache } = await import("../../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts");
  const calls: unknown[][] = [];
  const bitmaps: Array<{ width: number; height: number; closed: boolean; close: () => void }> = [];
  let requests = 0;
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const replacements = {
    fetch: async () => { requests += 1; return new Response(new Blob(["image"])); },
    createImageBitmap: async (...args: unknown[]) => {
      calls.push(args);
      const options = args.at(-1) as { resizeWidth?: number; resizeHeight?: number };
      const bitmap = {
        width: options.resizeWidth ?? 200,
        height: options.resizeHeight ?? 800,
        closed: false,
        close() { this.closed = true; }
      };
      bitmaps.push(bitmap);
      return bitmap;
    }
  };
  for (const [key, value] of Object.entries(replacements)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const cache = new ShowPixiTextureCache({
    maximumEntries: 2, maximumPixels: 100_000, maximumInFlight: 1,
    maximumUnreferenced: 0, generateMipmaps: false
  });
  t.after(() => {
    cache.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  let lease!: ReturnType<ShowPixiTextureCache["acquire"]>;
  const texture = await new Promise<Texture | null>((resolve) => {
    lease = cache.acquire("https://images.example/tall.webp", {
      pixelWidth: 128, pixelHeight: 128, sourceRatio: 4
    }, resolve);
  });
  assert.ok(texture);
  assert.equal(requests, 1);
  assert.equal(calls.length, 2, "极高原图必须先解码再裁剪，不能直接挤压到方形");
  assert.deepEqual(calls[1].slice(1, 5), [0, 300, 200, 200]);
  assert.equal(bitmaps[0].closed, true);
  let secondLease!: ReturnType<ShowPixiTextureCache["acquire"]>;
  const reused = await new Promise<Texture | null>((resolve) => {
    secondLease = cache.acquire("https://images.example/tall.webp", {
      pixelWidth: 128, pixelHeight: 128, sourceRatio: 4
    }, resolve);
  });
  assert.equal(reused, texture);
  assert.equal(requests, 1);
  lease.release();
  assert.equal(cache.stats().entries, 1, "另一个使用者仍持有引用时不销毁纹理");
  secondLease.release();
  assert.equal(cache.stats().entries, 0);
  assert.equal(cache.stats().reservedPixels, 0);
  assert.ok(bitmaps.every((bitmap) => bitmap.closed));
});
test("[Web/展映] 详情暂停导航保持原显隐状态，关闭后只在自动播放时重新计时", async (t) => {
  for (const movement of ["manual", "page"] as const) {
    await t.test(movement, async (t) => {
      const h = await createPublicNavigationHarness(t, { movement });
      await h.paused(true);
      await h.advance(6_000);
      assert.equal(h.visible(), true);
      await h.manual(600);
      assert.equal(h.visible(), true);
      await h.paused(false);
      await h.manual(600);
      assert.equal(h.visible(), false);
      await h.paused(true);
      await h.pointer(10);
      await h.manual(-600);
      await h.advance(6_000);
      assert.equal(h.visible(), false, "详情不唤出此前收起的导航");
      await h.paused(false);
      assert.equal(h.visible(), false);
      await h.pointer(100);
      await h.pointer(10);
      assert.equal(h.visible(), true);
      await h.advance(2_000);
      await h.paused(true);
      await h.advance(4_000);
      await h.paused(false);
      await h.advance(2_999);
      assert.equal(h.visible(), true);
      await h.advance(1);
      assert.equal(h.visible(), movement === "page");
    });
  }
});
test("[Web/展映] 展映图片只响应完整点击，来回拖动、取消与多指不打开详情", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  let opened = 0;
  let openedIdentity: { id: string; key: string } | undefined;
  const card = h.card("pointer", (image, key) => {
    opened++;
    openedIdentity = { id: image.id, key };
  });
  await h.flush();
  const event = (x: number, pointerId = 1, isPrimary = true) => (
    pixiPointerEvent(x, 100, { pointerId, isPrimary, pointerType: "touch" })
  );
  card.root.emit("pointerdown", event(100));
  card.root.emit("pointermove", event(300));
  card.root.emit("pointermove", event(100));
  card.root.emit("pointerup", event(100));
  assert.equal(opened, 0, "拖回起点仍是拖动");
  card.root.emit("pointerdown", event(100));
  card.clearPointerHover();
  card.root.emit("pointerup", event(100));
  assert.equal(opened, 0);
  card.root.emit("pointerdown", event(100));
  card.root.emit("pointerdown", event(101, 2, false));
  card.root.emit("pointerup", event(101, 2, false));
  card.root.emit("pointerup", event(100));
  assert.equal(opened, 0);
  card.root.emit("pointerdown", event(100));
  card.clearPointerHover();
  card.root.emit("pointerup", event(100));
  assert.equal(opened, 0, "场景取消跨卡片多指意图后不能打开详情");
  card.assign("second-copy", card.image!, 100, 100, .04);
  card.root.emit("pointerdown", event(100));
  card.root.emit("pointermove", event(103));
  card.root.emit("pointerup", event(102));
  assert.equal(opened, 1, "保留正常点击的小幅抖动容差");
  assert.deepEqual(openedIdentity, { id: "pointer", key: "second-copy" }, "详情查询和返回焦点分别使用图片 ID 与当前槽位");
});
test("[Web/展映] 展映卡片身份更换清理旧焦点，调整尺寸仍保留当前焦点", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  const card = h.card("focus");
  await h.flush();
  const image = card.image!;
  card.setFocused(true);
  card.assign(card.key, image, 110, 110, .04, true);
  assert.equal(card.isInteractionActive, true, "同一图片缩放不丢失键盘焦点");
  card.assign("replacement", { ...image, id: "replacement" }, 110, 110, .04);
  assert.equal(card.isInteractionActive, false, "复用卡片不能把旧焦点转给新图");
  assert.equal(card.root.zIndex, 1);
});
test("[Web/展映] 悬浮卡片缩放时快照、边框与透视命中边界保持对齐", async (t) => {
  installPixiPaletteFixture(t);
  const { ShowPixiCard, ShowPixiPerspectiveCoordinator } = await import("../../../packages/web/src/pages/show/pixi/show-pixi-card.ts");
  const { Polygon, RenderTexture, PerspectiveMesh, MeshSimple } = await import("pixi.js");
  class TestCanvas {
    width = 128;
    height = 1;
    getContext() {
      return {
        createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }),
        putImageData() {}
      };
    }
  }
  const globals = {
    HTMLCanvasElement: TestCanvas,
    document: { documentElement: {}, createElement: () => new TestCanvas() },
    window: { devicePixelRatio: 1 }, devicePixelRatio: 1
  };
  const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let snapshotCount = 0;
  let snapshot!: { frame: Rectangle; photo: number[]; texture: InstanceType<typeof RenderTexture> };
  let renderScale = 1;
  let card!: InstanceType<typeof ShowPixiCard>;
  const photoRect = (width: number, height: number) => {
    const borderWidth = Math.min(width / 2, height / 2, 1 / renderScale);
    const innerWidth = Math.max(0, width - borderWidth * 2);
    const innerHeight = Math.max(0, height - borderWidth * 2);
    return [-innerWidth / 2, -innerHeight / 2, innerWidth, innerHeight];
  };
  const renderer = {
    generateTexture({ frame }: { frame: Rectangle }) {
      snapshotCount += 1;
      const texture = RenderTexture.create({ width: Math.floor(frame.width), height: Math.floor(frame.height) });
      snapshot = {
        frame: frame.clone(),
        photo: photoRect(card.width, card.height),
        texture
      };
      return texture;
    }
  } as unknown as Renderer;
  const cache = { acquire: () => ({ release() {} }) } as unknown as import("../../../packages/web/src/pages/show/pixi/show-pixi-texture-cache.ts").ShowPixiTextureCache;
  card = new ShowPixiCard(cache, () => {}, renderer, new ShowPixiPerspectiveCoordinator());
  t.after(() => {
    card.destroy();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  });
  const image = { ...showImages(1)[0], width: 400, height: 600 };
  card.assign("zoom", image, 240.35, 360.525, 0);
  card.setVisible(true);
  const restingHitArea = card.root.hitArea;
  card.root.emit("pointerover", pixiPointerEvent(80, -100));
  card.setFocused(true);
  // Map a snapshot pixel through the actual four mesh corners, independently
  // of the card's projection code, then compare with the edge mesh's inner rim.
  const projectSnapshot = (x: number, y: number, corners: number[]) => {
    const u = (x - snapshot.frame.x) / snapshot.texture.width;
    const v = (y - snapshot.frame.y) / snapshot.texture.height;
    const [x0,y0,x1,y1,x2,y2,x3,y3] = corners;
    const dx1=x1-x2, dx2=x3-x2, dx3=x0-x1+x2-x3;
    const dy1=y1-y2, dy2=y3-y2, dy3=y0-y1+y2-y3;
    const denominator=dx1*dy2-dx2*dy1;
    const g=(dx3*dy2-dx2*dy3)/denominator;
    const h=(dx1*dy3-dx3*dy1)/denominator;
    const divisor=g*u+h*v+1;
    return [((x1-x0+g*x1)*u+(x3-x0+h*x3)*v+x0)/divisor,
      ((y1-y0+g*y1)*u+(y3-y0+h*y3)*v+y0)/divisor];
  };
  const assertAligned = () => {
    const photoMesh = card.visual.children.find((child) => child instanceof PerspectiveMesh)! as InstanceType<typeof PerspectiveMesh>;
    const edge = card.visual.children.find((child) => child instanceof MeshSimple)! as InstanceType<typeof MeshSimple>;
    assert.ok(photoMesh); assert.ok(edge);
    const [x,y,width,height] = snapshot.photo;
    const edgePositions = edge.geometry.getBuffer("aPosition").data;
    // Each side midpoint is an actual vertex: 6 arc samples + 8 straight samples.
    for (const [side, sx, sy] of [[0,0,y+height],[1,x,0],[2,0,y],[3,x+width,0]]) {
      const projected = projectSnapshot(sx, sy, photoMesh.geometry.corners);
      const offset = (side * 22 + 14) * 4 + 2;
      const error = Math.hypot(projected[0]-edgePositions[offset], projected[1]-edgePositions[offset+1]);
      assert.ok(error < .002, `图片与边框偏移 ${error.toFixed(4)}px`);
    }
  };
  for (let frame = 0; frame < 12; frame += 1) {
    card.update(16);
    assertAligned();
  }
  const perspectiveHitArea = card.root.hitArea;
  assert.ok(perspectiveHitArea instanceof Polygon);
  assert.equal(perspectiveHitArea.points.length, 8);
  assert.ok(perspectiveHitArea.contains(0, 0));
  const insetCorners = [
    [-card.width * .49, -card.height * .49],
    [card.width * .49, -card.height * .49],
    [card.width * .49, card.height * .49],
    [-card.width * .49, card.height * .49]
  ];
  assert.ok(
    insetCorners.some(([x, y]) => !perspectiveHitArea.contains(x!, y!)),
    "倾斜后旧矩形角落不能继续成为透明命中区"
  );
  const initialCount = snapshotCount;
  for (const scale of [1.02,1.05,1.08,1.03,.96,1]) {
    renderScale = scale;
    card.setRenderScale(scale);
    card.update(16);
    assertAligned();
    assert.equal(card.root.hitArea, perspectiveHitArea, "透视帧复用同一命中多边形");
  }
  assert.equal(snapshotCount, initialCount, "同档连续缩放不逐帧重新截图");
  card.assign("zoom", image, 400.75, 601.125, 0, true);
  for (let frame=0; frame<50; frame+=1) { card.update(16, true); assertAligned(); }
  assert.equal(snapshotCount, initialCount, "Float 平滑尺寸变化继续复用快照");
  renderScale = 1.3;
  card.setRenderScale(1.3); card.update(16); assertAligned();
  assert.equal(snapshotCount, initialCount+1, "跨分辨率档位仅重建一次快照");
  card.clearPointerHover();
  assert.equal(card.root.hitArea, restingHitArea, "离开透视后恢复稳定矩形命中区");
  assert.equal(card.visual.children.length, 1, "离开悬浮释放快照和边框网格");
  assert.equal(snapshot.texture.destroyed, true);
});
test("[Web/展映] float 单图循环填屏时键盘只固定当前卡片，其余副本继续运动", (t) => {
  const h = createFloatSceneHarness(t, { count: 1 });
  h.scene.setMotion(true, false);
  h.scene.focusCard(h.visibleItems()[0].key);
  const focused = h.scene.root.children.filter((card) => card.zIndex === 100_000);
  assert.equal(focused.length, 1);
  const before = new Map(h.scene.root.children.map((card) => [card, card.y]));
  h.advance(30);
  assert.equal(focused[0].y, before.get(focused[0]));
  assert.ok(h.scene.root.children.some((card) => card !== focused[0] && card.y !== before.get(card)));
  h.scene.focusCard(null);
  h.advance(2);
  assert.ok(focused[0].y < before.get(focused[0])!);
});
test("[Web/展映] waterfall 单图循环填屏时焦点只属于当前卡片槽位", (t) => {
  installPixiPaletteFixture(t);
  const original = Object.getOwnPropertyDescriptor(globalThis, "devicePixelRatio");
  Object.defineProperty(globalThis, "devicePixelRatio", { configurable: true, value: 1 });
  let visible: readonly ShowPixiVisibleItem[] = [];
  const target = createCameraTestElement(1440, 900);
  const scene = new ShowPixiWaterfallScene({ hasMore: false,
    width: 1440, height: 900, columns: 4,
    images: showImages(1), dataKey: "single-image", order: "latest",
    running: false, reducedMotion: false, speed: 28,
    inputElement: target.element,
    textureCache: { acquire: () => ({ release() {} }) } as unknown as ShowPixiTextureCache,
    renderer: {} as Renderer,
    onNeedImages() {}, onOpen() {}, onManualVerticalMovement() {},
    onVisibleItems: (items) => { visible = items; },
    onColumnsChange: (columns) => columns
  });
  t.after(() => {
    scene.destroy();
    if (original) Object.defineProperty(globalThis, "devicePixelRatio", original);
    else delete (globalThis as Record<string, unknown>).devicePixelRatio;
  });
  assert.ok(visible.length > 1);
  assert.equal(new Set(visible.map((item) => item.image.id)).size, 1);
  const focused = () => scene.root.children.filter((card) => card.zIndex === 100_000);
  scene.focusCard(visible[0].key);
  assert.equal(focused().length, 1);
  const first = focused()[0];
  scene.focusCard(visible[1].key);
  assert.equal(focused().length, 1);
  assert.notEqual(focused()[0], first);
  scene.focusCard(null);
  assert.equal(focused().length, 0);
});
test("[Web/展映] 展映诊断按需采集，运动回调和销毁不依赖诊断开关", async (t) => {
  for (const enabled of [false, true]) {
    await t.test(enabled ? "开启诊断" : "生产默认关闭", (t) => {
      const { document } = parseHTML("<html><body></body></html>");
      const motion: boolean[] = [];
      let observed = 0;
      let disconnected = 0;
      let resizeDisconnected = 0;
      let tick = (_ticker: { elapsedMS: number }) => {};
      const globals = {
        document, devicePixelRatio: 1,
        window: Object.assign(new EventTarget(), {
          innerWidth: 1440, innerHeight: 900,
          matchMedia: () => Object.assign(new EventTarget(), { matches: false })
        }),
        ResizeObserver: class {
          observe() {}
          disconnect() { resizeDisconnected++; }
        },
        PerformanceObserver: class {
          static supportedEntryTypes = ["longtask"];
          observe() { observed++; }
          disconnect() { disconnected++; }
        }
      };
      const originals = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
      for (const [key, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
      }
      let runtime: ShowPixiRuntime | undefined;
      t.after(() => {
        runtime?.destroy();
        for (const [key, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, key, descriptor);
          else delete (globalThis as Record<string, unknown>)[key];
        }
      });
      const host = document.createElement("div");
      Object.defineProperties(host, {
        clientWidth: { configurable: true, value: 1440 },
        clientHeight: { configurable: true, value: 900 }
      });
      document.body.appendChild(host);
      const output = enabled ? document.createElement("output") : null;
      const app = {
        canvas: document.createElement("canvas"), stage: new Container(),
        renderer: { resize() {}, events: { setCursor() {} } },
        ticker: {
          count: 0, started: true,
          add(callback: typeof tick) { tick = callback; this.count++; },
          remove(callback: typeof tick) { assert.equal(callback, tick); this.count--; }
        },
        start() { this.ticker.started = true; },
        stop() { this.ticker.started = false; },
        destroy() { this.canvas.remove(); this.stage.destroy({ children: true }); }
      };
      // Inject the GPU shell; exercise the actual runtime and scenes, without
      // creating another initialization or diagnostic implementation for tests.
      runtime = Reflect.construct(ShowPixiRuntime, [host, app, {
        scene: "float", images: [], dataKey: "diagnostics", order: "latest",
        waterfallColumns: 4, floatSizeIndex: 5,
        running: true, reducedMotion: false, speed: 28, statsElement: output,
        onColumnsChange: (value: number) => value,
        onFloatSizeIndexChange: (value: number) => value,
        onMotionActiveChange: (active: boolean) => motion.push(active),
        onManualVerticalMovement() {}, onNeedImages() {}, onOpen() {}, onVisibleItems() {}
      }]) as ShowPixiRuntime;
      for (let i = 0; i < 10; i++) tick({ elapsedMS: 16 });
      assert.equal(runtime.snapshot().frames, enabled ? 10 : 0);
      assert.equal(observed, enabled ? 1 : 0);
      assert.deepEqual(motion, [true]);
      runtime.setRunning(false);
      runtime.setRunning(true);
      runtime.setDialogOpen(true);
      runtime.setDialogOpen(false);
      runtime.setScene("waterfall");
      assert.deepEqual(motion, [true, false, true, false, true]);
      assert.equal(runtime.snapshot().inputEnabled, true);
      if (enabled) {
        runtime.exposeDebug();
        assert.equal(output!.dataset.scene, "waterfall");
        assert.equal(window.__imageShowPixiDebug?.snapshot().frames, 10);
      } else {
        assert.equal(window.__imageShowPixiDebug, undefined);
      }
      runtime.destroy();
      assert.equal(motion.at(-1), false);
      assert.equal(disconnected, enabled ? 1 : 0);
      assert.equal(resizeDisconnected, 1);
      assert.equal(app.ticker.count, 0);
      assert.equal(app.ticker.started, false);
      assert.equal(app.canvas.isConnected, false);
      assert.equal(window.__imageShowPixiDebug, undefined);
      if (enabled) assert.deepEqual(window.__imageShowPixiLastCleanup, {
        activePointers: 0, canvasConnected: false, inputListenerCount: 0,
        runtimeTickerRemoved: true, sceneActive: false, textureEntries: 0,
        tickerStarted: false
      });
    });
  }
});
test("[Web/展映] 展映稳定几何复用命中矩形，缩放和聚焦变化仍更新几何", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  const card = h.card("stable-geometry");
  await h.flush();
  const bounds = card.root.hitArea as Rectangle;
  card.update(16);
  assert.equal(card.root.hitArea, bounds);
  assert.deepEqual([bounds.x, bounds.y, bounds.width, bounds.height], [-50, -50, 100, 100]);
  card.assign(card.key, card.image!, 180, 260, .04, true);
  card.setFocused(true);
  for (let i = 0; i < 150; i++) card.update(16, true);
  assert.equal(card.root.hitArea, bounds);
  assert.deepEqual([bounds.x, bounds.y, bounds.width, bounds.height], [-90, -130, 180, 260]);
  assert.equal(card.root.zIndex, 100_000);
  assert.ok(card.root.scale.x > 1);
  card.setRenderScale(.5);
  card.update(16);
  assert.equal(card.root.hitArea, bounds);
  assert.equal(card.isInteractionActive, true);
});
test("[Web/展映] float 键盘聚焦卡片回收后不向新图片传递焦点", (t) => {
  const h = createFloatSceneHarness(t);
  h.scene.focusCard(h.visibleItems()[0].key);
  const focused = h.scene.root.children.find((card) => card.zIndex === 100_000);
  assert.ok(focused);
  h.dragBy(-6_000);
  assert.ok(h.scene.stats().recycledSprites > 0);
  assert.equal(focused.zIndex, 1, "回收后的图片必须退出旧聚焦层级");
  h.target.emit("pointerup", { timeStamp: 32 });
  h.advance(180);
  const recycledY = focused.y;
  h.scene.setMotion(true, false);
  h.advance(2);
  assert.ok(focused.y < recycledY, "释放手动输入后新图片继续自动上浮");
});
test("[Web/展映] 纹理容量释放唤醒等待卡片且不重置位置，销毁卡片取消等待", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  const first = h.card("first");
  await h.flush();
  assert.equal(first.isTextureReady, true);
  const waiting = h.card("waiting");
  waiting.root.position.set(143, 257);
  waiting.root.rotation = .08;
  await h.flush();
  assert.equal(waiting.isTextureReady, false);
  assert.equal(h.requests.length, 1, "容量不足不发请求");
  first.destroy();
  await h.flush();
  assert.equal(waiting.isTextureReady, true, "不依赖重新 assign 或 ticker 才恢复");
  assert.deepEqual([waiting.root.x, waiting.root.y, waiting.root.rotation], [143, 257, .08]);
  const removed = h.card("removed");
  await h.flush();
  removed.destroy();
  waiting.destroy();
  await h.flush();
  assert.equal(h.requests.length, 2, "已回收卡片不能被缓存唤醒");
  assert.equal(h.cache.stats().entries, 0);
  assert.equal(h.cache.stats().reservedPixels, 0);
});
test("[Web/展映] 加载中释放的纹理在完成后唤醒等待卡片，即使空闲 LRU 未超限", async (t) => {
  const h = await createTextureRecoveryHarness(t, { maximumUnreferenced: 1, maximumPixels: 100_000 });
  const finish = h.hold("held");
  const first = h.card("held");
  const waiting = h.card("waiting");
  await new Promise((resolve) => setImmediate(resolve));
  first.destroy();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waiting.isTextureReady, false);
  assert.equal(h.requests.length, 1);
  assert.ok(h.cache.stats().rejected >= 2, "loading 时释放引用仍不能淘汰该纹理");
  finish();
  await h.flush();
  assert.equal(waiting.isTextureReady, true, "ready 后可淘汰的状态转换必须唤醒等待者");
  assert.equal(h.requests.length, 2);
});
test("[Web/展映] 纹理传输失败有界暂停，恢复联网允许重试且不重试 HTTP 错误", async (t) => {
  for (const phase of ["headers", "body"] as const) {
    await t.test(phase, async (t) => {
      const h = await createTextureRecoveryHarness(t, { maximumEntries: 6 });
      const missing = h.card("missing");
      await h.flush();
      h.setOffline(true, phase);
      const cards = [];
      for (let i = 0; i < 4; i += 1) {
        cards.push(h.card(`offline-${i}`));
        await h.flush();
      }
      assert.equal(h.requests.length, 4, "同源三次传输失败后停止该来源请求");
      await h.flush();
      assert.equal(h.requests.length, 4, "等待期间不轮询网络");
      const resumedCard = h.card("offline-0");
      h.setOffline(false);
      h.cache.resumeTransportRequests();
      await h.flush();
      assert.equal(resumedCard.isTextureReady, true, "同一提交内创建卡片并恢复播放不能丢掉待恢复租约");
      assert.ok(cards.every((card) => card.isTextureReady), JSON.stringify({ ready: cards.map((card) => card.isTextureReady), requests: h.requests, stats: h.cache.stats() }));
      assert.equal(missing.isTextureReady, false);
      assert.equal(h.requests.filter((url) => url.includes("missing")).length, 1);
      assert.equal(h.requests.length, 8);
    });
  }
});
test("[Web/展映] 详情成功加载同一 URL 后恢复失败纹理，原位共享且不重试其他失败图", async (t) => {
  for (const failure of ["headers", "body", "http", "decode"] as const) {
    await t.test(failure, async (t) => {
      const h = await createTextureRecoveryHarness(t, { maximumEntries: 6 });
      const healthy = h.card("healthy");
      await h.flush();
      const other = h.card("missing-other");
      await h.flush();
      if (failure === "http") h.setStatus("recover", 503);
      else if (failure === "decode") h.setDecodeFailure(true);
      else h.setOffline(true, failure);
      const first = h.card("recover");
      await h.flush();
      const second = h.card("recover");
      first.root.position.set(143, 257);
      first.root.rotation = .08;
      await h.flush();
      assert.equal(first.isTextureReady, false);
      assert.equal(h.requests.length, 3);
      h.setOffline(false);
      h.setDecodeFailure(false);
      h.setStatus("recover", 200);
      h.cache.retryFailedUrl("https://textures.example/full-recover.webp");
      await h.flush();
      assert.equal(h.requests.length, 3, "不同原图 URL 成功不证明缩略图已恢复");
      const url = "https://textures.example/recover.webp";
      h.cache.retryFailedUrl(url);
      h.cache.retryFailedUrl(url);
      await h.flush();
      assert.equal(first.isTextureReady, true);
      assert.equal(second.isTextureReady, true);
      assert.equal(healthy.isTextureReady, true);
      assert.equal(other.isTextureReady, false);
      assert.equal(h.requests.length, 4, "重复成功信号和相同 LOD 副本共用一次重试，健康纹理保持复用");
      assert.deepEqual([first.root.x, first.root.y, first.root.rotation], [143, 257, .08]);
      h.cache.retryFailedUrl(url);
      await h.flush();
      assert.equal(h.requests.length, 4, "已恢复纹理不会再次请求");
    });
  }
});
test("[Web/展映] 纹理恢复按浏览器资源 URL 匹配，域名大小写与默认端口不产生两套失败记录", async (t) => {
  const h = await createTextureRecoveryHarness(t);
  h.setStatus("canonical", 503);
  const card = h.card("canonical", () => undefined, "https://TEXTURES.example:443/canonical.webp");
  await h.flush();
  assert.equal(card.isTextureReady, false);
  h.setStatus("canonical", 200);
  h.cache.retryFailedUrl("https://textures.example/canonical.webp");
  await h.flush();
  assert.equal(card.isTextureReady, true);
  assert.deepEqual(h.requests, Array(2).fill("https://textures.example/canonical.webp"));
});
test("[Web/展映] 图片成功信号解除来源暂停，CORS 仍失败时再次暂停且回收后不唤醒", async (t) => {
  const h = await createTextureRecoveryHarness(t, { maximumEntries: 6 });
  h.setOffline(true);
  const cards = [];
  for (let i = 0; i < 4; i++) {
    cards.push(h.card(`recovery-${i}`));
    await h.flush();
  }
  assert.equal(h.requests.length, 3);
  h.setOffline(false);
  h.cache.retryFailedUrl("https://textures.example/recovery-3.webp");
  await h.flush();
  assert.equal(cards[3].isTextureReady, true, "尚未发请求、仅被来源暂停拦住的卡片也能恢复");
  assert.ok(cards.slice(0, 3).every(card => !card.isTextureReady));
  h.setOffline(true);
  h.cache.retryFailedUrl("https://textures.example/recovery-0.webp");
  await h.flush();
  assert.equal(h.requests.length, 5);
  await h.flush();
  assert.equal(h.requests.length, 5, "DOM 图片成功不保证 CORS 成功；再次失败不能自动循环");
  cards[0].destroy();
  h.setOffline(false);
  h.cache.retryFailedUrl("https://textures.example/recovery-0.webp");
  await h.flush();
  assert.equal(h.requests.length, 5, "已回收卡片不会因迟到成功信号发起请求");
});
test("[Web/展映] 两种场景和三种排序原位更新元数据并保持卡片位置与纹理引用", async (t) => {
  for (const order of ["random", "latest", "oldest"] as const) {
    await t.test(`float/${order}`, (t) => {
      const h = createFloatSceneHarness(t, { count: 800 });
      const images = showImages(800);
      h.scene.setImages(images, "edited-float", order, true);
      h.advance(16);
      const positions = floatCardPositions(h.scene);
      const leases = h.activeLeases().map((entry) => entry.key);
      h.scene.setImages(images.map((image) => ({ ...image, title: "更新标题" })), "edited-float", order, true);
      h.advance(16);
      assert.equal(h.scene.stats().retainedDtos, 500);
      assert.ok(h.visibleItems().length > 0);
      assert.ok(h.visibleItems().every(({ image }) => image.title === "更新标题"));
      assert.deepEqual(floatCardPositions(h.scene), positions);
      assert.deepEqual(h.activeLeases().map((entry) => entry.key), leases);
    });
    await t.test(`waterfall/${order}`, (t) => {
      installPixiPaletteFixture(t);
      t.after(installProperties(globalThis, { devicePixelRatio: 1 }));
      const target = createCameraTestElement(1440, 900);
      const images = showImages(800);
      let visible: readonly ShowPixiVisibleItem[] = [];
      let acquired = 0;
      let released = 0;
      const scene = new ShowPixiWaterfallScene({ hasMore: false,
        width: 1440, height: 900, columns: 4,
        images, dataKey: "edited-waterfall", order,
        running: false, reducedMotion: false, speed: 28,
        inputElement: target.element,
        textureCache: { acquire() {
          acquired++;
          return { release() { released++; } };
        } } as unknown as ShowPixiTextureCache,
        renderer: {} as Renderer,
        onNeedImages() {}, onOpen() {}, onManualVerticalMovement() {},
        onVisibleItems: (items) => { visible = items; },
        onColumnsChange: (columns) => columns
      });
      t.after(() => {
        scene.destroy();
        assert.equal(acquired, released);
        assert.equal(target.listenerCount(), 0);
      });
      const positions = () => scene.root.children.map((root) => ({
        root, x: root.x, y: root.y, rotation: root.rotation
      }));
      const before = positions();
      const leases = { acquired, released };
      scene.setImages(images.map((image) => ({ ...image, title: "更新标题" })), "edited-waterfall", order, false);
      assert.equal(scene.stats().retainedDtos, 800);
      assert.ok(visible.length > 0);
      assert.ok(visible.every(({ image }) => image.title === "更新标题"));
      assert.deepEqual(positions(), before);
      assert.deepEqual({ acquired, released }, leases);
    });
  }
});
test("[Web/展映] float 导航位移保留拖动和惯性的指针类型，滚轮独立上报", async (t) => {
  for (const pointerType of ["mouse", "touch"]) {
    await t.test(pointerType, (t) => {
      const h = createFloatSceneHarness(t);
      h.target.emit("pointerdown", { clientY: 200, timeStamp: 0, pointerType });
      h.target.emit("pointermove", { clientY: 280, timeStamp: 16, pointerType });
      assert.deepEqual(h.movementPointerTypes, [pointerType]);
      h.target.emit("pointerup", { timeStamp: 20, pointerType });
      h.advance(1);
      assert.deepEqual(h.movementPointerTypes, [pointerType, pointerType]);
      h.movementPointerTypes.length = 0;
      h.target.emit("wheel", { deltaY: -120 });
      h.advance(1);
      assert.ok(h.movementPointerTypes.length > 0);
      assert.ok(h.movementPointerTypes.every((type) => type === undefined));
    });
  }
});
test("[Web/展映] float 桌面三种尺寸保持混排宽度、卡片与候选上限、两端预取总预算", async (t) => {
  for (const sizeIndex of [0, defaultShowFloatSizeIndex, showFloatSizeSteps.length - 1]) {
    await t.test(`尺寸 ${showFloatSizeSteps[sizeIndex]}×`, (t) => {
      const h = createFloatSceneHarness(t, { sizeIndex });
      const stats = h.scene.stats();
      assert.equal(stats.retainedDtos, 500);
      assert.ok(stats.activeSprites >= 8 && stats.activeSprites <= 180);
      const prefetches = h.activeLeases().length - stats.activeSprites;
      assert.ok(prefetches >= 12 && prefetches <= 36, "上下队列共享一个总预算");
      const targetWidth = showFloatDefaultWidth(1440) * showFloatSizeSteps[sizeIndex];
      const widths = floatCardPositions(h.scene).map((card) => card.width / targetWidth);
      assert.ok(widths.every((width) => width >= 0.7 && width <= 1.2));
      assert.ok(Math.min(...widths) < 0.8 && Math.max(...widths) > 1.1);
      assert.ok(h.scene.stats().coverageRatio > 0);
    });
  }
});
test("[Web/展映] float 横竖长图保持真实比例，并在各视口保留完整图面的观看空间", async (t) => {
  for (const [width, height] of [[359, 800], [390, 844], [844, 390], [768, 1024], [1440, 900], [3840, 2160]] as const) {
    await t.test(`${width}×${height}`, (t) => {
      const h = createFloatSceneHarness(t, { width, height, sizeIndex: 10 });
      const images = showImages(80).map((image, index) => ({
        ...image, width: index % 2 ? 3000 : 900, height: index % 2 ? 900 : 3000
      }));
      h.scene.setImages(images, "long-image-viewing", "latest", false);
      const cards = floatCardPositions(h.scene);
      assert.ok(cards.length > 0);
      for (const card of cards) {
        const ratio = card.width / card.height;
        assert.ok(Math.min(Math.abs(ratio - 3 / 10), Math.abs(ratio - 10 / 3)) < 1e-8);
        const cosine = Math.abs(Math.cos(card.rotation));
        const sine = Math.abs(Math.sin(card.rotation));
        assert.ok(card.width * cosine + card.height * sine < width);
        assert.ok(card.height * cosine + card.width * sine < height);
      }
    });
  }
});

test("[Web/展映] float 暂停时连续双向补图，保留反向预取并接管已加载纹理", (t) => {
  const h = createFloatSceneHarness(t);
  const initialCount = h.scene.stats().activeSprites;
  const prefetches = h.acquisitions.slice(initialCount);
  const reverseReserve = prefetches.slice(Math.ceil(prefetches.length / 2));
  assert.ok(reverseReserve.length >= 6);
  h.resolveTextures();
  h.dragBy(-2700);
  assert.ok(reverseReserve.every((entry) => entry.active), "向上移动不取消上方的反向储备");
  assert.ok(h.acquisitions.some((entry) => entry.shared && entry.readyAtAcquire));
  const upwardRecycles = h.scene.stats().recycledSprites;
  assert.ok(upwardRecycles > 0);
  h.dragBy(2700);
  assert.ok(h.scene.stats().recycledSprites > upwardRecycles);
  assert.ok(reverseReserve.some((entry) => !entry.active), "向下移动消费事先保留的上方队列");
  for (const delta of [-450, 450, -3600, 3600, -900, 900]) {
    h.dragBy(delta);
    assert.equal(h.scene.stats().activeSprites, initialCount);
    assert.ok(h.scene.stats().visibleSprites > 0);
    assert.ok(h.activeLeases().length <= initialCount + 36);
  }
  assert.ok(h.movements.some((delta) => delta > 0));
  assert.ok(h.movements.some((delta) => delta < 0));
  assert.equal(h.requests(), 0, "候选充足不因反向重复请求元数据");
});
test("[Web/展映] float 快速反向直接响应新滚轮方向，屏内卡片不跳位且暂停保持", (t) => {
  const h = createFloatSceneHarness(t);
  h.resolveTextures();
  h.target.emit("wheel", { deltaY: 360 });
  h.scene.update(16);
  const before = floatCardPositions(h.scene).filter((card) => card.y > 100 && card.y < 800);
  assert.ok(before.length > 0);
  const movementCount = h.movements.length;
  h.target.emit("wheel", { deltaY: -72 });
  h.scene.update(16);
  assert.ok(h.movements[movementCount] < 0, "不先抵消旧方向的剩余滚动量");
  for (const card of before) {
    assert.equal(card.root.x, card.x);
    assert.ok(card.root.y > card.y && card.root.y - card.y < 72);
    assert.equal((card.root.hitArea as Rectangle).width, card.width);
  }
  h.advance(120);
  const settled = floatCardPositions(h.scene).map(({ x, y, rotation }) => ({ x, y, rotation }));
  h.advance(30);
  assert.deepEqual(floatCardPositions(h.scene).map(({ x, y, rotation }) => ({ x, y, rotation })), settled);
});
test("[Web/展映] float 自动上浮与轻旋转保留，手动输入让位后无需等待恢复", (t) => {
  const h = createFloatSceneHarness(t);
  const card = floatCardPositions(h.scene).find((item) => item.y > 300 && item.y < 600);
  assert.ok(card);
  h.scene.setMotion(true, false);
  h.advance(30);
  assert.ok(card.root.y < card.y);
  assert.ok(Math.abs(card.root.rotation - card.rotation) > 0);
  assert.ok(Math.abs(card.root.rotation - card.rotation) <= 3 * Math.PI / 180);
  h.target.emit("pointerdown", { clientY: 400, timeStamp: 100 });
  const heldY = card.root.y;
  h.advance(5);
  assert.equal(card.root.y, heldY);
  h.target.emit("pointerup", { timeStamp: 200 });
  h.scene.update(16);
  assert.ok(card.root.y < heldY, "无手动余量时下一帧即恢复自动上浮");
});
test("[Web/展映] float 按未消费候选数量补充并在有限池停止请求", async (t) => {
  for (const count of [100, 300]) {
    await t.test(`${count} 张候选`, (t) => {
      const h = createFloatSceneHarness(t, { count, hasMore: true });
      assert.equal(h.requests() > 0, count === 100);
    });
  }
});
test("[Web/展映] float 鼠标悬停平滑摆正，提前释放和完整释放均从当前角度继续", async (t) => {
  for (const frames of [4, 20]) {
    await t.test(`${frames} 帧后释放`, (t) => {
      const h = createFloatSceneHarness(t);
      h.scene.setMotion(true, false);
      h.advance(10);
      const card = floatCardPositions(h.scene).find((item) => item.y > 200 && item.y < 700 && Math.abs(item.rotation) > .01)!;
      assert.ok(card);
      const heldY = card.root.y;
      card.root.emit("pointerover", pixiPointerEvent(card.x, card.y));
      h.advance(frames);
      assert.equal(card.root.y, heldY);
      assert.ok(Math.abs(card.root.rotation) < Math.abs(card.rotation));
      if (frames === 20) assert.ok(Math.abs(card.root.rotation) < .00001);
      const releasedAngle = card.root.rotation;
      card.root.emit("pointerout", pixiPointerEvent(card.x, card.y));
      h.advance(1);
      assert.ok(Math.abs(card.root.rotation - releasedAngle) < .001, "释放不能跳回旧倾角");
      assert.ok(card.root.y < heldY);
    });
  }
});
test("[Web/展映] 展映补图失败只等待显式重试，切换查询会取消旧请求并保留提交边界", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { useShowData } = await import("../../../packages/web/src/pages/show/useShowData.ts");
  let current!: ReturnType<typeof useShowData>;
  function Probe({ theme }: { theme: string }) {
    current = useShowData({ ...emptyGalleryFilters, theme }, theme, "latest");
    return null;
  }
  await h.render(h.React.createElement(Probe, { theme: "first" }));
  await h.respond(0, { items: showImages(3), next_cursor: "next" });
  assert.equal(current.images.length, 3);
  await h.React.act(async () => current.loadMore());
  await h.respond(1, { error: "补图失败" }, 503);
  assert.ok(current.error);
  await h.React.act(async () => { for (let frame = 0; frame < 100; frame += 1) current.loadMore(); });
  assert.equal(h.pending.length, 2, "场景逐帧补图信号不能变成网络重试循环");
  await h.React.act(async () => current.retry());
  assert.equal(h.pending.length, 3);
  assert.equal(new URL(h.pending[2].path, "https://img.example").searchParams.get("cursor"), "next");
  await h.render(h.React.createElement(Probe, { theme: "second" }));
  assert.equal(h.pending[2].signal?.aborted, true);
  assert.equal(current.committedKey.split("#")[0], "first");
  await h.respond(2, { items: showImages(9), next_cursor: "stale" });
  assert.equal(current.committedKey.split("#")[0], "first", "旧请求晚到不能提交到新筛选");
  await h.respond(3, { items: showImages(1), next_cursor: null });
  assert.equal(current.committedKey.split("#")[0], "second");
  assert.equal(current.images.length, 1);
  await h.React.act(async () => current.loadMore());
  assert.equal(h.pending.length, 4, "有序游标耗尽后不重复首批");
});
test("[Web/展映] 编辑累计批次中的图片只原位更新目标并保持后续补图游标", async (t) => {
  for (const order of ["random", "latest", "oldest"] as const) {
    await t.test(order, async (t) => {
      const h = await createConfigStreamHarness(t, { honorAbort: false });
      const { useShowData } = await import("../../../packages/web/src/pages/show/useShowData.ts");
      let current!: ReturnType<typeof useShowData>;
      function Probe() {
        current = useShowData(emptyGalleryFilters, order, order);
        return null;
      }
      const initial = showImages(400);
      await h.render(h.React.createElement(Probe));
      await h.respond(0, { count: 200, items: initial.slice(0, 200), next_cursor: "page-2" });
      await h.React.act(async () => current.loadMore());
      await h.respond(1, { count: 100, items: initial.slice(200, 300), next_cursor: "page-3" });
      const before = current.images;
      const target = before[250]!;
      await h.React.act(async () => current.loadMore());
      await h.React.act(async () => current.updateImage(editableImage(target.id, {
        ...target, title: "更新后的标题", theme: "changed"
      })));
      assert.deepEqual(current.images.map(({ id }) => id), before.map(({ id }) => id));
      assert.equal(current.images[250]!.title, "更新后的标题");
      assert.equal(current.images[250]!.width, target.width);
      for (const index of [0, 249, 251, 299]) assert.strictEqual(current.images[index], before[index]);
      assert.equal(h.pending.length, 3);
      if (order !== "random") {
        assert.equal(new URL(h.pending[2]!.path, "https://img.example").searchParams.get("cursor"), "page-3");
      }
      await h.respond(2, { count: 101, items: [target, ...initial.slice(300)], next_cursor: null });
      assert.equal(current.images.length, 300, "编辑前的响应已被隔离");
      await h.React.act(async () => current.loadMore());
      assert.equal(new URL(h.pending[3]!.path, "https://img.example").searchParams.get("cursor"), "page-3");
      await h.respond(3, { items: initial.slice(300), next_cursor: null });
      assert.equal(current.images.length, 400);
      assert.equal(current.images[250]!.title, "更新后的标题");
      assert.equal(current.committedOrder, order);
    });
  }
});
test("[Web/展映] 定向回读按 ID 收敛连续编辑并保留失败前的已提交图片", async (t) => {
  const h = await createConfigStreamHarness(t, { honorAbort: false });
  const { useShowData } = await import("../../../packages/web/src/pages/show/useShowData.ts");
  let current!: ReturnType<typeof useShowData>;
  function Probe() {
    current = useShowData(emptyGalleryFilters, "targeted", "latest");
    return null;
  }
  const initial = showImages(3);
  await h.render(h.React.createElement(Probe));
  await h.respond(0, { items: initial, next_cursor: "next" });
  const preserved = current.images;
  const target = initial[1]!;
  await h.React.act(async () => current.refreshImage(target.id));
  const url = new URL(h.pending[1]!.path, "https://img.example");
  assert.equal(url.pathname, "/api/images");
  assert.equal(h.pending[1]!.path, h.pending[0]!.path, "回读原始批次 URL 并按目标 ID 更新");
  assert.equal(h.pending[1]!.cache, "no-cache");
  await h.React.act(async () => current.refreshImage(target.id));
  assert.equal(h.pending[1]!.signal?.aborted, true);
  await h.respond(2, { count: 1, items: [{ ...target, title: "较新回读" }] });
  await h.respond(1, { count: 1, items: [{ ...target, title: "过时回读" }] });
  assert.equal(current.images[1]!.title, "较新回读");
  await h.React.act(async () => current.refreshImage(target.id));
  await h.React.act(async () => current.updateImage(editableImage(target.id, { ...target, title: "保存快照" })));
  assert.equal(h.pending[3]!.signal?.aborted, true);
  await h.respond(3, { count: 1, items: [{ ...target, title: "快照前回读" }] });
  assert.equal(current.images[1]!.title, "保存快照");
  await h.React.act(async () => current.refreshImage(target.id));
  await h.respond(4, { error: "暂时不可用" }, 503);
  assert.equal(current.images[1]!.title, "保存快照");
  await h.React.act(async () => current.refreshImage(target.id));
  await h.respond(5, { count: 1, items: [{ ...target, title: "回读恢复" }] });
  assert.equal(current.images[1]!.title, "回读恢复");
  assert.strictEqual(current.images[0], preserved[0]);
  assert.strictEqual(current.images[2], preserved[2]);
  await h.React.act(async () => current.refreshImage(target.id));
  await h.render(null);
  assert.equal(h.pending[6]!.signal?.aborted, true);
});
test("[Web/展映] 退出筛选或删除只移除目标并隔离在途补图后继续同一游标", async (t) => {
  for (const action of ["edit", "trash", "missing"] as const) {
    await t.test(action, async (t) => {
      const h = await createConfigStreamHarness(t, { honorAbort: false });
      const { useShowData } = await import("../../../packages/web/src/pages/show/useShowData.ts");
      let current!: ReturnType<typeof useShowData>;
      function Probe() {
        current = useShowData({ ...emptyGalleryFilters, theme: "included" }, "filtered", "latest");
        return null;
      }
      const initial = showImages(3).map((image) => ({ ...image, theme: "included" }));
      await h.render(h.React.createElement(Probe));
      await h.respond(0, { items: initial, next_cursor: "next" });
      const preserved = current.images;
      await h.React.act(async () => current.loadMore());
      const target = initial[0]!;
      if (action === "edit") {
        await h.React.act(async () => current.updateImage(editableImage(target.id, { ...target, theme: "excluded" })));
      } else if (action === "trash") {
        await h.React.act(async () => current.removeImage(target.id));
        await h.React.act(async () => current.loadMore());
      } else {
        await h.React.act(async () => current.refreshImage(target.id));
        await h.respond(2, { error: "找不到图片" }, 404);
      }
      assert.equal(h.pending[1]!.signal?.aborted, true);
      const resumedRequest = h.pending.at(-1)!;
      await h.React.act(async () => {
        assert.equal(current.removeImage(target.id), false);
      });
      assert.equal(resumedRequest.signal?.aborted, false, "重复删除回执不打断已恢复的补图流");
      await h.respond(1, { items: initial, next_cursor: "stale" });
      assert.deepEqual(current.images.map(({ id }) => id), initial.slice(1).map(({ id }) => id));
      const nextRequest = h.pending.length - 1;
      assert.equal(new URL(h.pending[nextRequest]!.path, "https://img.example").searchParams.get("cursor"), "next");
      await h.respond(nextRequest, { items: [showImages(4)[3]], next_cursor: null });
      assert.equal(current.images.length, 3);
      assert.strictEqual(current.images[0], preserved[1]);
      assert.strictEqual(current.images[1], preserved[2]);
      assert.equal(current.initialLoading, false);
    });
  }
});
test("[Web/展映] 编辑成员判断遵循包含、排除和自动设备筛选", () => {
  const image = editableImage(showImages(2)[1]!.id, { device: "pc", brightness: "dark", theme: "night", tags: ["blue", "stars"], author: "author" });
  for (const [filter, expected] of [
    [{ theme: "night,day" }, true], [{ theme: "!night" }, false],
    [{ tag: "red,stars" }, true], [{ tag: "!red,!green" }, true],
    [{ tag: "!stars" }, false], [{ author: "author" }, true],
    [{ author: "!author" }, false], [{ brightness: "light" }, false],
    [{ device: "mb" }, false]
  ] as const) {
    assert.equal(imageMatchesFilters(image, { ...emptyGalleryFilters, ...filter }, ""), expected);
  }
  assert.equal(imageMatchesFilters(image, { ...emptyGalleryFilters, device: "auto" }, "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"), true);
  assert.equal(imageMatchesFilters(image, { ...emptyGalleryFilters, device: "auto" }, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile"), false);
});
test("[Web/展映] 瀑布缩放保持视口四周 35% 驻留缓冲并按世界坐标换算", () => {
  const residence: ShowResidencePolicy = {
    horizontalOverscanScreens: 0.35,
    verticalOverscanScreens: 0.35
  };
  const window = showViewportWindow(
    { x: 120, y: 240 },
    { width: 800, height: 600 },
    2,
    residence
  );
  assert.deepEqual(window.visible, {
    left: 60,
    top: 120,
    right: 460,
    bottom: 420
  });
  assert.deepEqual(window.resident, {
    left: -80,
    top: 15,
    right: 600,
    bottom: 525
  });
  const zoomed = showViewportWindow(
    { x: -140, y: -30 },
    { width: 800, height: 600 },
    1,
    residence
  );
  assert.deepEqual(zoomed.resident, { left: -420, top: -240, right: 940, bottom: 780 });
});
test("[Web/展映] 展映窗口可独立指定四向缓冲比例", () => {
  const window = showViewportWindow(
    { x: 120, y: 240 },
    { width: 800, height: 600 },
    2,
    {
      horizontalOverscanScreens: 0.5,
      verticalOverscanScreens: 0.5
    }
  );
  assert.deepEqual(window.resident, {
    left: -140,
    top: -30,
    right: 660,
    bottom: 570
  });
});
test("[Web/展映] 展映卡片维持窄缝且不回退为刚性网格", () => {
  const source = showImages(1)[0];
  const geometries = Array.from({ length: 80 }, (_, index) => (
    showCardGeometry(source, index % 9 - 4, index - 40)
  ));
  for (const geometry of geometries) {
    assert.ok(geometry.width >= 360 * 0.985);
    assert.ok(geometry.width < 360 * 0.992);
    assert.ok(geometry.gapAfter >= 4);
    assert.ok(geometry.gapAfter < 6);
  }
  assert.ok(new Set(geometries.map((geometry) => geometry.gapAfter)).size > 70);
  assert.ok(new Set(geometries.map((geometry) => geometry.angle)).size > 70);
});
test("[Web/展映] 展映乱序保持元素完整、可重现且不改写输入", () => {
  const source = showImages(4);
  const sourceIds = source.map((image) => image.id);
  const shuffle = () => {
    const values = [0.25, 0.75, 0.5];
    return shuffledImageBatch(source, () => values.shift() ?? 0)
      .map((image) => image.id);
  };
  const shuffledIds = shuffle();
  assert.deepEqual(source.map((image) => image.id), sourceIds);
  assert.equal(shuffledIds.length, sourceIds.length);
  assert.deepEqual(new Set(shuffledIds), new Set(sourceIds));
  assert.notDeepEqual(shuffledIds, sourceIds, "代表性随机输入必须实际改变顺序");
  assert.deepEqual(shuffle(), shuffledIds, "同一受控随机源必须得到可重现结果");
});
test("[Web/展映] 展映数据池先耗尽唯一图片再进行有界复用", () => {
  const pool = new ShowDataPool(10);
  pool.add(showImages(10));
  const claimed = Array.from({ length: 10 }, (_, index) => pool.claim(`slot-${index}`));
  assert.equal(new Set(claimed.map((image) => image?.id)).size, 10);
  assert.equal(pool.claim("overflow")?.id, claimed[0]?.id);
  pool.release("slot-4");
  assert.equal(pool.claim("replacement")?.id, claimed[4]?.id);
  assert.deepEqual(pool.snapshot(), { active: 11, available: 0, retained: 10 });
  pool.release("overflow");
  assert.deepEqual(pool.snapshot(), { active: 10, available: 0, retained: 10 });
  pool.release("slot-0");
  assert.equal(pool.snapshot().available, 0, "已消费候选可以复用，但不计入未消费数量");
  assert.equal(pool.claim("returned")?.id, claimed[0]?.id);
  assert.equal(pool.remove(claimed[0]!.id), true);
  assert.notEqual(pool.claim("after-remove")?.id, claimed[0]?.id);
  assert.deepEqual(pool.snapshot(), { active: 10, available: 0, retained: 9 });
});
test("[Web/展映] 展映有限图片池仍填满超密驻留窗口", () => {
  const pool = new ShowDataPool(4);
  pool.add(showImages(4));
  const controller = new ShowWindowController(pool);
  const viewport = { width: 736, height: 526 };
  controller.reconcile(
    { x: 0, y: 0 },
    viewport,
    0.25,
    {
      horizontalOverscanScreens: 0.5,
      verticalOverscanScreens: 0.5
    }
  );
  const snapshot = controller.snapshot();
  assert.equal(snapshot.missingCards, 0);
  assert.ok(snapshot.cards.length > 4);
  assert.equal(new Set(snapshot.cards.map((card) => card.image.id)).size, 4);
  assert.deepEqual(pool.snapshot(), {
    active: snapshot.cards.length,
    available: 0,
    retained: 4
  });
});
test("[Web/展映] 展映长距离二维移动保持卡片有界并填满驻留区", () => {
  const pool = new ShowDataPool(800);
  pool.add(showImages(800));
  const controller = new ShowWindowController(pool);
  const viewport = { width: 1440, height: 900 };
  const density = showWaterfallDensity(1440);
  const denseScale = 1440 / density.normalMaximumColumns / 360;
  const residence: ShowResidencePolicy = {
    horizontalOverscanScreens: 0.35, verticalOverscanScreens: 0.35
  };
  let maximumCards = 0;
  let minimumCards = Number.POSITIVE_INFINITY;

  for (let step = 0; step < 1200; step += 1) {
    const camera = {
      x: Math.sin(step / 31) * 2200,
      y: step * 21 - 6000
    };
    controller.reconcile(camera, viewport, denseScale, residence);
    const snapshot = controller.snapshot();
    assert.ok(snapshot.activeColumns < 32);
    maximumCards = Math.max(maximumCards, snapshot.cards.length);
    minimumCards = Math.min(minimumCards, snapshot.cards.length);
    assert.equal(snapshot.missingCards, 0);
    assert.equal(
      new Set(snapshot.cards.map((card) => card.image.id)).size,
      snapshot.cards.length
    );
    const outside = snapshot.cards.find((card) => !showRectsIntersect(
      showCardRect(card),
      snapshot.window.resident
    ));
    assert.equal(
      outside,
      undefined,
      JSON.stringify({ step, outside, resident: snapshot.window.resident })
    );
  }

  assert.ok(minimumCards > 20);
  assert.ok(maximumCards < 240);
  assert.ok(pool.snapshot().retained <= 800);
  assert.equal(pool.snapshot().active, controller.snapshot().cards.length);
});

test("[Web/展映] 瀑布在上下边缘间隙暂停保留候选，进入边缘只消费实际入场图片", () => {
  const viewport = { width: 808, height: 734 };
  const scale = viewport.width / (3 * 360);
  const residence: ShowResidencePolicy = {
    horizontalOverscanScreens: 0.35, verticalOverscanScreens: 0.35
  };
  for (const edge of ["top", "bottom"] as const) {
    const pool = new ShowDataPool(800);
    pool.setStreaming(true, false);
    pool.add(showImages(700));
    const controller = new ShowWindowController(pool);
    const camera = { x: -viewport.width / 6, y: 0 };
    controller.reconcile(camera, viewport, scale, residence);
    const column = controller.snapshot().cards.filter((card) => card.column === 0);
    assert.ok(column.length > 1);
    const boundary = edge === "top"
      ? column[0]!.y - 0.5
      : column.at(-1)!.y + column.at(-1)!.height + 0.5;
    camera.y = boundary * scale + (edge === "top"
      ? viewport.height * 0.35 : -viewport.height * 1.35);
    controller.reconcile(camera, viewport, scale, residence);
    const before = controller.snapshot();
    const usage = pool.usage("paused");
    const revision = pool.revision;
    for (let frame = 0; frame < 1_000; frame += 1) {
      controller.reconcile(camera, viewport, scale, residence);
    }
    assert.deepEqual(controller.snapshot(), before, edge);
    assert.deepEqual(pool.usage("paused"), usage, edge);
    assert.equal(pool.revision, revision, edge);

    camera.y += (edge === "top" ? -8 : 8) * scale;
    controller.reconcile(camera, viewport, scale, residence);
    const previous = new Set(usage.consumedIds);
    const consumed = pool.usage("entered").consumedIds.filter((id) => !previous.has(id));
    const entered = controller.snapshot().cards
      .map((card) => card.image.id).filter((id) => !previous.has(id));
    assert.ok(entered.length > 0, edge);
    assert.deepEqual(new Set(consumed), new Set(entered), edge);
  }
});

test("[Web/展映] 展映远距离横移只保留驻留列并为回程生成新卡位", () => {
  const pool = new ShowDataPool(800);
  pool.add(showImages(800));
  const controller = new ShowWindowController(pool);
  const viewport = { width: 736, height: 526 };
  const residence: ShowResidencePolicy = {
    horizontalOverscanScreens: 0.35, verticalOverscanScreens: 0.35
  };
  controller.reconcile({ x: 0, y: 0 }, viewport, 1, residence);
  const initialKey = controller.snapshot().cards.find((card) => card.column === 0)?.key;
  assert.ok(initialKey);

  for (let step = 1; step <= 2_000; step += 1) {
    controller.reconcile(
      { x: step * 1_000, y: step * 3 },
      viewport,
      1,
      residence
    );
    const snapshot = controller.snapshot();
    assert.ok(snapshot.activeColumns < 32);
    assert.ok(snapshot.cards.length < 320);
    assert.equal(pool.snapshot().active, snapshot.cards.length);
  }

  controller.reconcile({ x: 0, y: 0 }, viewport, 1, residence);
  const reentryKey = controller.snapshot().cards.find((card) => card.column === 0)?.key;
  assert.ok(reentryKey);
  assert.notEqual(reentryKey, initialKey);
});
test("[Web/展映] 展映窗口清空时释放全部卡位与 DTO 强引用", () => {
  const pool = new ShowDataPool(300);
  pool.add(showImages(300));
  const controller = new ShowWindowController(pool);
  controller.reconcile(
    { x: 0, y: 0 },
    { width: 736, height: 526 },
    1,
    { horizontalOverscanScreens: 0.35, verticalOverscanScreens: 0.35 }
  );
  assert.ok(pool.snapshot().active > 0);
  const unconsumed = pool.snapshot().available;
  controller.clear();
  assert.equal(controller.snapshot().cards.length, 0);
  assert.deepEqual(pool.snapshot(), { active: 0, available: unconsumed, retained: 300 });
  pool.clear();
  assert.deepEqual(pool.snapshot(), { active: 0, available: 0, retained: 0 });
});

test("[Web/展映] 首批向上选档，驻留容量释放后继续接收新候选", async (t) => {
  for (const [required, expected] of [[1, 200], [200, 200], [201, 500], [500, 500], [501, 800], [900, 800]]) {
    assert.equal(imageBatchTier(required!, [200, 500, 800]), expected);
  }
  assert.equal(showInitialBatchLimit({ width: 1440, height: 900, mode: "waterfall", columns: 40, floatSizeIndex: 0, device: "pc" }), 800);
  const h = await createConfigStreamHarness(t);
  const { useShowData } = await import("../../../packages/web/src/pages/show/useShowData.ts");
  let current!: ReturnType<typeof useShowData>;
  function Probe() { current = useShowData(emptyGalleryFilters, "capacity", "latest", 800); return null; }
  const images = showImages(1600);
  await h.render(h.React.createElement(Probe));
  assert.equal(new URL(h.pending[0]!.path, "https://img.example").searchParams.get("limit"), "800");
  await h.respond(0, { items: images.slice(0, 800), next_cursor: "800" });
  await h.React.act(async () => current.loadMore());
  assert.equal(h.pending.length, 1, "容量不足时不能提前推进游标");
  for (let offset = 800; offset < 1600; offset += 100) {
    const active = current.images.slice(0, 10);
    await h.React.act(async () => current.loadMore({
      dataKey: current.committedKey, activeIds: active.map(x => x.id),
      consumedIds: current.images.map(x => x.id), available: 0, capacity: 800
    }));
    const index: number = h.pending.length - 1;
    const params: URLSearchParams = new URL(h.pending[index]!.path, "https://img.example").searchParams;
    assert.equal(params.get("limit"), "100");
    assert.equal(params.get("cursor"), String(offset));
    await h.respond(index, { items: images.slice(offset, offset + 100), next_cursor: offset + 100 < 1600 ? String(offset + 100) : null });
    assert.ok(current.images.length <= 800);
    assert.ok(active.every(item => current.images.includes(item)), "当前屏内引用保持稳定");
    assert.ok(current.images.some(item => item.id === images[offset + 99]!.id));
  }
});

test("[Web/展映] 重复候选补取有界，日界过期后显式重试从首批开始", async (t) => {
  const h = await createConfigStreamHarness(t);
  const { useShowData } = await import("../../../packages/web/src/pages/show/useShowData.ts");
  let current!: ReturnType<typeof useShowData>;
  function Probe() { current = useShowData(emptyGalleryFilters, "random", "random"); return null; }
  const images = showImages(3);
  const original = structuredClone(images);
  await h.render(h.React.createElement(Probe));
  await h.respond(0, { items: images, next_cursor: "1" });
  assert.deepEqual(images, original, "洗牌只改变页面批次副本");
  assert.deepEqual(new Set(current.images.map(x => x.id)), new Set(images.map(x => x.id)));
  await h.React.act(async () => current.loadMore());
  for (let index = 1; index <= 4; index++) await h.respond(index, { items: images, next_cursor: String(index + 1) });
  assert.ok(current.error);
  await h.React.act(async () => { for (let i = 0; i < 10; i++) current.loadMore(); });
  assert.equal(h.pending.length, 5);
  await h.React.act(async () => current.retry());
  await h.respond(5, { error: "expired", code: "cursor_expired" }, 409);
  const round = current.committedKey;
  await h.React.act(async () => current.retry());
  assert.equal(new URL(h.pending[6]!.path, "https://img.example").searchParams.get("cursor"), null);
  await h.respond(6, { items: images, next_cursor: null });
  assert.notEqual(current.committedKey, round);
  await h.React.act(async () => current.loadMore({ dataKey: current.committedKey, activeIds: [], consumedIds: images.map(x => x.id), available: 0, capacity: 800 }));
  assert.equal(h.pending.length, 7, "有限小池本地复用，无首批网络循环");
});

test("[Web/展映] 编辑与删除在途替换仍能提交当前排序", async (t) => {
  for (const operation of ["update", "remove"] as const) await t.test(operation, async (t) => {
    const h = await createConfigStreamHarness(t, { honorAbort: false });
    const { useShowData } = await import("../../../packages/web/src/pages/show/useShowData.ts");
    let current!: ReturnType<typeof useShowData>;
    function Probe({ order }: { order: "latest" | "oldest" }) { current = useShowData(emptyGalleryFilters, order, order); return null; }
    await h.render(h.React.createElement(Probe, { order: "latest" }));
    await h.respond(0, { items: showImages(3), next_cursor: "next" });
    await h.render(h.React.createElement(Probe, { order: "oldest" }));
    const id = current.images[0]!.id;
    await h.React.act(async () => {
      if (operation === "update") current.updateImage(editableImage(id, { title: "confirmed" }));
      else current.removeImage(id);
    });
    assert.equal(h.pending[1]!.signal?.aborted, true);
    await h.respond(1, { items: showImages(2), next_cursor: "stale" });
    await h.respond(2, { items: showImages(4), next_cursor: null });
    assert.equal(current.committedOrder, "oldest");
    assert.equal(current.initialLoading, false);
    if (operation === "update") assert.equal(current.images.find(x => x.id === id)?.title, "confirmed");
    else assert.equal(current.images.length, 3);
  });
});

test("[Web/展映] 不同图片操作保留各自尚未完成的确认回读", async (t) => {
  for (const operation of ["update", "remove", "refresh"] as const) await t.test(operation, async (t) => {
    const h = await createConfigStreamHarness(t, { honorAbort: false });
    const { useShowData } = await import("../../../packages/web/src/pages/show/useShowData.ts");
    let current!: ReturnType<typeof useShowData>;
    function Probe() { current = useShowData(emptyGalleryFilters, "latest", "latest"); return null; }
    const images = showImages(3);
    await h.render(h.React.createElement(Probe));
    await h.respond(0, { items: images, next_cursor: null });
    await h.React.act(async () => current.refreshImage(images[0]!.id));
    await h.React.act(async () => {
      if (operation === "update") current.updateImage(editableImage(images[1]!.id, { ...images[1]!, title: "B" }));
      else if (operation === "remove") current.removeImage(images[1]!.id);
      else current.refreshImage(images[1]!.id);
    });
    assert.equal(h.pending[1]!.signal?.aborted, false);
    await h.respond(1, { items: [{ ...images[0]!, title: "A refreshed" }, ...images.slice(1)], next_cursor: null });
    assert.equal(current.images.find(x => x.id === images[0]!.id)?.title, "A refreshed");
  });
});

test("[Web/展映] 漂浮候选耗尽时删除当前图仍释放卡片与可访问项", (t) => {
  const h = createFloatSceneHarness(t, { count: 80, hasMore: true, sizeIndex: 0 });
  const id = h.visibleItems()[0]!.image.id;
  h.scene.setImages(showImages(80).filter(x => x.id !== id), "desktop-float", "latest", true);
  h.advance(20);
  assert.ok(h.visibleItems().every(item => item.image.id !== id));
  assert.ok(h.visibleItems().length > 0);
});
