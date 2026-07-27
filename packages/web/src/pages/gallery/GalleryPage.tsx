import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { api } from "../../lib/api/client.js";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import { CopyButton } from "../../components/actions/CopyButton.js";
import { Icon } from "../../components/icon/Icon.js";
import { ImageDetailModal } from "../../components/image/ImageDetailModal.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { FacetSelector } from "../../components/data-display/FacetSelector.js";
import { eagerThumbnailCount, galleryRenderBatch, gallerySentinelRootMargin } from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { displayNameOrSlug, errorMessage, imageDisplayTitle } from "../../lib/ui/formatters.js";
import { buildRandomUrl } from "../../lib/gallery/random-url.js";
import { brightnessOptionLabel, deviceOptionLabel } from "../../lib/ui/select-options.js";
import type { GalleryImageCard, PublicImageDetail, PublicImageItem } from "../../lib/types.js";
import { useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { AnchoredMenuDismissSignalContext } from "../../hooks/useAnchoredMenu.js";
import { LazyGalleryImage } from "./LazyGalleryImage.js";
import { masonryColumns, nextRenderBatch, useGalleryColumnCount } from "./gallery-layout.js";
import { scrollGalleryToTop, useGalleryViewportControls } from "./useGalleryViewportControls.js";
import {
  galleryApiSearchParams,
  galleryFiltersFromSearchParams,
  galleryRouteSearchParams,
  type GalleryFilters
} from "../../lib/gallery/gallery-query.js";

type PublicImageListPage = { items: GalleryImageCard[]; next_cursor: string | null };

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
    queryFn: ({ signal }) => api(`/api/images/${encodeURIComponent(card.id)}`, { signal })
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
    toggleFilters,
    toolbarRef,
    toolbarVisible,
  } = useGalleryViewportControls();
  const [visibleCount, setVisibleCount] = useState(galleryRenderBatch);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
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
    getNextPageParam: (lastPage) => lastPage.next_cursor || undefined
  });

  useEffect(() => {
    setVisibleCount(galleryRenderBatch);
    window.scrollTo({ top: 0 });
  }, [imageQuery]);

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
      if (!entries.some((entry) => entry.isIntersecting) || items.length === 0 || imagePages.isFetchingNextPage) return;
      if (visibleCount < items.length) {
        setVisibleCount((current) => nextRenderBatch(current, items.length));
        return;
      }
      if (imagePages.hasNextPage) void imagePages.fetchNextPage();
    }, { rootMargin: gallerySentinelRootMargin });
    observer.observe(target);
    return () => observer.disconnect();
  }, [imagePages.fetchNextPage, imagePages.hasNextPage, imagePages.isFetchingNextPage, items.length, visibleCount]);

  const columnCount = useGalleryColumnCount();
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const columns = useMemo(() => masonryColumns(visibleItems, columnCount), [visibleItems, columnCount]);
  const themeNames = useMemo(() => new Map((facets?.themes ?? []).map((option) => [option.slug, displayNameOrSlug(option)])), [facets]);
  const tagNames = useMemo(() => new Map((facets?.tags ?? []).map((option) => [option.slug, displayNameOrSlug(option)])), [facets]);

  const eagerIds = useMemo(() => new Set(visibleItems.slice(0, eagerThumbnailCount).map((item) => item.id)), [visibleItems]);
  const themeLabel = (slug: string) => slug === "none" ? "" : themeNames.get(slug) ?? slug;
  const galleryHoverTitle = (item: GalleryImageCard) => item.title?.trim() || themeLabel(item.theme) || imageDisplayTitle(item);
  const galleryHoverTags = (item: GalleryImageCard) => item.tags.map((tag) => tagNames.get(tag) ?? tag).join(" · ");
  const loading = imagePages.isLoading || imagePages.isFetchingNextPage;
  const showBackToTop = backToTopVisible && !selected;

  return (
    <main className="page gallery-page">
      <AppHeader />
      <section
        ref={toolbarRef}
        className={`gallery-toolbar${filtersOpen ? " filters-open" : ""}${toolbarVisible ? "" : " is-scroll-hidden"}`}
        data-scroll-lock-anchor
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
      <section className="gallery" style={{ "--gallery-columns": columnCount } as CSSProperties}>
        {columns.map((column, columnIndex) => (
          <div className="gallery-column" key={columnIndex}>
            {column.map((item) => (
              <button
                className="tile"
                key={item.id}
                data-image-id={item.id}
                onClick={(event) => {
                  detailReturnFocusRef.current = event.currentTarget;
                  setSelected(item);
                }}
              >
                <LazyGalleryImage
                  src={item.thumb_url}
                  alt={galleryHoverTitle(item)}
                  device={item.device}
                  width={item.width}
                  height={item.height}
                  priority={eagerIds.has(item.id)}
                />
                <span className="tile-info">
                  <strong>{galleryHoverTitle(item)}</strong>
                  {item.tags.length > 0 && <small>{galleryHoverTags(item)}</small>}
                </span>
              </button>
            ))}
          </div>
        ))}
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
  );
}
