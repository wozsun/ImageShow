import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { AppHeader } from "../components/AppHeader.js";
import { CopyButton } from "../components/CopyButton.js";
import { Icon } from "../components/Icon.js";
import { ImageDetailModal } from "../components/ImageDetailModal.js";
import { LazyGalleryImage } from "../components/LazyGalleryImage.js";
import { SelectMenu } from "../components/SelectMenu.js";
import { ThemeSelector } from "../components/ThemeSelector.js";
import { adminApiBasePath, galleryRenderBatch, queryKeys } from "../lib/constants.js";
import { formatImageMeta } from "../lib/formatters.js";
import { masonryColumns, nextRenderBatch, useGalleryColumnCount } from "../lib/gallery-layout.js";
import { buildRandomUrl } from "../lib/random-url.js";
import { brightnessOptionLabel, deviceOptionLabel, randomModeSelectOptions } from "../lib/select-options.js";
import { rootSiteOrigin } from "../lib/theme-host.js";
import type { AuthState, GalleryOptions, ImageItem, RandomMode, SiteConfig } from "../lib/types.js";

export function GalleryPage({ fixedTheme = "", standalone = false }: { fixedTheme?: string; standalone?: boolean }) {
  const [selected, setSelected] = useState<ImageItem | null>(null);
  const [filters, setFilters] = useState({ device: "", brightness: "", theme: fixedTheme });
  const [mode, setMode] = useState<RandomMode>("");
  const [items, setItems] = useState<ImageItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(galleryRenderBatch);
  const [hasNext, setHasNext] = useState(true);
  const [loading, setLoading] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const { data: options } = useQuery<GalleryOptions>({ queryKey: queryKeys.galleryOptions, queryFn: () => api("/api/gallery-options") });
  const { data: siteConfig } = useQuery<SiteConfig>({ queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config") });
  const { data: auth } = useQuery<AuthState>({
    queryKey: queryKeys.me,
    queryFn: () => api(`${adminApiBasePath}/auth/me`),
    enabled: !standalone
  });
  const filterKey = `${filters.device}|${filters.brightness}|${filters.theme}`;
  const randomOrigin = fixedTheme && siteConfig?.site.domain ? rootSiteOrigin(siteConfig.site.domain).replace(/\/$/, "") : window.location.origin;
  const randomUrl = buildRandomUrl({
    origin: randomOrigin,
    device: filters.device,
    brightness: filters.brightness || "random",
    theme: fixedTheme || filters.theme,
    mode
  });

  const updateFilter = (key: keyof typeof filters, value: string) => {
    setFilters((current) => ({ ...current, [key]: key === "theme" && fixedTheme ? fixedTheme : value }));
    setItems([]);
    setCursor(null);
    setNextCursor(null);
    setVisibleCount(galleryRenderBatch);
    setHasNext(true);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (filters.device) params.set("d", filters.device);
    if (filters.brightness) params.set("b", filters.brightness);
    if (filters.theme) params.set("t", filters.theme);
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
    }, { rootMargin: "280px 0px" });
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNext, nextCursor, items.length, loading, visibleCount]);

  const columnCount = useGalleryColumnCount();
  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const columns = useMemo(() => masonryColumns(visibleItems, columnCount), [visibleItems, columnCount]);

  return (
    <main className={`page ${standalone ? "theme-page" : ""}`}>
      {!standalone && <AppHeader />}
      <section className={`gallery-toolbar ${standalone ? "theme-toolbar" : ""}`}>
        {standalone && (
          <div className="theme-title">
            <strong>{fixedTheme}</strong>
            <span>主题画廊</span>
          </div>
        )}
        <label>设备<SelectMenu value={filters.device} onChange={(value) => updateFilter("device", value)} options={[{ value: "", label: "全部设备" }, ...(options?.devices ?? ["pc", "mb"]).map((value) => ({ value, label: deviceOptionLabel(value) }))]} ariaLabel="设备" /></label>
        <label>亮度<SelectMenu value={filters.brightness} onChange={(value) => updateFilter("brightness", value)} options={[{ value: "", label: "全部亮度" }, ...(options?.brightnesses ?? ["light", "dark"]).map((value) => ({ value, label: brightnessOptionLabel(value) }))]} ariaLabel="亮度" /></label>
        {!fixedTheme && <label>主题<ThemeSelector themes={options?.themes ?? []} value={filters.theme} onChange={(value) => updateFilter("theme", value)} /></label>}
        <label>模式<SelectMenu value={mode} onChange={(value) => setMode(value as RandomMode)} options={randomModeSelectOptions} ariaLabel="模式" /></label>
        <div className="theme-link">
          <span>随机图片链接</span>
          <div className="theme-link-row">
            <code>{randomUrl}</code>
            <CopyButton value={randomUrl} />
            <a className="button secondary pressable" href={randomUrl} target="_blank" rel="noreferrer noopener"><Icon name="external-link-line" />打开</a>
          </div>
        </div>
      </section>
      <section className="gallery" style={{ "--gallery-columns": columnCount } as React.CSSProperties}>
        {columns.map((column, columnIndex) => (
          <div className="gallery-column" key={columnIndex}>
            {column.map((item) => (
              <button className="tile" key={item.id} data-image-id={item.id} onClick={() => setSelected(item)}>
                <LazyGalleryImage src={item.thumb_url} alt={item.title || item.id} device={item.device} width={item.width} height={item.height} />
                <span>{formatImageMeta(item)}</span>
              </button>
            ))}
          </div>
        ))}
      </section>
      {!loading && !items.length && <p className="empty-state gallery-empty">暂无图片</p>}
      {loading && <p className="gallery-loading">加载中</p>}
      <div ref={sentinelRef} className="gallery-sentinel" />
      {selected && <ImageDetailModal item={selected} onClose={() => setSelected(null)} admin={!standalone && Boolean(auth?.authenticated)} />}
    </main>
  );
}

export function ThemeHostPage({ theme }: { theme: string }) {
  return <GalleryPage fixedTheme={theme} standalone />;
}
