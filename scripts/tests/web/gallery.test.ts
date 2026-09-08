import "../support/web-environment.ts";
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseHTML
} from "linkedom";
import {
  galleryResidenceBufferScreens,
  galleryVirtualOverscanScreens
} from "../../../packages/web/src/lib/constants.ts";
import {
  createGalleryTaxonomyDisplayFormatter
} from "../../../packages/web/src/lib/gallery/card-display.ts";
import {
  boundedHomeRevealIndexes,
  homeRevealItemLimits,
  homeThemesWithUnsetLast
} from "../../../packages/web/src/pages/home/home-ui.ts";
import {
  galleryColumnCount
} from "../../../packages/web/src/lib/gallery/gallery-columns.ts";
import {
  advancePublicImageNavigation,
  initialPublicImageNavigationState
} from "../../../packages/web/src/lib/ui/public-image-navigation-visibility.ts";
import {
  CompactMasonryLayout
} from "../../../packages/web/src/pages/gallery/compact-masonry-layout.ts";
import {
  GalleryDataWindow
} from "../../../packages/web/src/pages/gallery/gallery-data-window.ts";
import {
  createGalleryRenderViewport,
  galleryRenderViewportHysteresisScreens,
  shouldRefreshGalleryRenderViewport
} from "../../../packages/web/src/pages/gallery/gallery-render-viewport.ts";
import {
  GalleryCardRevealRegistry
} from "../../../packages/web/src/pages/gallery/gallery-card-reveal.ts";
import {
  imageDisplayTitle
} from "../../../packages/web/src/lib/ui/formatters.ts";
import {
  GalleryDebugStats
} from "../../../packages/web/src/pages/gallery/gallery-debug-stats.ts";
import {
  ImageLoadScheduler
} from "../../../packages/web/src/components/image/image-load-scheduler.ts";
import {
  galleryCardDto,
  galleryCard,
  syntheticGalleryPage,
  resolveGalleryIntent,
  createConfigStreamHarness,
  editableImage
} from "../support/web-test-context.ts";
import { installProperties } from "../support/property-descriptors.ts";
import { galleryInitialBatchLimit } from "../../../packages/web/src/pages/gallery/gallery-images-query.ts";
import {
  activateGalleryRestorationSession
} from "../../../packages/web/src/pages/gallery/gallery-restoration.ts";

