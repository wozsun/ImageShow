import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject
} from "react";
import {
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import type {
  PublicImageDetailResponseDto
} from "@imageshow/shared/browser";
import { useSearchParams } from "react-router";
import { api } from "../../lib/api/client.js";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import { Icon } from "../../components/icon/Icon.js";
// 当前详情共享 JS + CSS 实测压缩后不足 6 KiB；画廊首击直接使用，继续随路由
// 加载可避免新增请求和 Suspense 边界。
import { ImageDetailModal } from "../../components/image/ImageDetailModal.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { errorMessage } from "../../lib/ui/formatters.js";
import { buildRandomUrl } from "../../lib/gallery/random-url.js";
import {
  createGalleryTaxonomyDisplayFormatter
} from "../../lib/gallery/card-display.js";
import type {
  EditableImageSnapshot,
  GalleryImageCard,
  PublicImageItem
} from "../../lib/types.js";
import { useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
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
import { scrollGalleryToTop, useGalleryViewportControls } from "./useGalleryViewportControls.js";
import {
  galleryApiSearchParams,
  galleryFiltersFromSearchParams,
  galleryRandomRequestDevice,
  galleryRouteSearchParams,
  type GalleryFilters
} from "../../lib/gallery/gallery-query.js";
import { GalleryCardRevealRegistry } from "./gallery-card-reveal.js";
import { GalleryToolbar } from "./GalleryToolbar.js";
import { useGalleryDataWindow } from "./useGalleryDataWindow.js";
import "../../styles/public-core.css";
import "../../styles/gallery.css";
import "../../styles/gallery-responsive.css";

function imagePlaceholder(card: GalleryImageCard): PublicImageItem {
  return {
    ...card,
    description: "",
    object_url: "",
    source: ""
  };
}

function GalleryImageDetail({
  card,
  onClose,
  onTrashCommitted,
  onTrashed,
  onItemUpdated,
  onItemRefreshRequested,
  returnFocusRef,
}: {
  card: GalleryImageCard;
  onClose: () => void;
  onTrashCommitted: (
    imageId: string
  ) => void | Promise<void>;
  onTrashed: (imageId: string) => void;
  onItemUpdated: (item: EditableImageSnapshot) => void;
  onItemRefreshRequested: (imageId: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const placeholder = useMemo(() => imagePlaceholder(card), [card]);
  const [trashCommitted, setTrashCommitted] = useState(false);
  const { data, isPending, isFetching, isError, error, refetch } = useQuery<PublicImageDetailResponseDto>({
    queryKey: [...queryKeys.publicImageDetail, card.id],
    // 详情元数据很小，不把 React StrictMode 的模拟卸载传给 fetch；
    // 重放会继续复用同一 Promise，真正关闭后则立即回收零驻留期查询。
    // 原图请求仍由下方 DOM 图片调度器同步取消和清理。
    queryFn: () => api(`/api/images/${encodeURIComponent(card.id)}`),
    gcTime: 0,
    enabled: !trashCommitted
  });
  const detail = data?.item.id === card.id ? data.item : null;
  const item = useMemo(() => ({ ...placeholder, ...(detail ?? {}) }), [placeholder, detail]);
  const detailLoading = isPending || (isFetching && !detail);
  const detailError = isError && !detail && !isFetching ? errorMessage(error) : "";
  return (
    <ImageDetailModal
      item={item}
      onClose={onClose}
      onTrashCommitted={async (imageId) => {
        if (imageId !== card.id) return;
        setTrashCommitted(true);
        await onTrashCommitted(imageId);
      }}
      onTrashed={onTrashed}
      onItemUpdated={onItemUpdated}
      onItemRefreshRequested={onItemRefreshRequested}
      admin={false}
      detailLoading={detailLoading}
      detailError={detailError}
      onDetailRetry={() => void refetch()}
      returnFocusRef={returnFocusRef}
    />
  );
}

export function GalleryPage({ embedded = false }: { embedded?: boolean }) {
  const [selected, setSelected] = useState<GalleryImageCard | null>(null);
  const [pinnedImageId, setPinnedImageId] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const [routeSearchParams, setRouteSearchParams] = useSearchParams();
  const routeQuery = routeSearchParams.toString();
  const filters = useMemo(
    () => galleryFiltersFromSearchParams(new URLSearchParams(routeQuery)),
    [routeQuery]
  );
  const {
    backToTopVisible,
    filterPanelHidden,
    filterPanelRef,
    filterMenuDismissSignal,
    filterToggleRef,
    filtersOpen,
    headerVisible,
    onHeaderMenuExpandedChange,
    toggleFilters,
    toolbarHeight,
    toolbarRef,
    toolbarVisible,
  } = useGalleryViewportControls({ headerPresent: !embedded });
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
  const { data: facets } = useGalleryFacets();
  const { data: siteConfig } = useSiteConfig();
  const cardSubtitle = useMemo(
    () => {
      const display = createGalleryTaxonomyDisplayFormatter(facets);
      return (card: GalleryImageCard) => display(card).subtitle;
    },
    [facets]
  );

  const order = siteConfig?.site.gallery.order ?? "latest";
  const userAgent = window.navigator.userAgent;
  const imageQuery = useMemo(
    () => galleryApiSearchParams(filters, order, { userAgent }).toString(),
    [filters, order, userAgent]
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
    }
    window.scrollTo({ top: 0 });
  }, [imageQuery, queryClient]);

  const randomUrl = buildRandomUrl({
    origin: window.location.origin,
    device: galleryRandomRequestDevice(filters.device),
    brightness: filters.brightness || "random",
    theme: filters.theme,
    tag: filters.tag,
    author: filters.author
  });

  const updateFilter = (key: keyof GalleryFilters, value: string) => {
    setRouteSearchParams(
      galleryRouteSearchParams({ ...filters, [key]: value })
    );
  };

  const columnCount = useGalleryColumnCount();
  const geometry = useGalleryGeometry(galleryRef);
  const galleryData = useGalleryDataWindow({
    geometry: { ...geometry, columnCount },
    imageQuery,
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
  const initialLoading = galleryData.initialLoading;
  const nextPageLoading = galleryData.nextPageLoading;
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
        <div className="public-navigation-frame">
          <div className="public-navigation-stack">
            {!embedded && (
              <AppHeader
                animateEntrance={shouldAnimateNavigation}
                onMenuExpandedChange={onHeaderMenuExpandedChange}
                visible={headerVisible}
              />
            )}
            <GalleryToolbar
              filters={filters}
              facets={facets}
              randomUrl={randomUrl}
              filtersOpen={filtersOpen}
              filterPanelHidden={filterPanelHidden}
              filterMenuDismissSignal={filterMenuDismissSignal}
              toolbarVisible={toolbarVisible}
              toolbarRef={toolbarRef}
              filterToggleRef={filterToggleRef}
              filterPanelRef={filterPanelRef}
              toggleFilters={toggleFilters}
              onFilterChange={updateFilter}
            />
          </div>
        </div>
        <div className="gallery-toolbar-spacer" aria-hidden="true" />
        <section ref={galleryRef} className="gallery">
          <GalleryVirtualWindow
            cardSubtitle={cardSubtitle}
            imageQuery={imageQuery}
            onOpen={openDetail}
            positions={galleryData.positions}
            revealRegistry={revealRegistry}
            totalHeight={galleryData.snapshot.totalHeight}
            windowRef={galleryWindowRef}
          />
        </section>
        {galleryData.snapshot.error && (
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
        {!galleryData.snapshot.error
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
        <button
          type="button"
          className={`gallery-back-to-top pressable${showBackToTop ? " is-visible" : ""}`}
          aria-label="回到顶部"
          title="回到顶部"
          aria-hidden={!showBackToTop}
          tabIndex={showBackToTop ? 0 : -1}
          onClick={(event) => {
            event.currentTarget.blur();
            scrollGalleryToTop();
          }}
        >
          <Icon name="arrow-up-line" />
        </button>
        {selected && (
          <GalleryImageDetail
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
