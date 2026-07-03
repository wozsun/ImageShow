import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api/client.js";
import { AppHeader } from "../components/navigation/AppHeader.js";
import { CopyButton } from "../components/actions/CopyButton.js";
import { Icon } from "../components/icon/Icon.js";
import { ImageDetailModal } from "../components/image/ImageDetailModal.js";
import { LazyGalleryImage } from "../components/image/LazyGalleryImage.js";
import { SelectMenu } from "../components/form/SelectMenu.js";
import { FacetSelector } from "../components/data-display/FacetSelector.js";
import { eagerThumbnailCount, galleryRenderBatch, gallerySentinelRootMargin } from "../lib/constants.js";
import { formatImageMeta } from "../lib/ui/formatters.js";
import { masonryColumns, nextRenderBatch, useGalleryColumnCount } from "../lib/gallery/gallery-layout.js";
import { buildRandomUrl } from "../lib/gallery/random-url.js";
import { brightnessOptionLabel, deviceOptionLabel, randomModeSelectOptions } from "../lib/ui/select-options.js";
import { rootSiteOrigin } from "../lib/gallery/theme-host.js";
import type { ImageItem, RandomMode } from "../lib/types.js";
import { useAuthMe, useGalleryOptions, useSiteConfig } from "../lib/api/site-data.js";

export function GalleryPage({ fixedTheme = "", standalone = false }: { fixedTheme?: string; standalone?: boolean }) {
  const [selected, setSelected] = useState<ImageItem | null>(null);
  const [filters, setFilters] = useState({ device: "", brightness: "", theme: fixedTheme, tag: "", author: "" });
  const [mode, setMode] = useState<RandomMode>("");

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [items, setItems] = useState<ImageItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(galleryRenderBatch);
  const [hasNext, setHasNext] = useState(true);
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { data: options } = useGalleryOptions();
  const { data: siteConfig } = useSiteConfig();
  const { data: auth } = useAuthMe(!standalone);

  const order = siteConfig?.site.gallery.order ?? "latest";
  const filterKey = `${filters.device}|${filters.brightness}|${filters.theme}|${filters.tag}|${filters.author}|${order}`;
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

  const resetList = () => {
    setItems([]);
    setCursor(null);
    setNextCursor(null);
    setVisibleCount(galleryRenderBatch);
    setHasNext(true);
    window.scrollTo({ top: 0 });
  };

  const updateFilter = (key: keyof typeof filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: key === "theme" && fixedTheme ? fixedTheme : value }));
    resetList();
  };

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    // 「r」是随机图专用设备值，画廊列表按「全部设备」处理。
    if (filters.device && filters.device !== "r") params.set("d", filters.device);
    if (filters.brightness) params.set("b", filters.brightness);
    if (filters.theme) params.set("t", filters.theme);
    if (filters.tag) params.set("tag", filters.tag);
    if (filters.author) params.set("a", filters.author);
    if (order === "random") params.set("shuffle", "1");
    setLoading(true);
    api<{ items: ImageItem[]; has_next: boolean; next_cursor: string | null }>(`/api/images?${params}`)
      .then((data) => {
        if (cancelled) return;
        setItems((current) => cursor ? [...current, ...data.items] : data.items);
        setHasNext(data.has_next);
        setNextCursor(data.next_cursor);
      })
      .catch(() => {
        if (!cancelled) setHasNext(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [filterKey, cursor]);

  useEffect(() => {
    if (fixedTheme) updateFilter("theme", fixedTheme);
  }, [fixedTheme]);

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting) || items.length === 0 || loading) return;
      if (visibleCount < items.length) {
        setVisibleCount((current) => nextRenderBatch(current, items.length));
        return;
      }
      if (hasNext && nextCursor) {
        setCursor(nextCursor);
      }
    }, { rootMargin: gallerySentinelRootMargin });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNext, nextCursor, items.length, loading, visibleCount]);

  const columnCount = useGalleryColumnCount();
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const columns = useMemo(() => masonryColumns(visibleItems, columnCount), [visibleItems, columnCount]);

  const eagerIds = useMemo(() => new Set(visibleItems.slice(0, eagerThumbnailCount).map((item) => item.id)), [visibleItems]);

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
              ...(options?.devices ?? ["pc", "mb"]).map((value) => ({ value, label: deviceOptionLabel(value) }))
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
              ...(options?.brightnesses ?? ["light", "dark"]).map((value) => ({ value, label: brightnessOptionLabel(value) }))
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
              options={options?.themes ?? []}
              value={filters.theme}
              onChange={(value) => updateFilter("theme", value)}
              noun="主题"
            />
          </label>
        )}
        <label>
          标签
          <FacetSelector
            options={options?.tags ?? []}
            value={filters.tag}
            onChange={(value) => updateFilter("tag", value)}
            noun="标签"
          />
        </label>
        <label>
          作者
          <FacetSelector
            options={options?.authors ?? []}
            value={filters.author}
            onChange={(value) => updateFilter("author", value)}
            noun="作者"
          />
        </label>
        <div className="theme-link">
          <span>随机图片链接</span>
          <div className="theme-link-row">
            <code>{randomUrl}</code>
            <CopyButton value={randomUrl} />
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
      <section className="gallery" style={{ "--gallery-columns": columnCount } as React.CSSProperties}>
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
                  alt={item.title || item.id}
                  device={item.device}
                  width={item.width}
                  height={item.height}
                  priority={eagerIds.has(item.id)}
                />
                <span>{formatImageMeta(item)}</span>
              </button>
            ))}
          </div>
        ))}
      </section>
      {!loading && !items.length && <p className="empty-state gallery-empty">暂无图片</p>}
      {loading && <p className="gallery-loading">加载中</p>}
      <div ref={sentinelRef} className="gallery-sentinel" />
      {selected && (
        <ImageDetailModal
          item={selected}
          onClose={() => setSelected(null)}
          admin={!standalone && Boolean(auth?.authenticated)}
        />
      )}
    </main>
  );
}

export function ThemeHostPage({ theme }: { theme: string }) {
  return <GalleryPage fixedTheme={theme} standalone />;
}