test("[Web/画廊] 首页目录、瀑布流、分页预载与滚动导航组成完整公开浏览流程", () => {
  const none = { slug: "none", image_count: 7 };
  const portrait = { slug: "portrait", image_count: 4 };
  const stage = { slug: "stage", image_count: 3 };
  assert.deepEqual(
    homeThemesWithUnsetLast([none, portrait, stage]).map(({ slug }) => slug),
    ["portrait", "stage", "none"]
  );
  const revealItems = Array.from({ length: 40 }, (_, index) => ({
    slug: "item-" + index,
    image_count: index % 3 === 0 ? 0 : index + 1
  }));
  const reveals = boundedHomeRevealIndexes(
    revealItems,
    new Set(["item-0"]),
    false,
    homeRevealItemLimits.tags
  );
  assert.equal(reveals.size, homeRevealItemLimits.tags);
  assert.equal(reveals.get("item-0"), 0);
  assert.equal(reveals.has("item-3"), false);

  assert.equal(galleryColumnCount(359), 1);
  assert.equal(galleryColumnCount(360), 2);
  assert.equal(galleryColumnCount(761), 3);
  assert.equal(galleryColumnCount(1920), 5);
  assert.equal(galleryColumnCount(3840), 8);

  const layout = new CompactMasonryLayout({
    contentWidth: 210,
    gap: 10,
    columnCount: 2
  });
  for (let index = 0; index < 4; index += 1) layout.append(1);
  assert.deepEqual(
    Array.from({ length: 4 }, (_, index) => {
      const position = layout.position(index)!;
      return { index, x: position.x, y: position.y };
    }),
    [
      { index: 0, x: 0, y: 0 },
      { index: 1, x: 110, y: 0 },
      { index: 2, x: 0, y: 110 },
      { index: 3, x: 110, y: 110 }
    ]
  );
  assert.deepEqual(
    layout.windowIndexes({ start: 105, end: 215 }),
    [2, 3]
  );

  const dataWindow = new GalleryDataWindow({
    geometry: { contentWidth: 210, gap: 10, columnCount: 2 }
  });
  const viewport = {
    start: 0,
    end: 400,
    visibleStart: 0,
    visibleEnd: 200,
    preloadEnd: 1_000
  };
  const [initialIntent] = dataWindow.updateViewport(viewport, null);
  assert.deepEqual(initialIntent, { cursor: "", kind: "initial" });
  resolveGalleryIntent(dataWindow, initialIntent!, syntheticGalleryPage({
    count: 2,
    start: 0,
    total: 4
  }));
  const appendIntent = dataWindow.updateViewport(viewport, null)
    .find(({ kind }) => kind === "append");
  assert.deepEqual(appendIntent, { cursor: "cursor-2", kind: "append" });
  resolveGalleryIntent(dataWindow, appendIntent!, syntheticGalleryPage({
    count: 2,
    start: 2,
    total: 4
  }));
  assert.deepEqual(
    dataWindow.windowPositions({
      ...viewport,
      pinnedId: null
    }).map(({ id }) => id),
    syntheticGalleryPage({ count: 4, start: 0, total: 4 })
      .items.map(({ id }) => id)
  );

  const hidden = advancePublicImageNavigation(initialPublicImageNavigationState, {
    delta: 100,
    headerPresent: true,
    scrollTop: 240,
    toolbarHeight: 140,
    lockedOpen: false
  });
  assert.equal(hidden.stage, "hidden");
  assert.deepEqual(advancePublicImageNavigation(hidden, {
    delta: -100,
    headerPresent: true,
    scrollTop: 140,
    toolbarHeight: 140,
    lockedOpen: false
  }), initialPublicImageNavigationState);
});
test("[Web/画廊] 画廊渲染窗口只在半屏边界重定位并覆盖图片驻留区", () => {
  const viewportHeight = 800;
  const initial = createGalleryRenderViewport(0, viewportHeight);
  assert.deepEqual(initial, {
    start: 0,
    end: 3_200,
    visibleStart: 0,
    visibleEnd: 800,
    preloadEnd: 1_600
  });
  assert.equal(
    shouldRefreshGalleryRenderViewport(initial, 399, viewportHeight),
    false
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(initial, 400, viewportHeight),
    true
  );

  const deep = createGalleryRenderViewport(1_600, viewportHeight);
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 1_201, viewportHeight),
    false
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 1_200, viewportHeight),
    true
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 1_999, viewportHeight),
    false
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 2_000, viewportHeight),
    true
  );
  assert.equal(
    shouldRefreshGalleryRenderViewport(deep, 1_600, 799),
    true
  );
  assert.ok(
    galleryVirtualOverscanScreens - galleryRenderViewportHysteresisScreens
      > galleryResidenceBufferScreens
  );
});
test("[Web/画廊] 画廊标题只使用标题或 UUID 后十二位", () => {
  const card = galleryCard("019ffefe-24d8-7d83-9ae1-12e720b651c9");
  assert.equal(imageDisplayTitle({ ...card, title: "  已命名图片  " }), "已命名图片");
  assert.equal(imageDisplayTitle({ ...card, title: "" }), "#12e720b651c9");
  const decoratedCard = {
    ...card,
    title: "",
    theme: "night",
    tags: ["blue", "stars"]
  };
  assert.equal(imageDisplayTitle(decoratedCard), "#12e720b651c9");
});
test("[Web/画廊] 公开列表 slug 复用 facets 生成卡片与详情显示值", () => {
  const item = {
    ...galleryCardDto("00000000-0000-7000-8000-000000000001"),
    theme: "night",
    tags: ["blue", "stars"]
  };
  const display = createGalleryTaxonomyDisplayFormatter({
    themes: [{ slug: "night", display_name: "夜景" }],
    tags: [
      { slug: "blue", display_name: "蓝色" },
      { slug: "stars", display_name: "星空" }
    ]
  });
  assert.deepEqual(display(item), {
    themeLabel: "夜景",
    tagLabels: ["蓝色", "星空"],
    subtitle: "夜景 · 蓝色/星空"
  });
  assert.equal("subtitle" in item, false);
  assert.deepEqual(createGalleryTaxonomyDisplayFormatter(undefined)({
    theme: "none",
    tags: ["blue"]
  }), {
    themeLabel: "未设置",
    tagLabels: ["blue"],
    subtitle: "blue"
  });
});
test("[Web/画廊] 画廊数据窗口在 1 千、1 万和 5 万张长会话中保持有界", () => {
  const pageSize = 60;
  const compactBudgets = new Map([
    [1_000, 512 * 1024],
    [10_000, 2 * 1024 * 1024],
    [50_000, 8 * 1024 * 1024]
  ]);

  for (const total of compactBudgets.keys()) {
    const dataWindow = new GalleryDataWindow({
      geometry: { contentWidth: 1_600, gap: 16, columnCount: 5 },
      fullItemBudget: 480
    });
    for (let start = 0; start < total; start += pageSize) {
      const cursor = start === 0 ? "" : `cursor-${start}`;
      resolveGalleryIntent(dataWindow, {
        cursor,
        kind: start === 0 ? "initial" : "append"
      }, syntheticGalleryPage({ count: pageSize, start, total }));
      const totalHeight = dataWindow.snapshot().totalHeight;
      dataWindow.updateViewport({
        start: Math.max(0, totalHeight - 3_200),
        end: totalHeight,
        visibleStart: Math.max(0, totalHeight - 900),
        visibleEnd: totalHeight,
        preloadEnd: totalHeight + 1_800
      }, null);
    }

    const snapshot = dataWindow.snapshot();
    assert.equal(snapshot.compactItems, total);
    assert.ok(snapshot.fullItems <= 480, `${total}: full DTO budget`);
    assert.ok(snapshot.retainedPages <= 8, `${total}: retained page budget`);
    assert.ok(
      snapshot.estimatedCompactBytes <= compactBudgets.get(total)!,
      `${total}: compact index budget`
    );
    assert.ok(
      snapshot.estimatedFullDtoBytes < 1024 * 1024,
      `${total}: retained DTO bytes`
    );
    const tailPositions = dataWindow.windowPositions({
      start: Math.max(0, snapshot.totalHeight - 4_000),
      end: snapshot.totalHeight,
      visibleStart: Math.max(0, snapshot.totalHeight - 900),
      visibleEnd: snapshot.totalHeight,
      pinnedId: null
    });
    assert.ok(tailPositions.length <= 180);
    assert.equal(
      new Set(tailPositions.map(({ id }) => id)).size,
      tailPositions.length
    );
    assert.ok(tailPositions.every(({ item }) => item !== null));

    assert.equal(dataWindow.setGeometry({
      contentWidth: 360,
      gap: 12,
      columnCount: 2
    }), true);
    const mobileSnapshot = dataWindow.snapshot();
    assert.equal(mobileSnapshot.compactItems, total);
    assert.ok(mobileSnapshot.fullItems <= 480);
    assert.ok(
      mobileSnapshot.estimatedCompactBytes <= compactBudgets.get(total)!,
      `${total}: mobile compact index budget`
    );
    assert.ok(dataWindow.windowPositions({
      start: Math.max(0, mobileSnapshot.totalHeight - 4_000),
      end: mobileSnapshot.totalHeight,
      visibleStart: Math.max(0, mobileSnapshot.totalHeight - 900),
      visibleEnd: mobileSnapshot.totalHeight,
      pinnedId: null
    }).length <= 180);
    assert.equal(dataWindow.setGeometry({
      contentWidth: 1_600,
      gap: 16,
      columnCount: 5
    }), true);

    if (total !== 50_000) continue;

    const firstId = syntheticGalleryPage({
      count: pageSize,
      start: 0,
      total
    }).items[0]!.id;
    const pinRequests = dataWindow.updateViewport({
      start: Math.max(0, snapshot.totalHeight - 4_000),
      end: snapshot.totalHeight,
      visibleStart: Math.max(0, snapshot.totalHeight - 900),
      visibleEnd: snapshot.totalHeight,
      preloadEnd: snapshot.totalHeight
    }, firstId);
    const pinnedHydration = pinRequests.find(({ cursor }) => cursor === "");
    assert.deepEqual(pinnedHydration, { cursor: "", kind: "hydrate" });
    resolveGalleryIntent(dataWindow, pinnedHydration!, syntheticGalleryPage({
      count: pageSize,
      start: 0,
      total
    }));
    assert.ok(dataWindow.snapshot().fullItems <= 480 + pageSize);

    dataWindow.updateViewport({
      start: Math.max(0, snapshot.totalHeight - 4_000),
      end: snapshot.totalHeight,
      visibleStart: Math.max(0, snapshot.totalHeight - 900),
      visibleEnd: snapshot.totalHeight,
      preloadEnd: snapshot.totalHeight
    }, null);
    const returnRequests = dataWindow.updateViewport({
      start: 0,
      end: 4_000,
      visibleStart: 0,
      visibleEnd: 900,
      preloadEnd: 2_000
    }, null);
    const firstPageHydration = returnRequests.find(({ cursor }) => cursor === "");
    assert.deepEqual(firstPageHydration, { cursor: "", kind: "hydrate" });
    const shuffledFirstPage = syntheticGalleryPage({
      count: pageSize,
      start: 0,
      total
    });
    shuffledFirstPage.items.reverse();
    resolveGalleryIntent(dataWindow, firstPageHydration!, shuffledFirstPage);
    const returnedPositions = dataWindow.windowPositions({
      start: 0,
      end: 4_000,
      visibleStart: 0,
      visibleEnd: 900,
      pinnedId: null
    });
    assert.equal(returnedPositions[0]?.id, firstId);
    assert.notEqual(returnedPositions[0]?.item, null);
    assert.equal(
      dataWindow.updateViewport({
        start: 0,
        end: 4_000,
        visibleStart: 0,
        visibleEnd: 900,
        preloadEnd: 2_000
      }, null).some(({ cursor }) => cursor === ""),
      false
    );

    const beforeResize = dataWindow.positionForId(firstId)!;
    assert.equal(dataWindow.setGeometry({
      contentWidth: 360,
      gap: 12,
      columnCount: 2
    }), true);
    const afterResize = dataWindow.positionForId(firstId)!;
    assert.equal(beforeResize.index, afterResize.index);
    assert.notEqual(beforeResize.width, afterResize.width);

    const secondId = syntheticGalleryPage({
      count: pageSize,
      start: 0,
      total
    }).items[1]!.id;
    const removal = dataWindow.removeImage(firstId);
    assert.deepEqual(removal, {
      removed: true,
      index: 0,
      focusId: secondId
    });
    assert.equal(dataWindow.snapshot().compactItems, total - 1);
    assert.equal(dataWindow.indexOfId(firstId), -1);

    const reveal = new GalleryCardRevealRegistry({
      enteredAt: 0,
      routeEntrance: false
    });
    reveal.markRevealed(total - 1);
    assert.equal(reveal.revealedThroughIndex, total - 1);
    assert.deepEqual(reveal.prepare(10, {
      initialViewport: false,
      now: 10,
      order: 10,
      reduceMotion: false
    }), { variant: "settled", delayMs: 0 });
  }
});
test("[Web/画廊] 画廊窗口在插入改变游标链时废弃迟到页请求", () => {
  const dataWindow = new GalleryDataWindow({
    geometry: { contentWidth: 800, gap: 16, columnCount: 3 },
    fullItemBudget: 120
  });
  for (let start = 0; start < 300; start += 60) {
    resolveGalleryIntent(dataWindow, {
      cursor: start === 0 ? "" : `cursor-${start}`,
      kind: start === 0 ? "initial" : "append"
    }, syntheticGalleryPage({ count: 60, start, total: 300 }));
    const totalHeight = dataWindow.snapshot().totalHeight;
    dataWindow.updateViewport({
      start: Math.max(0, totalHeight - 2_000),
      end: totalHeight,
      visibleStart: Math.max(0, totalHeight - 700),
      visibleEnd: totalHeight,
      preloadEnd: totalHeight
    }, null);
  }

  const topRequests = dataWindow.updateViewport({
    start: 0,
    end: 4_000,
    visibleStart: 0,
    visibleEnd: 700,
    preloadEnd: 1_500
  }, null);
  const firstIntent = topRequests.find(({ cursor }) => cursor === "")!;
  const staleIntent = topRequests.find(({ cursor }) => cursor === "cursor-60")!;
  assert.ok(firstIntent);
  assert.ok(staleIntent);
  const firstRequest = dataWindow.claimRequest(firstIntent)!;
  const staleRequest = dataWindow.claimRequest(staleIntent)!;
  const replacement = syntheticGalleryPage({ count: 60, start: 0, total: 300 });
  replacement.items[0] = galleryCard("00000000-0000-7000-8000-inserted0001");
  replacement.next_cursor = "cursor-authoritative-60";
  assert.equal(dataWindow.resolvePage(firstRequest, replacement), true);
  assert.equal(
    dataWindow.resolvePage(
      staleRequest,
      syntheticGalleryPage({ count: 60, start: 60, total: 300 })
    ),
    false
  );
  assert.equal(dataWindow.snapshot().failedQueryPages, 0);
  assert.equal(dataWindow.snapshot().compactItems, 60);
  assert.deepEqual(
    dataWindow.updateViewport({
      start: 0,
      end: 4_000,
      visibleStart: 0,
      visibleEnd: 700,
      preloadEnd: 10_000
    }, null).find(({ kind }) => kind === "append"),
    { cursor: "cursor-authoritative-60", kind: "append" }
  );
});
test("[Web/画廊] 画廊远页水合失败保留可见错误边界并可恢复", () => {
  const dataWindow = new GalleryDataWindow({
    geometry: { contentWidth: 800, gap: 16, columnCount: 3 },
    fullItemBudget: 60
  });
  for (let start = 0; start < 180; start += 60) {
    resolveGalleryIntent(dataWindow, {
      cursor: start === 0 ? "" : `cursor-${start}`,
      kind: start === 0 ? "initial" : "append"
    }, syntheticGalleryPage({ count: 60, start, total: 180 }));
    const totalHeight = dataWindow.snapshot().totalHeight;
    dataWindow.updateViewport({
      start: Math.max(0, totalHeight - 1_500),
      end: totalHeight,
      visibleStart: Math.max(0, totalHeight - 700),
      visibleEnd: totalHeight,
      preloadEnd: totalHeight
    }, null);
  }

  const topViewport = {
    start: 0,
    end: 1_500,
    visibleStart: 0,
    visibleEnd: 700,
    preloadEnd: 1_500
  };
  const hydrate = dataWindow.updateViewport(topViewport, null)
    .find(({ cursor }) => cursor === "")!;
  assert.deepEqual(hydrate, { cursor: "", kind: "hydrate" });
  const failedRequest = dataWindow.claimRequest(hydrate)!;
  assert.equal(
    dataWindow.rejectPage(failedRequest, new Error("hydrate failed")),
    true
  );
  const failedSnapshot = dataWindow.snapshot();
  assert.equal(failedSnapshot.error?.message, "hydrate failed");
  assert.equal(failedSnapshot.errorRequest?.kind, "hydrate");
  assert.equal(failedSnapshot.errorRequest?.cursor, "");
  assert.equal(failedSnapshot.errorRequest?.top, 0);
  assert.ok((failedSnapshot.errorRequest?.bottom ?? 0) > 0);

  const retry = dataWindow.retryRequest("")!;
  assert.deepEqual(retry, hydrate);
  resolveGalleryIntent(dataWindow, retry, syntheticGalleryPage({
    count: 60,
    start: 0,
    total: 180
  }));
  assert.equal(dataWindow.snapshot().error, null);
  assert.equal(dataWindow.snapshot().errorRequest, null);
  assert.ok(dataWindow.windowPositions({
    ...topViewport,
    pinnedId: null
  }).every(({ item }) => item !== null));
});
test("[Web/画廊] 公共详情保存为目标页建立新权威边界", () => {
  const dataWindow = new GalleryDataWindow({
    geometry: { contentWidth: 800, gap: 16, columnCount: 3 },
    fullItemBudget: 120
  });
  const viewport = {
    start: 0,
    end: 2_000,
    visibleStart: 0,
    visibleEnd: 700,
    preloadEnd: 3_000
  };
  const [initial] = dataWindow.updateViewport(viewport, null);
  resolveGalleryIntent(dataWindow, initial!, syntheticGalleryPage({
    count: 60,
    start: 0,
    total: 120
  }));
  const firstPage = syntheticGalleryPage({ count: 60, start: 0, total: 120 });
  const firstId = firstPage.items[0]!.id;
  const secondId = firstPage.items[1]!.id;
  const before = dataWindow.positionForId(firstId)!;
  const beforeItems = dataWindow.windowPositions({
    ...viewport,
    pinnedId: firstId
  });
  const firstBefore = beforeItems.find(({ id }) => id === firstId)!.item!;
  const secondBefore = beforeItems.find(({ id }) => id === secondId)!.item!;

  const staleAppend = dataWindow.claimRequest({ cursor: "cursor-60", kind: "append" })!;
  const authoritativeSnapshot = editableImage(firstId, {
    title: "saved title",
    theme: "saved-theme",
    author: firstBefore.author,
    tags: ["saved-tag"],
    thumb_url: firstBefore.thumb_url,
    width: 100,
    height: 300,
    device: firstBefore.device,
    brightness: firstBefore.brightness,
    original: "https://example.com/saved.webp",
    object_url: "https://example.com/saved.webp"
  });
  const refreshIntent = dataWindow.prepareImageRefresh(
    firstId,
    authoritativeSnapshot
  );
  assert.equal(refreshIntent, null, "确认快照直接更新卡片，无额外列表请求");
  const immediateItems = dataWindow.windowPositions({
    ...viewport,
    pinnedId: firstId
  });
  const firstImmediate = immediateItems.find(({ id }) => id === firstId)!.item!;
  const secondImmediate = immediateItems.find(({ id }) => id === secondId)!.item!;
  assert.equal(firstImmediate.title, "saved title");
  assert.equal(firstImmediate.theme, "saved-theme");
  assert.deepEqual(firstImmediate.tags, ["saved-tag"]);
  assert.notStrictEqual(firstImmediate, firstBefore);
  assert.strictEqual(secondImmediate, secondBefore);
  assert.notEqual(dataWindow.positionForId(firstId)!.height, before.height);
  assert.equal(
    dataWindow.resolvePage(
      staleAppend,
      syntheticGalleryPage({ count: 60, start: 60, total: 120 })
    ),
    false
  );

  const refreshedPage = syntheticGalleryPage({
    count: 60,
    start: 0,
    total: 120
  });
  refreshedPage.items[0] = {
    ...refreshedPage.items[0]!,
    title: "saved title",
    theme: "saved-theme",
    tags: ["saved-tag"],
    width: 100,
    height: 300
  };
  resolveGalleryIntent(dataWindow, { cursor: "", kind: "hydrate" }, refreshedPage);
  const refreshedPosition = dataWindow.windowPositions({
    ...viewport,
    pinnedId: firstId
  }).find(({ id }) => id === firstId)!;
  assert.equal(refreshedPosition.item?.title, "saved title");
  assert.equal(refreshedPosition.item?.theme, "saved-theme");
  assert.notEqual(refreshedPosition.height, before.height);
  assert.strictEqual(refreshedPosition.item, firstImmediate);
  assert.strictEqual(
    dataWindow.windowPositions({
      ...viewport,
      pinnedId: firstId
    }).find(({ id }) => id === secondId)!.item,
    secondBefore
  );

  const membershipIntent = dataWindow.prepareImageRefresh(secondId)!;
  assert.strictEqual(
    dataWindow.windowPositions({
      ...viewport,
      pinnedId: secondId
    }).find(({ id }) => id === secondId)!.item,
    secondBefore
  );
  const membershipPage = syntheticGalleryPage({
    count: 60,
    start: 0,
    total: 120
  });
  const replacementId = "00000000-0000-7000-8000-filtered0001";
  membershipPage.items[1] = galleryCard(replacementId);
  membershipPage.next_cursor = "cursor-authoritative-60";
  resolveGalleryIntent(dataWindow, membershipIntent, membershipPage);
  assert.equal(dataWindow.indexOfId(secondId), -1);
  assert.ok(dataWindow.indexOfId(replacementId) >= 0);
  assert.equal(dataWindow.snapshot().compactItems, 60);
});
test("[Web/画廊] 画廊图片同节点换源隔离失败与迟到解码并保留驻留取消", async () => {
  const { window, document } = parseHTML('<html><body><div id="root"></div></body></html>');
  const React = await import("react");
  const globals = {
    window, document, React, IS_REACT_ACT_ENVIRONMENT: true,
    navigator: window.navigator, HTMLElement: window.HTMLElement,
    Node: window.Node, Element: window.Element
  };
  const previous = new Map(Object.keys(globals).map((key) => [
    key, Object.getOwnPropertyDescriptor(globalThis, key)
  ]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.assign(window, { innerWidth: 1280, innerHeight: 720, location: new URL("https://img.example.test/gallery") });
  const { GalleryImageVisibilityController } = await import(
    "../../../packages/web/src/pages/gallery/gallery-image-visibility.ts"
  );
  const originalObserve = GalleryImageVisibilityController.prototype.observe;
  let notify!: (visibility: { inViewport: boolean; inLoadRange: boolean; inResidenceRange: boolean }) => void;
  let observations = 0;
  let unobserved = 0;
  GalleryImageVisibilityController.prototype.observe = function (_target, callback) {
    observations += 1;
    notify = callback;
    callback({ inViewport: true, inLoadRange: true, inResidenceRange: true });
    return () => { unobserved += 1; };
  };
  let root: ReturnType<typeof import("react-dom/client")["createRoot"]> | undefined;
  try {
    const { createRoot } = await import("react-dom/client");
    const { GalleryImageRuntime } = await import("../../../packages/web/src/pages/gallery/GalleryImageRuntime.tsx");
    const { LazyGalleryImage } = await import("../../../packages/web/src/pages/gallery/LazyGalleryImage.tsx");
    root = createRoot(document.getElementById("root")!);
    const measurements: Array<{ src: string; width: number; height: number }> = [];
    const render = async (src: string, detailOpen = false, measureIntrinsicSize = false) => React.act(async () => {
      root!.render(React.createElement(GalleryImageRuntime, {
        dataWindowMetrics: null, detailOpen, resetKey: "same-query",
        children: React.createElement(LazyGalleryImage, {
          src, alt: "测试缩略图", width: 800, height: 600, device: "pc",
          measureIntrinsicSize, onIntrinsicSize(width, height) { measurements.push({ src, width, height }); }
        })
      }));
    });
    const image = () => document.querySelector<HTMLImageElement>(".tile-image-shell img");
    const shell = () => document.querySelector<HTMLElement>(".tile-image-shell")!;
    const settle = async (type: "load" | "error") => React.act(async () => {
      assert.ok(image());
      image()!.dispatchEvent(new window.Event(type));
    });
    await render("/a.webp");
    const holder = shell();
    assert.equal(image()?.getAttribute("src"), "/a.webp");
    await settle("error");
    assert.ok(document.querySelector(".tile-image-fallback"));
    await render("/b.webp");
    assert.strictEqual(shell(), holder);
    assert.equal(image()?.getAttribute("src"), "/b.webp", "旧地址失败不得阻止新地址加载");
    assert.equal(document.querySelector(".tile-image-fallback"), null);
    await settle("load");
    assert.ok(shell().classList.contains("loaded"));
    assert.equal(measurements.length, 0);

    await render("/slow.webp", false, true);
    const slowImage = image()!;
    Object.defineProperties(slowImage, {
      naturalWidth: { configurable: true, value: 512 },
      naturalHeight: { configurable: true, value: 341 }
    });
    const decode = Promise.withResolvers<void>();
    Object.defineProperty(slowImage, "decode", { configurable: true, value: () => decode.promise });
    await settle("load");
    await render("/new.webp", false, true);
    assert.strictEqual(image(), slowImage, "正常换源复用最终 img 节点");
    assert.equal(image()?.getAttribute("src"), "/new.webp");
    await React.act(async () => decode.resolve());
    assert.equal(shell().classList.contains("loaded"), false, "旧解码完成不得标记新地址就绪");
    assert.equal(measurements.length, 0, "旧解码结果不能回填新地址的比例");
    await settle("error");
    assert.ok(document.querySelector(".tile-image-fallback"), "新地址失败仍需显示反馈");
    await render("/slow.webp");
    assert.equal(image()?.getAttribute("src"), "/slow.webp", "再次使用旧地址应重新请求");
    const departingImage = image()!;
    await React.act(async () => notify({ inViewport: false, inLoadRange: false, inResidenceRange: false }));
    assert.equal(image(), null);
    assert.equal(departingImage.getAttribute("src"), null);
    await React.act(async () => notify({ inViewport: true, inLoadRange: true, inResidenceRange: true }));
    assert.equal(image()?.getAttribute("src"), "/slow.webp");
    await render("/paused.webp", true);
    assert.equal(image(), null, "详情打开时换源继续遵守画廊暂停");
    await render("/paused.webp", false, true);
    assert.equal(image()?.getAttribute("src"), "/paused.webp");
    Object.defineProperties(image()!, {
      naturalWidth: { configurable: true, value: 512 },
      naturalHeight: { configurable: true, value: 341 }
    });
    await settle("load");
    assert.ok(shell().classList.contains("loaded"));
    assert.deepEqual(measurements, [{ src: "/paused.webp", width: 512, height: 341 }]);
    assert.equal(observations, 1, "换源不能重建共享可见性注册");
    await React.act(async () => root!.unmount());
    root = undefined;
    assert.equal(unobserved, 1);
  } finally {
    if (root) await React.act(async () => root!.unmount());
    GalleryImageVisibilityController.prototype.observe = originalObserve;
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
test("[Web/画廊] 自然尺寸批量回填后远页水合、删除和 resize 继续使用已解析比例", () => {
  const dataWindow = new GalleryDataWindow({
    geometry: { contentWidth: 420, gap: 10, columnCount: 2 }, fullItemBudget: 4
  });
  const page = syntheticGalleryPage({ count: 4, start: 0, total: 12 });
  page.items[0] = galleryCard(page.items[0]!.id, 0, 0);
  page.items[1] = galleryCard(page.items[1]!.id, 0, 0);
  resolveGalleryIntent(dataWindow, { cursor: "", kind: "initial" }, page);
  const [first, second] = page.items;
  let commits = 0;
  dataWindow.subscribe(() => { commits += 1; });
  dataWindow.resolveIntrinsicSizes([
    { id: first!.id, width: 300, height: 600 },
    { id: second!.id, width: 400, height: 300 }
  ]);
  assert.equal(commits, 1);
  const measured = dataWindow.positionForId(first!.id)!;
  assert.equal(measured.height, (measured.width - 2) * 2 + 2);
  assert.equal(dataWindow.needsIntrinsicMeasurement(first!.id), false);
  assert.equal(dataWindow.needsIntrinsicMeasurement(second!.id), false);
  dataWindow.resolveIntrinsicSizes([{ id: first!.id, width: 1, height: 1 }]);
  assert.equal(commits, 1, "已解析结果不会再次提交布局");
  for (const start of [4, 8]) {
    resolveGalleryIntent(dataWindow, { cursor: `cursor-${start}`, kind: "append" }, syntheticGalleryPage({ count: 4, start, total: 12 }));
    const end = dataWindow.snapshot().totalHeight;
    dataWindow.updateViewport({ start: end - 100, end, visibleStart: end - 100, visibleEnd: end, preloadEnd: end }, null);
  }
  assert.equal(dataWindow.hasHydratedItem(first!.id), false);
  resolveGalleryIntent(dataWindow, { cursor: "", kind: "hydrate" }, page);
  assert.equal(dataWindow.positionForId(first!.id)!.height, measured.height);
  dataWindow.removeImage(first!.id);
  dataWindow.setGeometry({ contentWidth: 210, gap: 10, columnCount: 1 });
  const remaining = dataWindow.positionForId(second!.id)!;
  assert.equal(remaining.height, (remaining.width - 2) * 0.75 + 2);
});

test("[Web/画廊] Strict Mode 浏览轮次隔离迟到请求，缺确认时按需验证并显式重试", async (t) => {
  activateGalleryRestorationSession();
  t.after(activateGalleryRestorationSession);
  const h = await createConfigStreamHarness(t, { honorAbort: false });
  t.after(installProperties(h.window, { scrollY: 0, scrollTo() {}, scrollBy() {} }));
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { useGalleryDataWindow } = await import("../../../packages/web/src/pages/gallery/useGalleryDataWindow.ts");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  t.after(() => client.clear());
  let current!: ReturnType<typeof useGalleryDataWindow>;
  function Probe({ order }: { order: string }) {
    const ref = h.React.useRef<HTMLDivElement | null>(null);
    current = useGalleryDataWindow({
      geometry: { contentWidth: 900, columnCount: 3, gap: 12 }, geometryReady: true,
      imageQuery: `view=gallery&order=${order}`, navigationKey: order,
      restorePosition: false, pinnedImageId: null, windowRef: ref
    });
    return h.React.createElement("div", { ref });
  }
  const render = (order: string) => h.render(h.React.createElement(QueryClientProvider, { client },
    h.React.createElement(h.React.StrictMode, null, h.React.createElement(Probe, { order }))));
  await render("latest");
  const first = h.pending.length - 1;
  assert.equal(h.pending[first]!.cache, undefined, "普通 GET 使用浏览器默认缓存");
  assert.equal(new URL(h.pending[first]!.path, "https://img.example").searchParams.get("limit"), "60");
  await render("oldest");
  const replacement = h.pending.length - 1;
  assert.equal(h.pending[first]!.signal?.aborted, true);
  const page = syntheticGalleryPage({ count: 60, start: 0, total: 60 });
  await h.respond(first, page);
  assert.equal(current.snapshot.fullItems, 0);
  await h.respond(replacement, page);
  assert.equal(current.snapshot.fullItems, 60);
  const count = h.pending.length;
  await h.flush();
  assert.equal(h.pending.length, count, "候选足够时停止补充");
  const id = page.items[0]!.id;
  await h.React.act(async () => current.refreshImage(editableImage(id, { ...page.items[0]!, title: "已确认" })));
  await h.flush();
  assert.equal(h.pending.length, count, "确认快照直接发布而无需 GET");
  await h.React.act(async () => current.refreshImage(id));
  await h.flush();
  const validation = h.pending.length - 1;
  assert.equal(h.pending[validation]!.cache, "no-cache");
  await h.respond(validation, { error: "暂时不可用" }, 503);
  assert.ok(current.snapshot.error);
  await h.flush();
  assert.equal(h.pending.length - 1, validation, "失败后等待用户重试");
  await h.React.act(async () => current.retry());
  await h.respond(h.pending.length - 1, { ...page, items: page.items.map(item => item.id === id ? { ...item, title: "最新" } : item) });
  assert.equal(current.snapshot.error, null);
  assert.equal(current.positions.find(item => item.id === id)?.item?.title, "最新");
});

test("[Web/画廊] 画廊调试快照覆盖查询、DTO、紧凑布局、揭示与 JS heap 指标", () => {
  const scheduler = new ImageLoadScheduler(2);
  const debug = new GalleryDebugStats(scheduler);
  debug.updateDataWindow({
    fetchedPages: 834,
    retainedPages: 8,
    queryCachePages: 2,
    compactItems: 50_000,
    fullItems: 480,
    materializedPositions: 180,
    compactLayoutBytes: 1_500_000,
    estimatedCompactBytes: 6_000_000,
    estimatedFullDtoBytes: 400_000
  });
  debug.recordReveal(49_999);
  debug.sampleJsHeap();
  const snapshot = debug.snapshot();
  assert.equal(snapshot.fetchedPages, 834);
  assert.equal(snapshot.retainedPages, 8);
  assert.equal(snapshot.queryCachePages, 2);
  assert.equal(snapshot.compactItems, 50_000);
  assert.equal(snapshot.fullItems, 480);
  assert.equal(snapshot.materializedPositions, 180);
  assert.equal(snapshot.revealHighWater, 49_999);
  assert.ok(
    snapshot.usedJsHeapBytes === null
    || snapshot.usedJsHeapBytes >= 0
  );
  debug.resetDataWindow();
  assert.equal(debug.snapshot().revealHighWater, -1);
  assert.equal(debug.snapshot().compactItems, 0);
  debug.dispose();
});

test("[Web/画廊] 连续保存保留同页独立验证意图，确认卡片优先于迟到批次", () => {
  const window = new GalleryDataWindow({ geometry: { contentWidth: 800, gap: 16, columnCount: 3 } });
  const page = syntheticGalleryPage({ count: 3, start: 0, total: 3 });
  const [a, b] = page.items;
  resolveGalleryIntent(window, { cursor: "", kind: "initial" }, page);
  assert.equal(window.prepareImageRefresh(a!.id, editableImage(a!.id, { title: "A" })), null);
  const pending = window.claimRequest(window.prepareImageRefresh(a!.id)!)!;
  const intent = window.prepareImageRefresh(b!.id, editableImage(b!.id, { title: "B confirmed" }));
  assert.ok(intent);
  assert.equal(window.resolvePage(pending, page), false);
  assert.equal(window.needsValidation(""), true);
  resolveGalleryIntent(window, intent, { ...page, items: page.items.map(item => item.id === a!.id ? { ...item, title: "A refreshed" } : item) });
  const items = window.windowPositions({ start: 0, end: 2000, visibleStart: 0, visibleEnd: 700, pinnedId: a!.id });
  assert.equal(items.find(item => item.id === a!.id)?.item?.title, "A refreshed");
  assert.equal(items.find(item => item.id === b!.id)?.item?.title, "B confirmed");
  assert.equal(window.needsValidation(""), false);
});

test("[Web/画廊] 首批档位估计两屏，续批始终为 60 且原始随机批次保持完整", () => {
  const geometry = { contentWidth: 900, gap: 0, columnCount: 3 };
  const heightPerRow = 300 * 9 / 16;
  assert.equal(galleryInitialBatchLimit(geometry, heightPerRow * 10, "pc"), 60);
  assert.equal(galleryInitialBatchLimit(geometry, heightPerRow * 10 + 1, "pc"), 120);
  assert.equal(galleryInitialBatchLimit(geometry, heightPerRow * 20 + 1, "pc"), 180);
  const window = new GalleryDataWindow({ geometry, initialLimit: 120, randomOrder: true });
  assert.equal(window.pageLimit(""), 120);
  assert.equal(window.pageLimit("continuation"), 60);
  const raw = syntheticGalleryPage({ count: 120, start: 0, total: 120 });
  const original = structuredClone(raw);
  resolveGalleryIntent(window, { cursor: "", kind: "initial" }, raw);
  assert.deepEqual(raw, original);
  assert.equal(window.snapshot().compactItems, 120);
  assert.ok(raw.items.every(item => window.indexOfId(item.id) >= 0));
});
