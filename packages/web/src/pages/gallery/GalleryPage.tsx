import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api/client.js";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import { CopyButton } from "../../components/actions/CopyButton.js";
import { Icon } from "../../components/icon/Icon.js";
import { ImageDetailModal } from "../../components/image/ImageDetailModal.js";
import { SelectMenu } from "../../components/form/SelectMenu.js";
import { FacetSelector } from "../../components/data-display/FacetSelector.js";
import { eagerThumbnailCount, galleryRenderBatch, gallerySentinelRootMargin, queryKeys } from "../../lib/constants.js";
import { displayNameOrSlug, imageDisplayTitle } from "../../lib/ui/formatters.js";
import { buildRandomUrl } from "../../lib/gallery/random-url.js";
import { brightnessOptionLabel, deviceOptionLabel, randomModeSelectOptions } from "../../lib/ui/select-options.js";
import { rootSiteOrigin } from "../../lib/gallery/theme-host.js";
import type { GalleryImageCard, PublicImageDetail, PublicImageItem, RandomMode } from "../../lib/types.js";
import { useGalleryFacets, useSiteConfig } from "../../lib/api/site-data.js";
import { QueryErrorState } from "../../components/feedback/QueryErrorState.js";
import { LazyGalleryImage } from "./LazyGalleryImage.js";
import { masonryColumns, nextRenderBatch, useGalleryColumnCount } from "./gallery-layout.js";

type GalleryFilters = { device: string; brightness: string; theme: string; tag: string; author: string };
type PublicImageListPage = { items: GalleryImageCard[]; has_next: boolean; next_cursor: string | null; limit?: number; total?: null };

function gallerySearchParams(filters: GalleryFilters, order: string, cursor = "") {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  // 「r」是随机图专用设备值，画廊列表按「全部设备」处理。
  if (filters.device && filters.device !== "r") params.set("d", filters.device);
  if (filters.brightness) params.set("b", filters.brightness);
  if (filters.theme) params.set("t", filters.theme);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author) params.set("a", filters.author);
  if (order === "random") params.set("shuffle", "1");
  return params;
}

function imagePlaceholder(card: GalleryImageCard): PublicImageItem {
  return {
    ...card,
    description: "",
    author: "",
    object_url: "",
    has_distinct_original: false,
    source: ""
  };
}

function GalleryImageDetail({ card, onClose }: { card: GalleryImageCard; onClose: () => void }) {
  const placeholder = useMemo(() => imagePlaceholder(card), [card]);
  const { data } = useQuery<{ item: PublicImageDetail }>({
    queryKey: [...queryKeys.publicImageDetail, card.id],
    queryFn: ({ signal }) => api(`/api/images/${encodeURIComponent(card.id)}`, { signal })
  });
  const detail = data?.item.id === card.id ? data.item : null;
  const item = useMemo(() => ({ ...placeholder, ...(detail ?? {}) }), [placeholder, detail]);
  return <ImageDetailModal item={item} onClose={onClose} admin={false} />;
}

export function GalleryPage({ fixedTheme = "", standalone = false }: { fixedTheme?: string; standalone?: boolean }) {
  const [selected, setSelected] = useState<GalleryImageCard | null>(null);
  const [filters, setFilters] = useState<GalleryFilters>({ device: "", brightness: "", theme: fixedTheme, tag: "", author: "" });
  const [mode, setMode] = useState<RandomMode>("");

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(galleryRenderBatch);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { data: facets } = useGalleryFacets();
  const { data: siteConfig } = useSiteConfig();

  const order = siteConfig?.site.gallery.order ?? "latest";
  const imageQuery = useMemo(() => gallerySearchParams(filters, order).toString(), [filters, order]);

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

  const randomOrigin = fixedTheme && siteConfig?.site.domain ? rootSiteOrigin(siteConfig.site.domain).replace(/\/$/, "") : window.location.origin;
  const randomUrl = buildRandomUrl({
    origin: randomOrigin,
    device: filters.device,
    brightness: filters.brightness || "random",
    theme: fixedTheme || filters.theme,
    tag: filters.tag,
    author: filters.author,
    mode
  });

  const activeFilterCount =
    (filters.device ? 1 : 0) +
    (filters.brightness ? 1 : 0) +
    (mode ? 1 : 0) +
    (!fixedTheme && filters.theme ? 1 : 0) +
    (filters.tag ? 1 : 0) +
    (filters.author ? 1 : 0);

  const updateFilter = (key: keyof GalleryFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: key === "theme" && fixedTheme ? fixedTheme : value }));
  };

  useEffect(() => {
    setFilters((current) => current.theme === fixedTheme ? current : { ...current, theme: fixedTheme });
  }, [fixedTheme]);

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

  return (
    <main className={`page ${standalone ? "theme-page" : ""}`}>
      {!standalone && <AppHeader />}
      <section className={`gallery-toolbar ${standalone ? "theme-toolbar" : ""}${filtersOpen ? " filters-open" : ""}`}>
        {standalone && (
          <div className="theme-title">
            <strong>{fixedTheme}</strong>
            <span>主题画廊</span>
          </div>
        )}
        <button
          type="button"
          className="gallery-filter-toggle"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen((open) => !open)}
        >
          <Icon name="filter-3-line" />
          筛选
          {activeFilterCount > 0 && <span className="gallery-filter-count">{activeFilterCount}</span>}
          <span className="gallery-filter-chevron"><Icon name="arrow-down-s-line" /></span>
        </button>
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
          />
        </label>
        <label className="gallery-axis">
          模式
          <SelectMenu
            value={mode}
            onChange={(value) => setMode(value as RandomMode)}
            options={randomModeSelectOptions}
            ariaLabel="模式"
          />
        </label>
        {!fixedTheme && (
          <label>
            主题
            <FacetSelector
              options={facets?.themes ?? []}
              value={filters.theme}
              onChange={(value) => updateFilter("theme", value)}
              noun="主题"
            />
          </label>
        )}
        <label>
          标签
          <FacetSelector
            options={facets?.tags ?? []}
            value={filters.tag}
            onChange={(value) => updateFilter("tag", value)}
            noun="标签"
          />
        </label>
        <label>
          作者
          <FacetSelector
            options={facets?.authors ?? []}
            value={filters.author}
            onChange={(value) => updateFilter("author", value)}
            noun="作者"
          />
        </label>
        <div className="theme-link">
          <span>随机图片链接</span>
          <div className="theme-link-row">
            <code>{randomUrl}</code>
            <CopyButton value={randomUrl} ariaLabel="复制随机图片链接" />
            <a
              className="button secondary pressable"
              href={randomUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Icon name="external-link-line" />打开
            </a>
          </div>
        </div>
      </section>
      <section className="gallery" style={{ "--gallery-columns": columnCount } as CSSProperties}>
        {columns.map((column, columnIndex) => (
          <div className="gallery-column" key={columnIndex}>
            {column.map((item) => (
              <button
                className="tile"
                key={item.id}
                data-image-id={item.id}
                onClick={() => setSelected(item)}
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
      {selected && (
        <GalleryImageDetail
          card={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </main>
  );
}

export function ThemeHostPage({ theme }: { theme: string }) {
  return <GalleryPage fixedTheme={theme} standalone />;
}
