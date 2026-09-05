import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { useSearchParams } from "react-router";
import type {
  ShowDensity,
  ShowOrder,
  SiteShowSettings
} from "@imageshow/shared/browser";
import { AppLoadingRegion } from "../../../components/feedback/AppLoadingScreen.js";
import { DialogFrame } from "../../../components/feedback/DialogFrame.js";
import { QueryErrorState } from "../../../components/feedback/QueryErrorState.js";
import { PublicImageDetail } from "../../../components/image/PublicImageDetail.js";
import { AppHeader } from "../../../components/navigation/AppHeader.js";
import { PublicImageToolbar } from "../../../components/navigation/PublicImageToolbar.js";
import { useDocumentMotionPause } from "../../../hooks/useDocumentMotionPause.js";
import { useMediaQuery } from "../../../hooks/useMediaQuery.js";
import { usePublicImageViewportControls } from "../../../hooks/usePublicImageViewportControls.js";
import { usePublicNavigationEntrance } from "../../../hooks/usePublicNavigationEntrance.js";
import { useGalleryFacets } from "../../../lib/api/site-data.js";
import {
  emptyGalleryFilters,
  galleryFiltersFromSearchParams,
  galleryRandomRequestDevice,
  showModeFromSearchParams,
  showOrderFromSearchParams,
  showRouteSearchParams,
  type GalleryFilters
} from "../../../lib/gallery/gallery-query.js";
import { buildRandomUrl } from "../../../lib/gallery/random-url.js";
import type { GalleryImageCard } from "../../../lib/types.js";
import { publicNavigationAutoHideDelayMs } from "../../../lib/ui/public-navigation.js";
import { ShowControls } from "../ShowControls.js";
import type { ShowImage } from "../show-layout.js";
import { useShowData } from "../useShowData.js";
import {
  clampShowFloatSizeIndex,
  clampShowWaterfallColumns,
  defaultShowFloatSizeIndex,
  largerShowWaterfallImages,
  showFloatSizeSteps,
  showWaterfallDensity,
  smallerShowWaterfallImages,
  type ShowWaterfallDensity
} from "./show-pixi-layout.js";
import { ShowPixiStage } from "./ShowPixiStage.js";
import type { ShowPixiSceneKind } from "./show-pixi-types.js";
import "../../../styles/public-core.css";
import "../../../styles/gallery.css";
import "../../../styles/gallery-responsive.css";
import "../../../styles/show.css";
import "../../../styles/show-pixi.css";

function imageDetailCard(image: ShowImage): GalleryImageCard {
  return {
    id: image.id,
    title: image.title?.trim() ?? "",
    device: image.device,
    brightness: image.brightness,
    theme: image.theme,
    author: image.author?.trim() ?? "",
    thumb_url: image.thumb_url,
    width: image.width,
    height: image.height,
    tags: image.tags,
    diff_original: image.diff_original === true,
    image_time: image.image_time
  };
}

function configuredWaterfallColumns(
  density: ShowWaterfallDensity,
  configured: ShowDensity
) {
  if (configured === "relaxed") return density.minimumColumns;
  if (configured === "dense") return density.normalMaximumColumns;
  return density.defaultColumns;
}

function configuredFloatSize(configured: ShowDensity) {
  if (configured === "relaxed") return showFloatSizeSteps.length - 1;
  if (configured === "dense") return 0;
  return defaultShowFloatSizeIndex;
}

function remapWaterfallColumns(
  columns: number,
  previous: ShowWaterfallDensity,
  next: ShowWaterfallDensity
) {
  if (Math.abs(columns - previous.minimumColumns) < 0.01) return next.minimumColumns;
  if (Math.abs(columns - previous.defaultColumns) < 0.01) return next.defaultColumns;
  if (Math.abs(columns - previous.normalMaximumColumns) < 0.01) {
    return next.normalMaximumColumns;
  }
  if (Math.abs(columns - previous.maximumColumns) < 0.01) return next.maximumColumns;
  return clampShowWaterfallColumns(
    columns / previous.galleryColumns * next.galleryColumns,
    next
  );
}

