import {
  readableFilterSearch,
  type ShowClusterGroup,
  type ShowDensity,
  type ShowOrder,
  type SiteShowSettings
} from "@imageshow/shared/browser";
import { useImageBrowseRoute } from "../../hooks/useImageBrowseRoute.js";
import { usePublicFilterDialog } from "../../hooks/usePublicFilterDialog.js";
import { PublicFilterDialog } from "../../components/image/filter/PublicFilterDialog.js";
import { PublicFilterErrorState } from "../../components/feedback/PublicFilterErrorState.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import { reducedMotionQuery } from "../../lib/ui/reduced-motion.js";
import { AppLoadingRegion } from "../../components/feedback/AppLoadingScreen.js";
import { DialogFrame } from "../../components/dialog/DialogFrame.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { PublicImageDetail } from "../../components/image/PublicImageDetail.js";
import { PublicImageNavigation } from "../../components/navigation/PublicImageNavigation.js";
import { useDocumentMotionPause } from "../../hooks/useDocumentMotionPause.js";
import { useMediaQuery } from "../../hooks/useMediaQuery.js";
import { usePublicImageViewportControls } from "../../hooks/usePublicImageViewportControls.js";
import { usePublicNavigationEntrance } from "../../hooks/usePublicNavigationEntrance.js";
import {
  imageBrowseApiSearchParams,
  showClusterGroupFromSearchParams,
  showModeFromSearchParams,
  showOrderFromSearchParams,
  updateImageBrowseSearchParams
} from "../../lib/gallery/gallery-query.js";
import { publicNavigationAutoHideDelayMs } from "../../lib/ui/public-navigation.js";
import {
  ShowClusterGroupControl,
  ShowPlaybackButton,
  ShowMobileControls,
  ShowSizeControls,
  ShowToolbarControls,
  showClusterGroupLabels
} from "./ShowControls.js";
import type { ShowImage } from "./show-layout.js";
import { useShowClusters } from "./useShowClusters.js";
import { useShowData } from "./useShowData.js";
import { showInitialBatchLimit } from "./show-browse.js";
import {
  clampShowFloatSizeIndex,
  clampShowWaterfallColumns,
  defaultShowFloatSizeIndex,
  largerShowWaterfallImages,
  showFloatSizeSteps,
  showWaterfallDensity,
  smallerShowWaterfallImages,
  type ShowWaterfallDensity
} from "./pixi/show-pixi-layout.js";
import { ShowPixiStage, type ShowPixiStageHandle } from "./pixi/ShowPixiStage.js";
import type { ShowClusterFocus } from "./pixi/show-pixi-cluster-scene.js";
import type { ShowPixiSceneKind } from "./pixi/show-pixi-types.js";
import "../../styles/public-core.css";
import "../../styles/gallery.css";
import "../../styles/gallery-responsive.css";
import "../../styles/show.css";
import "../../styles/show-pixi.css";

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

