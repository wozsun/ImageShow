import { readableFilterSearch } from "@imageshow/shared/browser";
import { useImageBrowseRoute } from "../../hooks/useImageBrowseRoute.js";
import { TagFilterErrorState } from "../../components/feedback/TagFilterErrorState.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from "react";
import type { GalleryOrder } from "@imageshow/shared/browser";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigationType } from "react-router";
import { Icon } from "../../components/icon/Icon.js";
import { PublicStarfield } from "../../components/layout/PublicStarfield.js";
// 当前详情共享 JS + CSS 实测压缩后不足 6 KiB；画廊首击直接使用，继续随路由
// 加载可避免新增请求和 Suspense 边界。
import { PublicImageDetail } from "../../components/image/PublicImageDetail.js";
import { PublicImageOrderButton } from "../../components/navigation/PublicImageOrderButton.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import {
  createGalleryTaxonomyDisplayFormatter
} from "../../lib/gallery/card-display.js";
import type { GalleryImageCard } from "../../lib/types.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import {
  AppLoadingRegion
} from "../../components/feedback/AppLoadingScreen.js";
import { pageScrollRestoredEvent } from "../../hooks/usePageScrollLock.js";
import { useDocumentMotionPause } from "../../hooks/useDocumentMotionPause.js";
import { usePublicNavigationEntrance } from "../../hooks/usePublicNavigationEntrance.js";
import {
  useGalleryColumnCount,
  useGalleryGeometry
} from "./gallery-layout.js";
import { GalleryImageRuntime } from "./GalleryImageRuntime.js";
import { GalleryVirtualWindow } from "./GalleryVirtualWindow.js";
import {
  scrollPublicImagePageToTop,
  usePublicImageViewportControls
} from "../../hooks/usePublicImageViewportControls.js";
import {
  imageBrowseApiSearchParams,
  updateImageBrowseSearchParams,
  showOrderFromSearchParams
} from "../../lib/gallery/gallery-query.js";
import { GalleryCardRevealRegistry } from "./gallery-card-reveal.js";
import { PublicImageNavigation } from "../../components/navigation/PublicImageNavigation.js";
import { useGalleryDataWindow } from "./useGalleryDataWindow.js";
import "../../styles/public-core.css";
import "../../styles/gallery.css";
import "../../styles/gallery-responsive.css";