export function ShowPixiPage({
  embedded = false,
  settings
}: {
  embedded?: boolean;
  settings: SiteShowSettings;
}) {
  const [routeSearchParams, setRouteSearchParams] = useSearchParams();
  const routeQuery = routeSearchParams.toString();
  const filters = useMemo(
    () => galleryFiltersFromSearchParams(new URLSearchParams(routeQuery)),
    [routeQuery]
  );
  const order = useMemo(() => showOrderFromSearchParams(
    new URLSearchParams(routeQuery),
    settings.order
  ), [routeQuery, settings.order]);
  const configuredScene = settings.mode;
  const scene = useMemo(() => showModeFromSearchParams(
    new URLSearchParams(routeQuery),
    configuredScene
  ), [configuredScene, routeQuery]);
  const sourceKey = useMemo(
    () => showRouteSearchParams(filters, order).toString(),
    [filters, order]
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const initialWaterfallDensity = showWaterfallDensity(window.innerWidth);
  const [waterfallColumns, setWaterfallColumns] = useState(() => (
    configuredWaterfallColumns(initialWaterfallDensity, settings.density)
  ));
  const [floatSizeIndex, setFloatSizeIndex] = useState(() => (
    configuredFloatSize(settings.density)
  ));
  const [running, setRunning] = useState(settings.autoplay);
  const [motionActive, setMotionActive] = useState(false);
  const [pendingWaterfallDensity, setPendingWaterfallDensity] = useState<number | null>(null);
  const waterfallDensityConfirmedRef = useRef(false);
  const densityCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<GalleryImageCard | null>(null);
  const densityWarningOpen = pendingWaterfallDensity !== null;
  const dialogOpen = Boolean(selected) || densityWarningOpen;
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const decreaseButtonRef = useRef<HTMLButtonElement | null>(null);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const { data: facets } = useGalleryFacets();
  const data = useShowData(filters, sourceKey, order);
  const playbackRunning = running && !data.initialLoading && !data.error
    && data.images.length > 0;
  const {
    advanceManualNavigation,
    filterPanelHidden,
    filterPanelRef,
    filterMenuDismissSignal,
    filterToggleRef,
    clearFiltersRef,
    dismissFilterMenus,
    filtersOpen,
    headerVisible,
    onHeaderMenuExpandedChange,
    resetManualNavigation,
    toggleFilters,
    toolbarHeight,
    toolbarRef,
    toolbarVisible
  } = usePublicImageViewportControls({
    autoHideAfterMs: playbackRunning && !reducedMotion && motionActive
      ? publicNavigationAutoHideDelayMs
      : undefined,
    headerPresent: !embedded,
    paused: dialogOpen,
    movement: "manual"
  });
  const {
    markAppeared: markNavigationAppeared,
    shouldAnimate: shouldAnimateNavigation
  } = usePublicNavigationEntrance();
  useDocumentMotionPause();

  const openImageDetail = useCallback((image: ShowImage, opener: HTMLElement) => {
    detailReturnFocusRef.current = opener;
    setSelected(imageDetailCard(image));
  }, []);

  useLayoutEffect(() => {
    markNavigationAppeared();
  }, [markNavigationAppeared]);

  useLayoutEffect(() => {
    if (!densityWarningOpen) return;
    // The modal makes the canvas inert, so zoom gestures would otherwise fall
    // through to browser zoom. Keep this guard through the closing animation,
    // including gestures that started on the canvas before the warning opened.
    const preventZoom = (event: Event) => {
      if (event.cancelable) event.preventDefault();
    };
    const preventWheelZoom = (event: WheelEvent) => {
      if (event.ctrlKey) preventZoom(event);
    };
    const preventTouchZoom = (event: TouchEvent) => {
      if (event.touches.length > 1) preventZoom(event);
    };
    const options = { capture: true, passive: false } as const;
    window.addEventListener("wheel", preventWheelZoom, options);
    window.addEventListener("touchstart", preventTouchZoom, options);
    window.addEventListener("touchmove", preventTouchZoom, options);
    window.addEventListener("gesturestart", preventZoom, options);
    window.addEventListener("gesturechange", preventZoom, options);
    return () => {
      window.removeEventListener("wheel", preventWheelZoom, true);
      window.removeEventListener("touchstart", preventTouchZoom, true);
      window.removeEventListener("touchmove", preventTouchZoom, true);
      window.removeEventListener("gesturestart", preventZoom, true);
      window.removeEventListener("gesturechange", preventZoom, true);
    };
  }, [densityWarningOpen]);

  useEffect(() => {
    resetManualNavigation();
  }, [resetManualNavigation, sourceKey]);

  useEffect(() => {
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      setViewportWidth(window.innerWidth);
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);

  const waterfallDensity = useMemo(
    () => showWaterfallDensity(viewportWidth),
    [viewportWidth]
  );
  const previousWaterfallDensityRef = useRef(waterfallDensity);
  const requestWaterfallColumns = useCallback((columns: number) => {
    const next = clampShowWaterfallColumns(columns, waterfallDensity);
    if (!waterfallDensityConfirmedRef.current && next > waterfallDensity.warningColumns + 0.001) {
      setPendingWaterfallDensity((pending) => pending ?? next / waterfallDensity.galleryColumns);
      setWaterfallColumns(waterfallDensity.warningColumns);
      return waterfallDensity.warningColumns;
    }
    setWaterfallColumns(next);
    return next;
  }, [waterfallDensity]);
  useEffect(() => {
    const previous = previousWaterfallDensityRef.current;
    previousWaterfallDensityRef.current = waterfallDensity;
    if (previous.galleryColumns === waterfallDensity.galleryColumns) return;
    setWaterfallColumns((current) => remapWaterfallColumns(
      current,
      previous,
      waterfallDensity
    ));
  }, [waterfallDensity]);

  const setShowSearch = (
    nextFilters: GalleryFilters,
    nextOrder: ShowOrder
  ) => setRouteSearchParams(showRouteSearchParams(
    nextFilters,
    nextOrder,
    routeSearchParams.has("mode") ? scene : undefined
  ));
  const getShowModeHref = (nextScene: ShowPixiSceneKind) => {
    const params = new URLSearchParams(routeSearchParams);
    params.set("mode", nextScene);
    return `?${params.toString()}`;
  };
  const updateFilter = (key: keyof GalleryFilters, value: string) => {
    setShowSearch({ ...filters, [key]: value }, order);
  };
  const clearFilters = () => {
    if (!Object.values(filters).some(Boolean)) return;
    setShowSearch(emptyGalleryFilters, order);
  };
  const randomUrl = buildRandomUrl({
    origin: window.location.origin,
    device: galleryRandomRequestDevice(filters.device),
    brightness: filters.brightness || "random",
    theme: filters.theme,
    tag: filters.tag,
    author: filters.author
  });
  const floatSizeDescription = `当前尺寸档位 ${floatSizeIndex + 1}/${showFloatSizeSteps.length}`;
  const waterfallSizeDescription = `当前约 ${Number.isInteger(waterfallColumns)
    ? waterfallColumns
    : waterfallColumns.toFixed(1)} 列`;
  const smallerDisabled = scene === "waterfall"
    ? waterfallColumns >= waterfallDensity.maximumColumns - 0.001
    : floatSizeIndex <= 0;
  const largerDisabled = scene === "waterfall"
    ? waterfallColumns <= waterfallDensity.minimumColumns + 0.001
    : floatSizeIndex >= showFloatSizeSteps.length - 1;

  return (
    <main
      className={`page gallery-page show-page show-pixi-page${embedded ? " is-embedded" : ""}`}
      data-show-renderer="pixi"
      data-show-navigation-visible={headerVisible || toolbarVisible}
      style={{
        "--gallery-toolbar-height": toolbarHeight
          ? `${toolbarHeight}px`
          : undefined
      } as CSSProperties}
    >
      <div className="public-navigation-frame">
        <div className="public-navigation-stack">
          {!embedded && (
            <AppHeader
              animateEntrance={shouldAnimateNavigation}
              onMenuExpandedChange={onHeaderMenuExpandedChange}
              visible={headerVisible}
            />
          )}
          <PublicImageToolbar
            animateEntrance={shouldAnimateNavigation}
            filters={filters}
            facets={facets}
            randomUrl={randomUrl}
            filtersOpen={filtersOpen}
            filterPanelHidden={filterPanelHidden}
            filterMenuDismissSignal={filterMenuDismissSignal}
            toolbarVisible={toolbarVisible}
            toolbarRef={toolbarRef}
            filterToggleRef={filterToggleRef}
            clearFiltersRef={clearFiltersRef}
            filterPanelRef={filterPanelRef}
            toggleFilters={toggleFilters}
            dismissFilterMenus={dismissFilterMenus}
            onFilterChange={updateFilter}
            onClearFilters={clearFilters}
          />
        </div>
      </div>
      <ShowPixiStage
        dataKey={data.committedKey}
        dialogOpen={dialogOpen}
        floatSizeIndex={floatSizeIndex}
        images={data.images}
        onColumnsChange={requestWaterfallColumns}
        onFloatSizeIndexChange={(index) => {
          const next = clampShowFloatSizeIndex(index);
          setFloatSizeIndex(next);
          return next;
        }}
        onManualVerticalMovement={advanceManualNavigation}
        onMotionActiveChange={setMotionActive}
        onNeedImages={data.loadMore}
        onOpen={openImageDetail}
        order={data.committedOrder}
        reducedMotion={reducedMotion}
        running={playbackRunning}
        scene={scene}
        speed={settings.drift_speed}
        waterfallColumns={waterfallColumns}
      >
        <p className="show-interaction-hint">
          <span className="show-interaction-hint-pointer">
            {scene === "waterfall"
              ? "拖动平移；滚轮纵移；Ctrl + 滚轮或双指缩放"
              : "上下拖动或滚轮纵移；Ctrl + 滚轮调整尺寸"}
          </span>
          <span className="show-interaction-hint-touch">
            {scene === "waterfall"
              ? "拖动平移；点按 ± 或双指缩放"
              : "上下拖动；点按 ± 调整尺寸"}
          </span>
        </p>
        <ShowControls
          decreaseButtonRef={decreaseButtonRef}
          largerDisabled={largerDisabled}
          onDecreaseSize={() => {
            if (scene === "float") {
              setFloatSizeIndex((current) => clampShowFloatSizeIndex(current - 1));
              return;
            }
            const next = smallerShowWaterfallImages(
              waterfallColumns,
              waterfallDensity
            );
            requestWaterfallColumns(next);
          }}
          onIncreaseSize={() => {
            if (scene === "float") {
              setFloatSizeIndex((current) => clampShowFloatSizeIndex(current + 1));
              return;
            }
            requestWaterfallColumns(largerShowWaterfallImages(
              waterfallColumns,
              waterfallDensity
            ));
          }}
          onOrderChange={(nextOrder) => setShowSearch(filters, nextOrder)}
          onReset={() => {
            if (scene === "waterfall") {
              setWaterfallColumns(waterfallDensity.defaultColumns);
            } else {
              setFloatSizeIndex(defaultShowFloatSizeIndex);
            }
          }}
          onRunningChange={setRunning}
          getSceneHref={getShowModeHref}
          order={order}
          reducedMotion={reducedMotion}
          running={running && !reducedMotion}
          scene={scene}
          sizeDescription={scene === "waterfall"
            ? waterfallSizeDescription
            : floatSizeDescription}
          smallerDisabled={smallerDisabled}
        />
        {data.initialLoading && (
          <AppLoadingRegion className="show-loading" extraDots={3} />
        )}
        {Boolean(data.error) && !data.initialLoading && (
          <div className="show-query-state">
            <QueryErrorState error={data.error} onRetry={data.retry} />
          </div>
        )}
        {!data.error && !data.initialLoading && !data.images.length && (
          <p className="show-empty">暂无图片</p>
        )}
      </ShowPixiStage>
      {pendingWaterfallDensity !== null && (
        <DialogFrame
          className="modal show-density-dialog"
          titleId="show-density-warning-title"
          descriptionId="show-density-warning-description"
          initialFocusRef={densityCancelButtonRef}
          returnFocusRef={decreaseButtonRef}
          onClose={() => setPendingWaterfallDensity(null)}
        >
          {({ requestClose }) => (
            <article>
              <h2 id="show-density-warning-title">性能提示</h2>
              <p id="show-density-warning-description">
                继续显示更多图片会占用更多内存和 GPU，<br />
                可能会<strong>卡顿掉帧</strong>。
              </p>
              <footer>
                <button ref={densityCancelButtonRef} type="button" onClick={() => requestClose()}>取消</button>
                <button type="button" onClick={() => requestClose(() => {
                  waterfallDensityConfirmedRef.current = true;
                  setWaterfallColumns(clampShowWaterfallColumns(
                    pendingWaterfallDensity * waterfallDensity.galleryColumns,
                    waterfallDensity
                  ));
                  setPendingWaterfallDensity(null);
                })}>继续</button>
              </footer>
            </article>
          )}
        </DialogFrame>
      )}
      {selected && (
        <PublicImageDetail
          card={selected}
          onClose={() => setSelected(null)}
          onTrashCommitted={(imageId) => {
            const fallback = [...document.querySelectorAll<HTMLElement>(
              "[data-show-pixi-proxy]"
            )].find((element) => element.dataset.imageId !== imageId);
            detailReturnFocusRef.current = fallback ?? null;
            data.removeImage(imageId);
          }}
          onItemUpdated={data.refreshImages}
          onItemRefreshRequested={data.refreshImages}
          returnFocusRef={detailReturnFocusRef}
        />
      )}
    </main>
  );
}
