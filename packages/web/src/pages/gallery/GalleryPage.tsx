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
  useInfiniteQuery,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import type {
  PublicImageDetailResponseDto,
  PublicImageListResponseDto
} from "@imageshow/shared/browser";
import { useSearchParams } from "react-router";
import { api } from "../../lib/api/client.js";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import { CopyButton } from "../../components/actions/CopyButton.js";
import { Icon } from "../../components/icon/Icon.js";
import { ImageDetailModal } from "../../components/image/ImageDetailModal.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { FacetSelector } from "../../components/data-display/FacetSelector.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { removeImageFromPublicImagesCache } from "./gallery-image-cache.js";
import { displayNameOrSlug, errorMessage, imageDisplayTitle } from "../../lib/ui/formatters.js";
import { buildRandomUrl } from "../../lib/gallery/random-url.js";
import { brightnessOptionLabel, deviceOptionLabel } from "../../lib/ui/select-options.js";
import type { GalleryImageCard, PublicImageItem } from "../../lib/types.js";
import { useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import {
  AppLoadingRegion
} from "../../components/feedback/AppLoadingScreen.js";
import { AnchoredMenuDismissSignalContext } from "../../hooks/useAnchoredMenu.js";
import { pageScrollRestoredEvent } from "../../hooks/usePageScrollLock.js";
import { useDocumentMotionPause } from "../../hooks/useDocumentMotionPause.js";
import { useOneShotAnimation } from "../../hooks/useOneShotAnimation.js";
import { usePublicNavigationEntrance } from "../../hooks/usePublicNavigationEntrance.js";
import { LazyGalleryImage } from "./LazyGalleryImage.js";
import {
  useGalleryColumnCount,
  useGalleryGeometry,
  useIncrementalMasonryLayout,
  useMasonryWindow,
  type MasonryItemPosition
} from "./gallery-layout.js";
import {
  GalleryImageRuntime,
  useGalleryImageRuntime
} from "./GalleryImageRuntime.js";
import { scrollGalleryToTop, useGalleryViewportControls } from "./useGalleryViewportControls.js";
import {
  galleryApiSearchParams,
  galleryFiltersFromSearchParams,
  galleryRouteSearchParams,
  type GalleryFilters
} from "../../lib/gallery/gallery-query.js";
import { GalleryCardRevealRegistry } from "./gallery-card-reveal.js";
import { galleryDeletionFocusTarget } from "./gallery-delete-continuity.js";
import {
  GalleryPagePreloadGate,
  galleryPagePreloadRange,
  galleryPagePreloadRequestKey
} from "./gallery-page-preload.js";

function GalleryTileDevelopmentStats() {
  const { debug } = useGalleryImageRuntime();
  useEffect(() => debug?.mountTile(), [debug]);
  return null;
}

function GalleryTile({
  position,
  revealOrder,
  revealRegistry,
  title,
  tags,
  onOpen
}: {
  position: MasonryItemPosition;
  revealOrder: number;
  revealRegistry: GalleryCardRevealRegistry;
  title: string;
  tags: string;
  onOpen: (
    card: GalleryImageCard,
    opener: HTMLButtonElement
  ) => void;
}) {
  const { item } = position;
  const [reveal] = useState(() => revealRegistry.prepare(item.id, {
    initialViewport: position.y < window.innerHeight,
    order: revealOrder,
    reduceMotion: window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    ).matches === true
  }));
  const entrance = useOneShotAnimation(reveal.variant !== "settled");
  useLayoutEffect(() => {
    revealRegistry.markRevealed(item.id);
  }, [item.id, revealRegistry]);
  return (
    <button
      className={[
        "tile",
        "gallery-virtual-tile",
        !entrance.active
          ? ""
          : `is-gallery-card-reveal-${reveal.variant}`
      ].filter(Boolean).join(" ")}
      style={{
        left: position.x,
        top: position.y,
        width: position.width,
        height: position.height,
        "--gallery-card-reveal-delay": `${reveal.delayMs}ms`
      } as CSSProperties}
      data-image-id={item.id}
      onClick={(event) => onOpen(item, event.currentTarget)}
      onAnimationEnd={(event) => {
        if (
          event.currentTarget === event.target
          && event.animationName.startsWith("gallery-card-reveal-")
        ) {
          entrance.finish();
        }
      }}
    >
      {import.meta.env?.DEV === true && <GalleryTileDevelopmentStats />}
      <LazyGalleryImage
        src={item.thumb_url}
        alt={title}
        device={item.device}
        width={item.width}
        height={item.height}
      />
      <span className="tile-info">
        <strong>{title}</strong>
        {item.tags.length > 0 && <small>{tags}</small>}
      </span>
    </button>
  );
}

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
  onDeleteCommitted,
  onDeleted,
  returnFocusRef,
}: {
  card: GalleryImageCard;
  onClose: () => void;
  onDeleteCommitted: (
    imageId: string
  ) => void | Promise<void>;
  onDeleted: (imageId: string) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const placeholder = useMemo(() => imagePlaceholder(card), [card]);
  const [deleteCommitted, setDeleteCommitted] = useState(false);
  const { data, isPending, isFetching, isError, error, refetch } = useQuery<PublicImageDetailResponseDto>({
    queryKey: [...queryKeys.publicImageDetail, card.id],
    // 详情元数据很小，不把 React StrictMode 的模拟卸载传给 fetch；
    // 重放会继续复用同一 Promise，真正关闭后则立即回收零驻留期查询。
    // 原图请求仍由下方 DOM 图片调度器同步取消和清理。
    queryFn: () => api(`/api/images/${encodeURIComponent(card.id)}`),
    gcTime: 0,
    enabled: !deleteCommitted
  });
  const detail = data?.item.id === card.id ? data.item : null;
  const item = useMemo(() => ({ ...placeholder, ...(detail ?? {}) }), [placeholder, detail]);
  const detailLoading = isPending || (isFetching && !detail);
  const detailError = isError && !detail && !isFetching ? errorMessage(error) : "";
  return (
    <ImageDetailModal
      item={item}
      onClose={onClose}
      onDeleteCommitted={async (imageId) => {
        if (imageId !== card.id) return;
        setDeleteCommitted(true);
        await onDeleteCommitted(imageId);
      }}
      onDeleted={onDeleted}
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
  const selectedIndexRef = useRef(-1);
  const galleryRef = useRef<HTMLElement | null>(null);
  const galleryWindowRef = useRef<HTMLDivElement | null>(null);
  const pagePreloadRef = useRef<HTMLSpanElement | null>(null);
  const pagePreloadGateRef = useRef<GalleryPagePreloadGate | null>(null);
  const [pagePreloadRevision, setPagePreloadRevision] = useState(0);
  if (!pagePreloadGateRef.current) {
    pagePreloadGateRef.current = new GalleryPagePreloadGate();
  }
  const previousImageQueryRef = useRef<string | null>(null);
  const routeEntranceFinishedRef = useRef(false);
  const {
    markAppeared: markNavigationAppeared,
    shouldAnimate: shouldAnimateNavigation
  } = usePublicNavigationEntrance();
  const { data: facets } = useGalleryFacets();
  const { data: siteConfig } = useSiteConfig();

  const order = siteConfig?.site.gallery.order ?? "latest";
  const imageQuery = useMemo(
    () => galleryApiSearchParams(filters, order).toString(),
    [filters, order]
  );
  useEffect(() => {
    pagePreloadGateRef.current?.beginSession(imageQuery);
  }, [imageQuery]);
  const publicImagesQueryKey = useMemo(
    () => [...queryKeys.publicImages, imageQuery] as const,
    [imageQuery]
  );
  const revealRegistry = useMemo(
    () => new GalleryCardRevealRegistry({
      routeEntrance: !routeEntranceFinishedRef.current
    }),
    [imageQuery]
  );
  const toolbarEntrance = useOneShotAnimation(true);
  useDocumentMotionPause();

  useEffect(() => {
    routeEntranceFinishedRef.current = true;
  }, []);

  useLayoutEffect(() => {
    markNavigationAppeared();
  }, [markNavigationAppeared]);

  const imagePages = useInfiniteQuery<PublicImageListResponseDto, Error, { pages: PublicImageListResponseDto[]; pageParams: string[] }, readonly unknown[], string>({
    queryKey: publicImagesQueryKey,
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams(imageQuery);
      if (pageParam) params.set("cursor", pageParam);
      return api(`/api/images?${params}`, { signal });
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor || undefined,
    gcTime: 0
  });

  useEffect(() => {
    const previous = previousImageQueryRef.current;
    previousImageQueryRef.current = imageQuery;
    if (previous !== null && previous !== imageQuery) {
      const previousKey = [...queryKeys.publicImages, previous];
      void queryClient.cancelQueries({
        queryKey: previousKey,
        exact: true
      });
      queryClient.removeQueries({
        queryKey: previousKey,
        exact: true
      });
    }
    window.scrollTo({ top: 0 });
  }, [imageQuery, queryClient]);

  const randomUrl = buildRandomUrl({
    origin: window.location.origin,
    device: filters.device,
    brightness: filters.brightness || "random",
    theme: filters.theme,
    tag: filters.tag,
    author: filters.author
  });

  const activeFilterCount =
    (filters.device ? 1 : 0) +
    (filters.brightness ? 1 : 0) +
    (filters.theme ? 1 : 0) +
    (filters.tag ? 1 : 0) +
    (filters.author ? 1 : 0);

  const updateFilter = (key: keyof GalleryFilters, value: string) => {
    setRouteSearchParams(
      galleryRouteSearchParams({ ...filters, [key]: value })
    );
  };

  const items = useMemo(() => imagePages.data?.pages.flatMap((page) => page.items) ?? [], [imagePages.data]);

  const columnCount = useGalleryColumnCount();
  const geometry = useGalleryGeometry(galleryRef);
  const layout = useIncrementalMasonryLayout(
    items,
    { ...geometry, columnCount },
    imageQuery
  );
  const pagePreloadRange = useMemo(() => galleryPagePreloadRange(
    imagePages.data?.pages.map((page) => page.items.length) ?? [],
    layout.positions,
    layout.totalHeight
  ), [imagePages.data?.pages, layout.positions, layout.totalHeight]);
  const nextPageCursor = imagePages.data?.pages.at(-1)?.next_cursor ?? "";
  const nextPageRequestKey = galleryPagePreloadRequestKey(
    imageQuery,
    nextPageCursor
  );
  const requestNextPage = useCallback((retry = false) => {
    // The rendered snapshot re-arms the observer after fetching or paused;
    // the live state closes the notification window before claiming a cursor.
    const liveFetchStatus = queryClient.getQueryState(
      publicImagesQueryKey
    )?.fetchStatus;
    if (
      !nextPageRequestKey
      || !imagePages.hasNextPage
      || imagePages.fetchStatus !== "idle"
      || liveFetchStatus !== "idle"
    ) {
      return;
    }
    const claimSequence = pagePreloadGateRef.current?.claim(
      nextPageRequestKey,
      retry
    );
    if (claimSequence == null) return;

    void imagePages.fetchNextPage({ cancelRefetch: false }).then((result) => {
      if (pagePreloadGateRef.current?.rearmIfUnfulfilled(
        nextPageRequestKey,
        nextPageCursor,
        result.data?.pageParams ?? [],
        result.isFetchNextPageError,
        claimSequence
      )) {
        setPagePreloadRevision((revision) => revision + 1);
      }
    });
  }, [
    imagePages.fetchNextPage,
    imagePages.fetchStatus,
    imagePages.hasNextPage,
    nextPageCursor,
    nextPageRequestKey,
    publicImagesQueryKey,
    queryClient
  ]);

  useEffect(() => {
    if (
      imagePages.fetchStatus !== "idle"
      || !nextPageRequestKey
      || !pagePreloadGateRef.current?.rearmIfUnfulfilled(
        nextPageRequestKey,
        nextPageCursor,
        imagePages.data?.pageParams ?? [],
        imagePages.isFetchNextPageError
      )
    ) {
      return;
    }
    // A later ordinary refetch can clear a forward error without advancing its
    // cursor. Re-observe the still-current page only after that refetch settles.
    setPagePreloadRevision((revision) => revision + 1);
  }, [
    imagePages.data?.pageParams,
    imagePages.fetchStatus,
    imagePages.isFetchNextPageError,
    nextPageCursor,
    nextPageRequestKey
  ]);

  useEffect(() => {
    const target = pagePreloadRef.current;
    if (!target || !pagePreloadRange || !nextPageRequestKey) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) requestNextPage();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    nextPageRequestKey,
    pagePreloadRange,
    pagePreloadRevision,
    requestNextPage
  ]);
  const mountedPositions = useMasonryWindow(
    galleryWindowRef,
    layout,
    pinnedImageId
  );
  const themeNames = useMemo(() => new Map((facets?.themes ?? []).map((option) => [option.slug, displayNameOrSlug(option)])), [facets]);
  const tagNames = useMemo(() => new Map((facets?.tags ?? []).map((option) => [option.slug, displayNameOrSlug(option)])), [facets]);

  const themeLabel = (slug: string) => slug === "none" ? "" : themeNames.get(slug) ?? slug;
  const galleryHoverTitle = (item: GalleryImageCard) => item.title?.trim() || themeLabel(item.theme) || imageDisplayTitle(item);
  const galleryHoverTags = (item: GalleryImageCard) => item.tags.map((tag) => tagNames.get(tag) ?? tag).join(" · ");
  const initialLoading = imagePages.isLoading && items.length === 0;
  const nextPageLoading = imagePages.isFetchingNextPage
    && items.length > 0;
  const loading = initialLoading || nextPageLoading;
  const showBackToTop = backToTopVisible && !selected;

  const openDetail = (
    card: GalleryImageCard,
    opener: HTMLButtonElement
  ) => {
    detailReturnFocusRef.current = opener;
    selectedIndexRef.current = items.findIndex((item) => item.id === card.id);
    setPinnedImageId(card.id);
    setSelected(card);
  };
  const handleGalleryImageDeleted = (deletedId: string) => {
    const focusTarget = galleryDeletionFocusTarget(
      items,
      deletedId,
      selectedIndexRef.current
    );
    // 原按钮会随查询重排卸载，不让通用弹窗焦点恢复抓住已脱离 DOM 的节点。
    detailReturnFocusRef.current = null;
    setPinnedImageId(focusTarget?.id ?? null);
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
          <section
            ref={toolbarRef}
            className={`gallery-toolbar public-navigation-secondary${toolbarEntrance.active ? " is-gallery-toolbar-entrance" : ""}${filtersOpen ? " filters-open" : ""}${toolbarVisible ? "" : " is-scroll-hidden"}`}
            inert={!toolbarVisible}
            onAnimationEnd={(event) => {
              if (
                event.currentTarget === event.target
                && event.animationName === "gallery-toolbar-entrance"
              ) {
                toolbarEntrance.finish();
              }
            }}
          >
            <button
              ref={filterToggleRef}
              type="button"
              className="gallery-filter-toggle"
              aria-expanded={filtersOpen}
              aria-controls="gallery-filter-panel"
              onClick={toggleFilters}
            >
              <Icon name="filter-3-line" />
              筛选
              {activeFilterCount > 0 && <span className="gallery-filter-count">{activeFilterCount}</span>}
              <span className="gallery-filter-chevron"><Icon name="arrow-down-s-line" /></span>
            </button>
            <AnchoredMenuDismissSignalContext.Provider value={filterMenuDismissSignal}>
              <div
                ref={filterPanelRef}
                id="gallery-filter-panel"
                className="gallery-filter-panel"
                role="group"
                aria-label="画廊筛选条件"
                aria-hidden={filterPanelHidden}
                inert={filterPanelHidden}
              >
                <label className="gallery-axis">
                  设备
                  <SelectMenu
                    value={filters.device}
                    onChange={(value) => updateFilter("device", value)}
                    options={[
                      { value: "", label: "全部设备" },
                      { value: "r", label: "强制随机" },
                      ...(facets?.devices ?? ["pc", "mb"]).map((value) => ({ value, label: deviceOptionLabel(value) }))
                    ]}
                    ariaLabel="设备"
                    menuClassName="public-gallery-menu"
                  />
                </label>
                <label className="gallery-axis">
                  亮度
                  <SelectMenu
                    value={filters.brightness}
                    onChange={(value) => updateFilter("brightness", value)}
                    options={[
                      { value: "", label: "全部亮度" },
                      ...(facets?.brightnesses ?? ["light", "dark"]).map((value) => ({ value, label: brightnessOptionLabel(value) }))
                    ]}
                    ariaLabel="亮度"
                    menuClassName="public-gallery-menu"
                  />
                </label>
                <label className="gallery-theme-filter">
                  主题
                  <FacetSelector
                    options={facets?.themes ?? []}
                    value={filters.theme}
                    onChange={(value) => updateFilter("theme", value)}
                    noun="主题"
                    menuClassName="public-gallery-menu"
                  />
                </label>
                <label className="gallery-tag-filter">
                  标签
                  <FacetSelector
                    options={facets?.tags ?? []}
                    value={filters.tag}
                    onChange={(value) => updateFilter("tag", value)}
                    noun="标签"
                    menuClassName="public-gallery-menu"
                  />
                </label>
                <label className="gallery-author-filter">
                  作者
                  <FacetSelector
                    options={facets?.authors ?? []}
                    value={filters.author}
                    onChange={(value) => updateFilter("author", value)}
                    noun="作者"
                    menuClassName="public-gallery-menu"
                  />
                </label>
                <div className="theme-link">
                  <span>随机图片API</span>
                  <div className="theme-link-row">
                    <div className="generated-link-field">
                      <code>{randomUrl}</code>
                      <CopyButton value={randomUrl} ariaLabel="复制随机图片链接" />
                    </div>
                  </div>
                </div>
              </div>
            </AnchoredMenuDismissSignalContext.Provider>
          </section>
        </div>
      </div>
      <div className="gallery-toolbar-spacer" aria-hidden="true" />
      <section ref={galleryRef} className="gallery">
        <div
          ref={galleryWindowRef}
          className="gallery-window"
          style={{ height: layout.totalHeight }}
        >
          {mountedPositions.map((position, index) => (
            <GalleryTile
              key={`${imageQuery}:${position.item.id}`}
              position={position}
              revealOrder={index}
              revealRegistry={revealRegistry}
              title={galleryHoverTitle(position.item)}
              tags={galleryHoverTags(position.item)}
              onOpen={openDetail}
            />
          ))}
          {pagePreloadRange && nextPageRequestKey && (
            <span
              ref={pagePreloadRef}
              aria-hidden="true"
              data-gallery-page-preload=""
              style={{
                position: "absolute",
                top: pagePreloadRange.top,
                left: 0,
                width: 1,
                height: pagePreloadRange.height,
                pointerEvents: "none"
              }}
            />
          )}
        </div>
      </section>
      {imagePages.isError && (
        <QueryErrorState
          error={imagePages.error}
          onRetry={() => {
            if (imagePages.isFetchNextPageError && nextPageRequestKey) {
              requestNextPage(true);
              return;
            }
            void imagePages.refetch();
          }}
        />
      )}
      {!imagePages.isError && !loading && !items.length && <p className="empty-state gallery-empty">暂无图片</p>}
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
          onDeleteCommitted={async (imageId) => {
            await removeImageFromPublicImagesCache(
              queryClient,
              imageQuery,
              imageId
            );
          }}
          onDeleted={handleGalleryImageDeleted}
          returnFocusRef={detailReturnFocusRef}
        />
      )}
    </main>
    </GalleryImageRuntime>
  );
}