export function ShowPage({
  embedded = false,
  settings
}: {
  embedded?: boolean;
  settings: SiteShowSettings;
}) {
  const browseRoute = useImageBrowseRoute();
  const filterDialog = usePublicFilterDialog(browseRoute);
  const {
    params: routeSearchParams,
    updateSearchParams: setRouteSearchParams,
    filters,
    updateFilter,
    ready: filtersReady,
    error: filterError
  } = browseRoute;
  const routeQuery = routeSearchParams.toString();
  const order = useMemo(
    () => showOrderFromSearchParams(
      new URLSearchParams(routeQuery),
      settings.order
    ),
    [routeQuery, settings.order]
  );
  const configuredScene = settings.mode;
  const scene = useMemo(
    () => showModeFromSearchParams(
      new URLSearchParams(routeQuery),
      configuredScene
    ),
    [configuredScene, routeQuery]
  );
  // 星群按分类聚成星团，不叠加访客筛选；它的数据由 useShowClusters 负责，展映的单一图片流停用。
  const clusterMode = scene === "cluster";
  const clusterGroup = useMemo(
    () => showClusterGroupFromSearchParams(new URLSearchParams(routeQuery)),
    [routeQuery]
  );
  const sourceKey = useMemo(
    () =>
      filtersReady
        ? readableFilterSearch(
            imageBrowseApiSearchParams(filters, order, {
              view: "show",
              userAgent: window.navigator.userAgent
            })
          )
        : routeQuery,
    [filters, filtersReady, order, routeQuery]
  );
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const initialWaterfallDensity = showWaterfallDensity(window.innerWidth);
  const [waterfallColumns, setWaterfallColumns] = useState(() =>
    configuredWaterfallColumns(initialWaterfallDensity, settings.density)
  );
  const [floatSizeIndex, setFloatSizeIndex] = useState(() => configuredFloatSize(settings.density));
  const [running, setRunning] = useState(settings.autoplay);
  const [motionActive, setMotionActive] = useState(false);
  const [pendingWaterfallDensity, setPendingWaterfallDensity] = useState<number | null>(null);
  const waterfallDensityConfirmedRef = useRef(false);
  const densityCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const [selected, setSelected] = useState<ShowImage | null>(null);
  const densityWarningOpen = pendingWaterfallDensity !== null;
  const dialogOpen = Boolean(selected) || densityWarningOpen || filterDialog.active;
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const sizeControlRef = useRef<HTMLButtonElement | null>(null);
  const stageRef = useRef<ShowPixiStageHandle | null>(null);
  const [clusterFocus, setClusterFocus] = useState<ShowClusterFocus | null>(null);
  // 点按进入星团后导航自动隐藏，与自动播放时一致；回到星群或以其他方式进入时恢复原有规则。
  const [clusterClicked, setClusterClicked] = useState(false);
  const reducedMotion = useMediaQuery(reducedMotionQuery);
  const data = useShowData(
    filters,
    sourceKey,
    order,
    showInitialBatchLimit({
      width: window.innerWidth,
      height: window.innerHeight,
      mode: scene,
      columns: waterfallColumns,
      floatSizeIndex,
      device: filters.device
    }),
    filtersReady && !clusterMode
  );
  const clusterData = useShowClusters(clusterGroup, order, clusterMode);
  const clusterImages = useMemo(
    () => clusterData.clusters.flatMap((cluster) => cluster.images),
    [clusterData.clusters]
  );
  const browseImages = clusterMode ? clusterImages : data.images;
  const playbackRunning = running && (clusterMode
    ? clusterImages.length > 0
    : !data.initialLoading && !data.error && data.images.length > 0);
  const navigationControls = usePublicImageViewportControls({
    autoHideAfterMs:
      (playbackRunning && !reducedMotion && motionActive) || (clusterFocus && clusterClicked)
        ? publicNavigationAutoHideDelayMs
        : undefined,
    headerPresent: !embedded,
    paused: dialogOpen,
    movement: "manual"
  });
  const {
    advanceManualNavigation,
    headerVisible,
    resetManualNavigation,
    toolbarHeight,
    toolbarVisible
  } = navigationControls;
  const { markAppeared: markNavigationAppeared, shouldAnimate: shouldAnimateNavigation } =
    usePublicNavigationEntrance();
  useDocumentMotionPause();

  const openImageDetail = useCallback((image: ShowImage, opener: HTMLElement) => {
    detailReturnFocusRef.current = opener;
    setSelected(image);
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
    // 离开星群或换了一组星群后，场景从总览重新开始。
    setClusterFocus(null);
  }, [clusterMode, clusterData.dataKey]);

  const clusterFocused = clusterFocus !== null;
  // Esc 与“回到星群”按钮是访客明确要回到总览：带出导航，分组、排序与画面切换都在那里；
  // 已在总览时按 Esc 同样带出导航。滚轮缩放与双指缩回星群时由场景收放导航，± 按钮缩放不改变导航。
  const exitCluster = useCallback(() => {
    if (clusterFocused) stageRef.current?.clusterCommand({ type: "exit" });
    resetManualNavigation();
  }, [clusterFocused, resetManualNavigation]);

  useEffect(() => {
    if (!clusterMode || dialogOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      // 打开着的菜单与输入框自己处理这些按键。
      if (
        document.querySelector(
          '.public-gallery-menu, .show-mobile-flyout-options, .public-navigation-stack [aria-expanded="true"]'
        ) ||
        (event.target instanceof HTMLElement && event.target.closest("input, textarea, select"))
      )
        return;
      if (event.key === "Escape") exitCluster();
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
        stageRef.current?.clusterCommand({ type: "step", direction: -1 });
      else if (event.key === "ArrowRight" || event.key === "ArrowDown")
        stageRef.current?.clusterCommand({ type: "step", direction: 1 });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clusterMode, dialogOpen, exitCluster]);

  useEffect(() => {
    if (selected) {
      const updated = browseImages.find((image) => image.id === selected.id);
      if (updated && updated !== selected) setSelected(updated);
    }
    if (
      !selected ||
      browseImages.some((image) => image.id === selected.id) ||
      !detailReturnFocusRef.current?.matches("[data-show-pixi-proxy]")
    )
      return;
    const fallback = [...document.querySelectorAll<HTMLElement>("[data-show-pixi-proxy]")].find(
      (element) => element.dataset.imageId !== selected.id
    );
    detailReturnFocusRef.current =
      fallback
        ?? document.querySelector<HTMLElement>(".show-pixi-canvas-host");
  }, [browseImages, selected]);

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
  const requestWaterfallColumns = useCallback(
    (columns: number) => {
      const next = clampShowWaterfallColumns(columns, waterfallDensity);
      if (!waterfallDensityConfirmedRef.current && next > waterfallDensity.warningColumns + 0.001) {
        setPendingWaterfallDensity((pending) => pending ?? next / waterfallDensity.galleryColumns);
        setWaterfallColumns(waterfallDensity.warningColumns);
        return waterfallDensity.warningColumns;
      }
      setWaterfallColumns(next);
      return next;
    },
    [waterfallDensity]
  );
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

  const changeOrder = (nextOrder: ShowOrder) =>
    setRouteSearchParams((current) =>
      updateImageBrowseSearchParams(current, { order: nextOrder })
    );
  const getShowModeHref = (nextScene: ShowPixiSceneKind) => {
    const params = updateImageBrowseSearchParams(routeSearchParams, { mode: nextScene });
    return `?${readableFilterSearch(params)}`;
  };
  const getClusterGroupHref = (group: ShowClusterGroup) => {
    const params = updateImageBrowseSearchParams(routeSearchParams, { group });
    return `?${readableFilterSearch(params)}`;
  };
  const floatSizeDescription = `当前尺寸档位 ${floatSizeIndex + 1}/${showFloatSizeSteps.length}`;
  const waterfallSizeDescription = `当前约 ${
    Number.isInteger(waterfallColumns)
      ? waterfallColumns
      : waterfallColumns.toFixed(1)
  } 列`;
  const smallerDisabled =
    scene === "waterfall"
      ? waterfallColumns >= waterfallDensity.maximumColumns - 0.001
      : scene === "float"
        ? floatSizeIndex <= 0
        : !clusterFocus;
  const largerDisabled =
    scene === "waterfall"
      ? waterfallColumns <= waterfallDensity.minimumColumns + 0.001
      : scene === "float"
        ? floatSizeIndex >= showFloatSizeSteps.length - 1
        : clusterImages.length === 0;
  const pointerHint =
    scene === "waterfall"
      ? "拖动平移；滚轮纵移，Shift + 滚轮横移；Ctrl + 滚轮或双指缩放"
      : scene === "float"
        ? "上下拖动或滚轮纵移；Ctrl + 滚轮调整尺寸"
        : clusterFocus
          ? "拖动或 Shift + 滚轮旋转；滚轮缩放，缩到最小回到星群；方向键切换星团"
          : "拖动或 Shift + 滚轮转动星群；点击星团或滚轮放大进入";
  const touchHint =
    scene === "waterfall"
      ? "拖动平移；点按 ± 或双指缩放"
      : scene === "float"
        ? "上下拖动；点按 ± 调整尺寸"
        : clusterFocus
          ? "拖动旋转；双指缩放，缩到最小回到星群"
          : "拖动转动星群；点按星团进入";

  return (
    <main
      className={`page gallery-page show-page show-pixi-page${embedded ? " is-embedded" : ""}`}
      data-show-renderer="pixi"
      data-show-navigation-visible={headerVisible || toolbarVisible}
      data-public-navigation-visible={headerVisible || toolbarVisible}
      style={
        {
          "--gallery-toolbar-height": toolbarHeight
            ? `${toolbarHeight}px`
            : undefined
        } as CSSProperties
      }
    >
      <PublicImageNavigation
        floatingControlsHidden={dialogOpen}
        mobileTrailingControls={
          <ShowMobileControls
            scene={scene}
            getSceneHref={getShowModeHref}
            order={order}
            onOrderChange={changeOrder}
            onRunningChange={setRunning}
            reducedMotion={reducedMotion}
            running={running && !reducedMotion}
          />
        }
        embedded={embedded}
        animateEntrance={shouldAnimateNavigation}
        route={browseRoute}
        controls={navigationControls}
        filterDialog={filterDialog}
        order={order}
        mode={scene}
        group={clusterMode ? clusterGroup : undefined}
        onOrderChange={changeOrder}
        filterControls={
          clusterMode ? (
            <ShowClusterGroupControl group={clusterGroup} getGroupHref={getClusterGroupHref} />
          ) : undefined
        }
        summary={
          !clusterMode
            ? undefined
            : clusterFocus
              ? `${clusterFocus.name} · ${clusterFocus.total} 张`
              : `按${showClusterGroupLabels[clusterGroup]}分组`
        }
        viewControls={
          <>
            <ShowToolbarControls scene={scene} getSceneHref={getShowModeHref} />
            <ShowPlaybackButton
              onRunningChange={setRunning}
              reducedMotion={reducedMotion}
              running={running && !reducedMotion}
            />
          </>
        }
        leadingControls={
          <ShowSizeControls
            sizeControlRef={sizeControlRef}
            largerDisabled={largerDisabled}
            smallerDisabled={smallerDisabled}
            resetDisabled={clusterMode && !clusterFocus}
            labels={
              clusterMode
                ? {
                    group: "星群缩放",
                    decrease: "缩小；缩到最小回到星群",
                    increase: clusterFocus ? "放大" : "进入屏幕中间的星团",
                    reset: "回到星群"
                  }
                : undefined
            }
            sizeDescription={
              scene === "waterfall" ? waterfallSizeDescription : floatSizeDescription
            }
            onDecreaseSize={() => {
              if (scene === "cluster")
                stageRef.current?.clusterCommand({ type: "zoom", direction: -1 });
              else if (scene === "float")
                setFloatSizeIndex((current) => clampShowFloatSizeIndex(current - 1));
              else
                requestWaterfallColumns(
                  smallerShowWaterfallImages(waterfallColumns, waterfallDensity)
                );
            }}
            onIncreaseSize={() => {
              if (scene === "cluster")
                stageRef.current?.clusterCommand({ type: "zoom", direction: 1 });
              else if (scene === "float")
                setFloatSizeIndex((current) => clampShowFloatSizeIndex(current + 1));
              else
                requestWaterfallColumns(
                  largerShowWaterfallImages(waterfallColumns, waterfallDensity)
                );
            }}
            onReset={() => {
              if (scene === "cluster") exitCluster();
              else if (scene === "waterfall") setWaterfallColumns(waterfallDensity.defaultColumns);
              else setFloatSizeIndex(defaultShowFloatSizeIndex);
            }}
          />
        }
      />
      <ShowPixiStage
        controlRef={stageRef}
        clusters={clusterData.clusters}
        clusterDataKey={clusterData.dataKey}
        onClusterFocusChange={(focus, entry) => {
          setClusterFocus(focus);
          if (!focus) setClusterClicked(false);
          else if (entry) setClusterClicked(entry === "click");
        }}
        onNeedClusterImages={clusterData.needImages}
        dataKey={data.committedKey}
        dialogOpen={dialogOpen}
        floatSizeIndex={floatSizeIndex}
        images={data.images}
        hasMore={data.hasMore}
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
        <p className="show-interaction-hint public-floating-label">
          <span className="show-interaction-hint-pointer">{pointerHint}</span>
          <span className="show-interaction-hint-touch">{touchHint}</span>
        </p>
        {clusterMode && clusterData.loading && (
          <AppLoadingRegion className="show-loading" extraDots={3} />
        )}
        {clusterMode && Boolean(clusterData.error) && (
          <div className="show-query-state">
            <QueryErrorState error={clusterData.error} onRetry={clusterData.retry} />
          </div>
        )}
        {clusterMode && !clusterData.loading && !clusterData.error
          && !clusterImages.length && <p className="show-empty">暂无图片</p>}
        {!clusterMode && Boolean(filterError) && (
          <div className="show-query-state">
            <PublicFilterErrorState
              error={filterError}
              onClear={(field) => updateFilter(field, "")}
              onRetry={browseRoute.retryVocabulary}
            />
          </div>
        )}
        {!clusterMode && !filterError && (!filtersReady || data.initialLoading) && (
          <AppLoadingRegion className="show-loading" extraDots={3} />
        )}
        {!clusterMode && filtersReady && Boolean(data.error) && !data.initialLoading && (
          <div className="show-query-state">
            <QueryErrorState error={data.error} onRetry={data.retry} />
          </div>
        )}
        {!clusterMode && filtersReady && !data.error && !data.initialLoading
          && !data.images.length && <p className="show-empty">暂无图片</p>}
      </ShowPixiStage>
      {filterDialog.session && (
        <PublicFilterDialog
          filters={filterDialog.session.filters}
          unresolvedTags={filterDialog.session.unresolvedTags}
          unresolvedSelectors={filterDialog.session.unresolvedSelectors}
          facets={browseRoute.facets}
          facetsLoading={browseRoute.facetsLoading}
          facetsError={browseRoute.facetsError}
          retryVocabulary={browseRoute.retryVocabulary}
          returnFocusRef={filterDialog.triggerRef}
          onClose={filterDialog.close}
          onApply={filterDialog.applyAfterClose}
          view="show"
        />
      )}
      {pendingWaterfallDensity !== null && (
        <DialogFrame
          className="modal show-density-dialog"
          titleId="show-density-warning-title"
          descriptionId="show-density-warning-description"
          initialFocusRef={densityCancelButtonRef}
          returnFocusRef={sizeControlRef}
          onClose={() => setPendingWaterfallDensity(null)}
        >
          {({ requestClose }) => (
            <article>
              <h2 id="show-density-warning-title">性能提示</h2>
              <p id="show-density-warning-description">
                增加同屏图片数量对设备性能要求较高，
                <br />
                在部分设备上可能会出现<strong>卡顿、掉帧</strong>现象。
                <br />请<strong>谨慎考虑</strong>后决定是否继续。
              </p>
              <footer>
                <button ref={densityCancelButtonRef} type="button" onClick={() => requestClose()}>
                  取消
                </button>
                <button
                  type="button"
                  onClick={() =>
                    requestClose(() => {
                      waterfallDensityConfirmedRef.current = true;
                      setWaterfallColumns(
                        clampShowWaterfallColumns(
                          pendingWaterfallDensity * waterfallDensity.galleryColumns,
                          waterfallDensity
                        )
                      );
                      setPendingWaterfallDensity(null);
                    })
                  }
                >
                  继续
                </button>
              </footer>
            </article>
          )}
        </DialogFrame>
      )}
      {selected && (
        <PublicImageDetail
          view="show"
          card={selected}
          onClose={() => setSelected(null)}
          onTrashCommitted={(imageId) => {
            if (clusterMode) clusterData.removeImage(imageId);
            else data.removeImage(imageId);
          }}
          onItemUpdated={clusterMode ? clusterData.updateImage : data.updateImage}
          onItemRefreshRequested={clusterMode ? clusterData.refreshImage : data.refreshImage}
          returnFocusRef={detailReturnFocusRef}
        />
      )}
    </main>
  );
}
