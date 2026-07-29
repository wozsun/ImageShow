import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient
} from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api/client.js";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import { CopyButton } from "../../components/actions/CopyButton.js";
import { Icon } from "../../components/icon/Icon.js";
import { ImageDetailModal } from "../../components/image/ImageDetailModal.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { FacetSelector } from "../../components/data-display/FacetSelector.js";
import { gallerySentinelRootMargin } from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { displayNameOrSlug, errorMessage, imageDisplayTitle } from "../../lib/ui/formatters.js";
import { buildRandomUrl } from "../../lib/gallery/random-url.js";
import { brightnessOptionLabel, deviceOptionLabel } from "../../lib/ui/select-options.js";
import type { GalleryImageCard, PublicImageDetail, PublicImageItem } from "../../lib/types.js";
import { useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { AnchoredMenuDismissSignalContext } from "../../hooks/useAnchoredMenu.js";
import { pageScrollRestoredEvent } from "../../hooks/usePageScrollLock.js";
import { LazyGalleryImage } from "./LazyGalleryImage.js";
import {
  computeMasonryLayout,
  useGalleryColumnCount,
  useGalleryGeometry,
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

type PublicImageListPage = { items: GalleryImageCard[]; next_cursor: string | null };

function GalleryTileDevelopmentStats() {
  const { debug } = useGalleryImageRuntime();
  useEffect(() => debug?.mountTile(), [debug]);
  return null;
}

function GalleryTile({
  position,
  title,
  tags,
  onOpen
}: {
  position: MasonryItemPosition;
  title: string;
  tags: string;
  onOpen: (
    card: GalleryImageCard,
    opener: HTMLButtonElement
  ) => void;
}) {
  const { item } = position;
  return (
    <button
      className="tile gallery-virtual-tile"
      style={{
        left: position.x,
        top: position.y,
        width: position.width,
        height: position.height
      }}
      data-image-id={item.id}
      onClick={(event) => onOpen(item, event.currentTarget)}
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
  returnFocusRef,
}: {
  card: GalleryImageCard;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const placeholder = useMemo(() => imagePlaceholder(card), [card]);
  const { data, isPending, isFetching, isError, error, refetch } = useQuery<{ item: PublicImageDetail }>({
    queryKey: [...queryKeys.publicImageDetail, card.id],
    // 详情元数据很小，不把 React StrictMode 的模拟卸载传给 fetch；
    // 重放会继续复用同一 Promise，真正关闭后则立即回收零驻留期查询。
    // 原图请求仍由下方 DOM 图片调度器同步取消和清理。
    queryFn: () => api(`/api/images/${encodeURIComponent(card.id)}`),
    gcTime: 0
  });
  const detail = data?.item.id === card.id ? data.item : null;
  const item = useMemo(() => ({ ...placeholder, ...(detail ?? {}) }), [placeholder, detail]);
  const detailLoading = isPending || (isFetching && !detail);
  const detailError = isError && !detail && !isFetching ? errorMessage(error) : "";
  return (
    <ImageDetailModal
      item={item}
      onClose={onClose}
      admin={false}
      detailLoading={detailLoading}
      detailError={detailError}
      onDetailRetry={() => void refetch()}
      returnFocusRef={returnFocusRef}
    />
  );
}

export function GalleryPage() {
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
  } = useGalleryViewportControls();
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const galleryRef = useRef<HTMLElement | null>(null);
  const galleryWindowRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const previousImageQueryRef = useRef<string | null>(null);
  const { data: facets } = useGalleryFacets();
  const { data: siteConfig } = useSiteConfig();

  const order = siteConfig?.site.gallery.order ?? "latest";
  const imageQuery = useMemo(
    () => galleryApiSearchParams(filters, order).toString(),
    [filters, order]
  );

  const imagePages = useInfiniteQuery<PublicImageListPage, Error, { pages: PublicImageListPage[]; pageParams: string[] }, readonly unknown[], string>({
    queryKey: [...queryKeys.publicImages, imageQuery],
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

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (
        !entries.some((entry) => entry.isIntersecting)
        || items.length === 0
        || imagePages.isFetchingNextPage
        || !imagePages.hasNextPage
      ) {
        return;
      }
      void imagePages.fetchNextPage();
    }, { rootMargin: gallerySentinelRootMargin });
    observer.observe(target);
    return () => observer.disconnect();
  }, [
    imagePages.fetchNextPage,
    imagePages.hasNextPage,
    imagePages.isFetchingNextPage,
    items.length
  ]);

  const columnCount = useGalleryColumnCount();
  const geometry = useGalleryGeometry(galleryRef);
  const layout = useMemo(
    () => computeMasonryLayout(items, { ...geometry, columnCount }),
    [columnCount, geometry, items]
  );
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
  const loading = imagePages.isLoading || imagePages.isFetchingNextPage;
  const showBackToTop = backToTopVisible && !selected;

  const openDetail = (
    card: GalleryImageCard,
    opener: HTMLButtonElement
  ) => {
    detailReturnFocusRef.current = opener;
    setPinnedImageId(card.id);
    setSelected(card);
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
        if (opener?.isConnected) {
          opener.scrollIntoView({ block: "nearest" });
          opener.focus({ preventScroll: true });
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
      className="page gallery-page"
      style={{
        "--gallery-toolbar-height": toolbarHeight
          ? `${toolbarHeight}px`
          : undefined
      } as CSSProperties}
    >
      <span className="gallery-atmosphere" aria-hidden="true" />
      <div className="public-navigation-frame">
        <AppHeader
          onMenuExpandedChange={onHeaderMenuExpandedChange}
          visible={headerVisible}
        />
        <section
          ref={toolbarRef}
          className={`gallery-toolbar public-navigation-secondary${filtersOpen ? " filters-open" : ""}${toolbarVisible ? "" : " is-scroll-hidden"}`}
          inert={!toolbarVisible}
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
      <div className="gallery-toolbar-spacer" aria-hidden="true" />
      <section ref={galleryRef} className="gallery">
        <div
          ref={galleryWindowRef}
          className="gallery-window"
          style={{ height: layout.totalHeight }}
        >
          {mountedPositions.map((position) => (
            <GalleryTile
              key={position.item.id}
              position={position}
              title={galleryHoverTitle(position.item)}
              tags={galleryHoverTags(position.item)}
              onOpen={openDetail}
            />
          ))}
        </div>
      </section>
      {imagePages.isError && (
        <QueryErrorState error={imagePages.error} onRetry={() => void imagePages.refetch()} />
      )}
      {!imagePages.isError && !loading && !items.length && <p className="empty-state gallery-empty">暂无图片</p>}
      {loading && <p className="gallery-loading">加载中</p>}
      <div ref={sentinelRef} className="gallery-sentinel" />
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
          returnFocusRef={detailReturnFocusRef}
        />
      )}
    </main>
    </GalleryImageRuntime>
  );
}