export function GalleryPage({
  embedded = false,
  order: defaultOrder
}: {
  embedded?: boolean;
  order: GalleryOrder;
}) {
  const [selected, setSelected] = useState<GalleryImageCard | null>(null);
  const [pinnedImageId, setPinnedImageId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { key: navigationKey } = useLocation();
  const navigationType = useNavigationType();
  const browseRoute = useImageBrowseRoute();
  const {
    params: routeSearchParams,
    updateSearchParams: setRouteSearchParams,
    facets,
    filters,
    updateFilter,
    ready: filtersReady,
    error: filterError
  } = browseRoute;
  const order = showOrderFromSearchParams(routeSearchParams, defaultOrder);
  const navigationControls = usePublicImageViewportControls({
    headerPresent: !embedded,
    paused: Boolean(selected)
  });
  const { backToTopVisible, headerVisible, toolbarHeight, toolbarVisible } = navigationControls;
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const trashedFocusIdRef = useRef<string | null>(null);
  const galleryRef = useRef<HTMLElement | null>(null);
  const galleryWindowRef = useRef<HTMLDivElement | null>(null);
  const previousImageQueryRef = useRef<string | null>(null);
  const routeEntranceFinishedRef = useRef(false);
  const {
    markAppeared: markNavigationAppeared,
    shouldAnimate: shouldAnimateNavigation
  } = usePublicNavigationEntrance();
  const cardSubtitle = useMemo(
    () => {
      const display = createGalleryTaxonomyDisplayFormatter(facets);
      return (card: GalleryImageCard) => display(card).subtitle;
    },
    [facets]
  );

  const userAgent = window.navigator.userAgent;
  const imageQuery = useMemo(
    () => filtersReady
      ? readableFilterSearch(imageBrowseApiSearchParams(filters, order, { userAgent, view: "gallery" }))
      : readableFilterSearch(routeSearchParams),
    [filters, filtersReady, routeSearchParams, order, userAgent]
  );
  const revealRegistry = useMemo(
    () => new GalleryCardRevealRegistry({
      routeEntrance: !routeEntranceFinishedRef.current
    }),
    [imageQuery]
  );
  useDocumentMotionPause();

  useEffect(() => {
    routeEntranceFinishedRef.current = true;
  }, []);

  useLayoutEffect(() => {
    markNavigationAppeared();
  }, [markNavigationAppeared]);

  useEffect(() => {
    const previous = previousImageQueryRef.current;
    previousImageQueryRef.current = imageQuery;
    if (previous !== null && previous !== imageQuery) {
      const previousKey = [...queryKeys.publicImages, previous];
      void queryClient.cancelQueries({
        queryKey: previousKey,
        exact: false
      });
      queryClient.removeQueries({
        queryKey: previousKey,
        exact: false
      });
      window.scrollTo({ top: 0 });
    }
  }, [imageQuery, queryClient]);

  const columnCount = useGalleryColumnCount();
  const geometry = useGalleryGeometry(galleryRef);
  const galleryData = useGalleryDataWindow({
    geometry: { ...geometry, columnCount },
    geometryReady: geometry.measured && filtersReady,
    imageQuery,
    navigationKey,
    preserveEquivalentQuery: browseRoute.isFilterEdit,
    restorePosition: navigationType === "POP",
    pinnedImageId,
    windowRef: galleryWindowRef
  });
  useEffect(() => {
    if (!selected) return;
    const refreshed = galleryData.positions.find(
      (position) => position.id === selected.id
    )?.item;
    if (refreshed && refreshed !== selected) setSelected(refreshed);
  }, [galleryData.positions, selected]);
  const initialLoading = !filterError && (!filtersReady || galleryData.initialLoading);
  const nextPageLoading = filtersReady && galleryData.nextPageLoading;
  const loading = initialLoading || nextPageLoading;
  const showBackToTop = backToTopVisible && !selected;

  const openDetail = useCallback((
    card: GalleryImageCard,
    opener: HTMLButtonElement
  ) => {
    detailReturnFocusRef.current = opener;
    setPinnedImageId(card.id);
    setSelected(card);
  }, []);
  const handleGalleryImageTrashed = () => {
    // 原按钮会随查询重排卸载，不让通用弹窗焦点恢复抓住已脱离 DOM 的节点。
    detailReturnFocusRef.current = null;
    setPinnedImageId(trashedFocusIdRef.current);
    trashedFocusIdRef.current = null;
  };

  useEffect(() => {
    if (!pinnedImageId) return;
    let focusFrame: number | undefined;
    let releaseFrame: number | undefined;
    let settleFrame: number | undefined;
    const releasePinnedOpener = () => {
      const opener = detailReturnFocusRef.current;
      focusFrame = window.requestAnimationFrame(() => {
        focusFrame = undefined;
        const fallback = Array.from(
          galleryWindowRef.current?.querySelectorAll<HTMLButtonElement>(
            ".gallery-virtual-tile[data-image-id]"
          ) ?? []
        ).find((button) => button.dataset.imageId === pinnedImageId);
        const focusTarget = opener?.isConnected ? opener : fallback;
        if (focusTarget) {
          const targetRect = focusTarget.getBoundingClientRect();
          if (
            targetRect.bottom <= 0
            || targetRect.top >= window.innerHeight
          ) {
            focusTarget.scrollIntoView({ block: "nearest" });
          }
          focusTarget.focus({ preventScroll: true });
        }
        releaseFrame = window.requestAnimationFrame(() => {
          releaseFrame = undefined;
          settleFrame = window.requestAnimationFrame(() => {
            settleFrame = undefined;
            setPinnedImageId((current) => (
              current === pinnedImageId ? null : current
            ));
            if (detailReturnFocusRef.current === opener) {
              detailReturnFocusRef.current = null;
            }
          });
        });
      });
    };
    window.addEventListener(pageScrollRestoredEvent, releasePinnedOpener);
    return () => {
      window.removeEventListener(pageScrollRestoredEvent, releasePinnedOpener);
      if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
      if (releaseFrame !== undefined) window.cancelAnimationFrame(releaseFrame);
      if (settleFrame !== undefined) window.cancelAnimationFrame(settleFrame);
    };
  }, [pinnedImageId]);

  return (
    <GalleryImageRuntime
      dataWindowMetrics={galleryData.debugMetrics}
      detailOpen={Boolean(selected)}
      resetKey={imageQuery}
    >
      <main
        className={`page gallery-page${embedded ? " is-embedded" : ""}`}
        style={{
          "--gallery-toolbar-height": toolbarHeight
            ? `${toolbarHeight}px`
            : undefined
        } as CSSProperties}
      >
        <span className="gallery-atmosphere" aria-hidden="true" />
        <div className="gallery-starfield" aria-hidden="true">
          <PublicStarfield />
        </div>
        <PublicImageNavigation
          embedded={embedded}
          animateEntrance={shouldAnimateNavigation}
          route={browseRoute}
          controls={navigationControls}
        />
        <div className="gallery-toolbar-spacer" aria-hidden="true" />
        <section ref={galleryRef} className="gallery">
          <GalleryVirtualWindow
            cardSubtitle={cardSubtitle}
            imageQuery={imageQuery}
            onOpen={openDetail}
            onIntrinsicSize={galleryData.reportIntrinsicSize}
            positions={filtersReady ? galleryData.positions : []}
            revealRegistry={revealRegistry}
            totalHeight={filtersReady ? galleryData.snapshot.totalHeight : 0}
            windowRef={galleryWindowRef}
          />
        </section>
        {Boolean(filterError) && (
          <div className="gallery-query-error">
            <TagFilterErrorState error={filterError} onClear={() => updateFilter("tag", "")} onRetry={browseRoute.retryVocabulary} />
          </div>
        )}
        {filtersReady && galleryData.snapshot.error && (
          <div className={`gallery-query-error${galleryData.snapshot.errorRequest?.kind === "hydrate"
              ? " gallery-window-error"
              : ""
            }`}>
            <QueryErrorState
              error={galleryData.snapshot.error}
              onRetry={galleryData.retry}
            />
          </div>
        )}
        {filtersReady && !galleryData.snapshot.error
          && !loading
          && galleryData.snapshot.compactItems === 0
          && <p className="gallery-empty">暂无图片</p>}
        {initialLoading && (
          <AppLoadingRegion
            className="gallery-initial-loading"
            extraDots={3}
          />
        )}
        {nextPageLoading && <p className="gallery-loading">加载中</p>}
        <div className="gallery-floating-controls public-floating-controls"
          data-public-navigation-visible={headerVisible || toolbarVisible}
          hidden={Boolean(selected)}>
          <button
            type="button"
            className={`public-round-control pressable gallery-back-to-top${showBackToTop ? " is-visible" : ""}`}
            aria-label="回到顶部"
            aria-hidden={!showBackToTop}
            inert={!showBackToTop}
            title="回到顶部"
            onClick={(event) => {
              event.currentTarget.blur();
              scrollPublicImagePageToTop();
            }}
          >
            <span className="public-round-surface"><Icon name="arrow-up-line" /></span>
          </button>
          <PublicImageOrderButton order={order}
            onChange={(next) => setRouteSearchParams((current) => updateImageBrowseSearchParams(current, { order: next }))} />
        </div>
        {selected && (
          <PublicImageDetail
            card={selected}
            onClose={() => setSelected(null)}
            onTrashCommitted={async (imageId) => {
              const result = await galleryData.removeImage(imageId);
              trashedFocusIdRef.current = result.focusId;
            }}
            onTrashed={handleGalleryImageTrashed}
            onItemUpdated={galleryData.refreshImage}
            onItemRefreshRequested={galleryData.refreshImage}
            returnFocusRef={detailReturnFocusRef}
          />
        )}
      </main>
    </GalleryImageRuntime>
  );
}
