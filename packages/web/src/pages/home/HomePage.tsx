import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { Link } from "react-router-dom";
import type {
  GalleryStatsDto,
  GalleryStatsFacetDto
} from "@imageshow/shared/browser";
import { OverflowMarqueeText } from "../../components/data-display/OverflowMarqueeText.js";
import { Icon } from "../../components/icon/Icon.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import {
  emptyGalleryFilters,
  galleryRouteSearchParams,
  galleryHref,
  type GalleryFilters
} from "../../lib/gallery/gallery-query.js";
import { useGalleryStats, useSiteConfig } from "../../lib/api/site-data.js";
import { displayNameOrSlug } from "../../lib/ui/formatters.js";

const deviceLabels: Record<string, string> = {
  "": "全部设备",
  pc: "桌面端",
  mb: "移动端"
};

const brightnessLabels: Record<string, string> = {
  "": "全部明暗",
  dark: "暗色系",
  light: "亮色系"
};

const deviceOptions = ["", "pc", "mb"] as const;
const brightnessOptions = ["", "dark", "light"] as const;
const numberFormatter = new Intl.NumberFormat("zh-CN");

function selectedSlugs(value: string) {
  return value.split(",").filter(Boolean);
}

function facetLabel(item: { slug: string; display_name?: string }) {
  if (item.slug === "none" && !item.display_name?.trim()) return "未设置";
  return displayNameOrSlug(item);
}

function countLabel(count: number) {
  return `${numberFormatter.format(count)} 张`;
}

function SelectorOptions({
  className,
  children
}: {
  className: string;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  return (
    <div ref={containerRef} className={`home-selector-scroll-shell ${className}`}>
      <div ref={scrollRef} className="home-selector-options">
        {children}
      </div>
      <OverlayScrollbar
        targetRef={scrollRef}
        containerRef={containerRef}
        enableOnTouch
      />
    </div>
  );
}

function selectedFacetLabels(
  items: readonly GalleryStatsFacetDto[],
  value: string
) {
  const names = new Map(items.map((item) => [item.slug, facetLabel(item)]));
  return value
    .split(",")
    .map((slug) => slug.replace(/^!/, ""))
    .filter(Boolean)
    .map((slug) => names.get(slug) ?? slug);
}

function AxisButton({
  selected,
  disabled,
  locked,
  label,
  onClick
}: {
  selected: boolean;
  disabled: boolean;
  locked: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={selected ? "is-selected" : undefined}
      aria-pressed={selected}
      aria-disabled={locked || undefined}
      data-availability-locked={locked || undefined}
      disabled={disabled}
      title={
        disabled
          ? "当前组合下没有图片"
          : locked
            ? "当前候选数量尚未验证"
            : undefined
      }
      onClick={locked ? undefined : onClick}
    >
      <span>{selected ? "✓ " : ""}{label}</span>
    </button>
  );
}

function SectionHeading({
  index,
  eyebrow,
  title,
  count
}: {
  index: string;
  eyebrow: string;
  title: string;
  count: number;
}) {
  return (
    <header className="home-section-heading">
      <div>
        <span>{index} / {eyebrow}</span>
        <h2>{title}</h2>
      </div>
      <small>{count} 项</small>
    </header>
  );
}

export function HomePage() {
  const catalogRef = useRef<HTMLElement>(null);
  const lastSuccessfulStatsRef = useRef<GalleryStatsDto | undefined>(undefined);
  const [filters, setFilters] = useState<GalleryFilters>({
    ...emptyGalleryFilters
  });
  const siteQuery = useSiteConfig();
  const statsSearch = useMemo(
    () => galleryRouteSearchParams(filters).toString(),
    [filters]
  );
  const statsQuery = useGalleryStats(statsSearch);
  const currentStats = statsQuery.data;
  useLayoutEffect(() => {
    if (currentStats && !statsQuery.isPlaceholderData) {
      lastSuccessfulStatsRef.current = currentStats;
    }
  }, [currentStats, statsQuery.isPlaceholderData]);
  const stats = currentStats ?? lastSuccessfulStatsRef.current;
  const background = siteQuery.data?.site.home.background
    || "/random?m=redirect";
  const bannerLabel = siteQuery.data?.site.home.banner_label
    || "ImageShow · A FAN-MADE PHOTO HANDBOOK";
  const bannerTitle = siteQuery.data?.site.home.banner_title
    || "我们一起，\n收藏这些瞬间。";
  const tagline = siteQuery.data?.site.home.tagline
    ?? "一个由粉丝共同整理、投稿和维护的图片收藏站。";
  const themeSet = new Set(selectedSlugs(filters.theme));
  const tagSet = new Set(selectedSlugs(filters.tag));
  const authorSet = new Set(selectedSlugs(filters.author));
  const deviceCounts = new Map(
    stats?.devices.map((item) => [item.device, item.image_count]) ?? []
  );
  const brightnessCounts = new Map(
    stats?.brightnesses.map((item) => [item.brightness, item.image_count]) ?? []
  );
  const availabilityRefreshing = statsQuery.isFetching;
  const availabilityUnverified = availabilityRefreshing || statsQuery.isError;
  const isUnavailable = (selected: boolean, count: number) =>
    !selected && count === 0;

  const selectedLabels = useMemo(() => {
    if (!stats) return [];
    return [
      filters.device ? deviceLabels[filters.device] : "",
      filters.brightness ? brightnessLabels[filters.brightness] : "",
      ...selectedFacetLabels(stats.themes, filters.theme),
      ...selectedFacetLabels(stats.tags, filters.tag),
      ...selectedFacetLabels(stats.authors, filters.author)
    ].filter(Boolean);
  }, [filters, stats]);

  const destination = galleryHref(filters);
  const hasFilters = Object.values(filters).some(Boolean);
  const totalImages = stats?.total_images ?? 0;
  const themeCount = stats?.themes.filter((item) => item.slug !== "none").length ?? 0;
  const siteStats = [
    { label: "全站图片", value: totalImages, unit: "张" },
    { label: "主题", value: themeCount, unit: "个" },
    { label: "标签", value: stats?.tags.length ?? 0, unit: "个" },
    { label: "作者", value: stats?.authors.length ?? 0, unit: "位" }
  ];

  const updateFilter = (key: keyof GalleryFilters, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const toggleMultiFacet = (key: "theme" | "tag" | "author", slug: string) => {
    const selected = selectedSlugs(filters[key]);
    if (availabilityUnverified && !selected.includes(slug)) return;
    const next = selected.includes(slug)
      ? selected.filter((item) => item !== slug)
      : [...selected, slug];
    updateFilter(key, next.join(","));
  };

  const scrollToCatalog = () => {
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    catalogRef.current?.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start"
    });
  };

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add("home-document");
    return () => root.classList.remove("home-document");
  }, []);

  return (
    <main className="page home-page">
      <AppHeader />
      <div className="home-random-background" aria-hidden="true">
        <img src={background} alt="" fetchPriority="high" />
      </div>

      <section className="home-filter-bar" aria-label="当前画廊筛选" data-scroll-lock-anchor>
        <div>
          <span>GALLERY FILTER</span>
          <strong>选择后进入画廊</strong>
          <small>
            {statsQuery.isPending
              ? "正在读取图库目录"
              : statsQuery.isError
                ? "所选组合暂时无法验证"
              : statsQuery.isPlaceholderData
                ? "正在检查所选组合"
              : hasFilters
                ? `已选择：${selectedLabels.join(" · ")} · 共有 ${countLabel(stats?.matching_images ?? 0)}`
                : "未设置筛选条件，将浏览全部图片"}
          </small>
        </div>
        <button
          type="button"
          className="home-filter-reset"
          disabled={!hasFilters}
          onClick={() => setFilters({ ...emptyGalleryFilters })}
        >
          <span className="home-filter-reset-icon" aria-hidden="true">
            <Icon name="refresh-line" />
          </span>
          <span className="home-filter-reset-label">重置</span>
        </button>
        <Link className="home-gallery-entry" to={destination}>
          进入画廊 <span aria-hidden="true">→</span>
        </Link>
      </section>

      <section className="home-banner" aria-labelledby="home-title">
        <div className="home-banner-copy">
          <span>{bannerLabel}</span>
          <h1 id="home-title">{bannerTitle}</h1>
          {tagline && <p>{tagline}</p>}
        </div>
        <aside className="home-site-stats" aria-label="全站图库统计" aria-live="polite">
          <span>LIBRARY STATS</span>
          <ul>
            {siteStats.map((item) => (
              <li key={item.label}>
                <strong>{stats ? numberFormatter.format(item.value) : "—"}</strong>
                <span>{item.unit}</span>
                <small>{item.label}</small>
              </li>
            ))}
          </ul>
        </aside>
        <button type="button" className="home-scroll-cue" onClick={scrollToCatalog}>
          向下浏览与筛选 <span aria-hidden="true">↓</span>
        </button>
      </section>

      <section
        ref={catalogRef}
        className={`home-catalog${availabilityRefreshing ? " is-refreshing" : ""}`}
        aria-label="图库分类目录"
        aria-busy={availabilityRefreshing}
      >
        {statsQuery.isError && (
          <section className="home-glass-card home-stats-state" role="alert">
            <strong>图库目录暂时无法读取</strong>
            <p>仍可直接进入完整画廊，或重新尝试加载分类数量。</p>
            <button type="button" onClick={() => void statsQuery.refetch()}>
              重新加载
            </button>
          </section>
        )}

        {statsQuery.isPending && (
          <section className="home-glass-card home-stats-state" aria-live="polite">
            <strong>正在整理图库目录</strong>
            <p>主题、标签和作者会在读取完成后全部显示。</p>
            <div className="home-loading-lines" aria-hidden="true">
              <span />
              <span />
              <span />
            </div>
          </section>
        )}

        {stats && (
          <>
            <section className="home-glass-card home-axes-card" aria-labelledby="home-axes-title">
              <div className="home-axes-intro">
                <span>OPTIONAL FILTER</span>
                <strong id="home-axes-title">设备与明暗</strong>
              </div>
              <div className="home-axis-groups">
                <div className="home-axis-group">
                  <strong>设备</strong>
                  <div>
                    {deviceOptions.map((value) => (
                      <AxisButton
                        key={value || "all"}
                        selected={filters.device === value}
                        locked={
                          availabilityUnverified
                          && value !== ""
                          && filters.device !== value
                        }
                        disabled={value !== "" && isUnavailable(
                          filters.device === value,
                          deviceCounts.get(value) ?? 0
                        )}
                        label={deviceLabels[value]}
                        onClick={() => updateFilter("device", value)}
                      />
                    ))}
                  </div>
                </div>
                <div className="home-axis-group">
                  <strong>明暗</strong>
                  <div>
                    {brightnessOptions.map((value) => (
                      <AxisButton
                        key={value || "all"}
                        selected={filters.brightness === value}
                        locked={
                          availabilityUnverified
                          && value !== ""
                          && filters.brightness !== value
                        }
                        disabled={value !== "" && isUnavailable(
                          filters.brightness === value,
                          brightnessCounts.get(value) ?? 0
                        )}
                        label={brightnessLabels[value]}
                        onClick={() => updateFilter("brightness", value)}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <div className="home-selector-layout">
              <section className="home-glass-card home-theme-selector">
                <SectionHeading
                  index="01"
                  eyebrow="THEMES"
                  title="主题"
                  count={stats.themes.length}
                />
                <SelectorOptions className="home-theme-options">
                  {stats.themes.map((item, index) => {
                    const selected = themeSet.has(item.slug);
                    const disabled = isUnavailable(selected, item.image_count);
                    const locked = availabilityUnverified && !selected;
                    const label = facetLabel(item);
                    return (
                      <button
                        type="button"
                        className={selected ? "is-selected" : undefined}
                        key={item.slug}
                        aria-pressed={selected}
                        aria-disabled={locked || undefined}
                        data-availability-locked={locked || undefined}
                        disabled={disabled}
                        title={
                          disabled
                            ? "当前组合下没有图片"
                            : locked
                              ? "当前候选数量尚未验证"
                              : undefined
                        }
                        onClick={
                          locked
                            ? undefined
                            : () => toggleMultiFacet("theme", item.slug)
                        }
                      >
                        <small>{String(index + 1).padStart(2, "0")}</small>
                        <span className={`home-theme-mark home-accent-${index % 5}`} aria-hidden="true" />
                        <OverflowMarqueeText as="strong" text={label} />
                        <span>{countLabel(item.image_count)}</span>
                        <i aria-hidden="true">{selected ? "✓" : "+"}</i>
                      </button>
                    );
                  })}
                </SelectorOptions>
              </section>

              <div className="home-selector-side">
                <section className="home-glass-card home-tag-selector">
                  <SectionHeading
                    index="02"
                    eyebrow="TAGS"
                    title="标签"
                    count={stats.tags.length}
                  />
                  <SelectorOptions className="home-tag-options">
                    {stats.tags.map((item) => {
                      const selected = tagSet.has(item.slug);
                      const disabled = isUnavailable(selected, item.image_count);
                      const locked = availabilityUnverified && !selected;
                      const label = facetLabel(item);
                      return (
                        <button
                          type="button"
                          className={`${selected ? "is-selected" : ""}${item.image_count === 0 ? " is-empty" : ""}`.trim()}
                          key={item.slug}
                          aria-pressed={selected}
                          aria-disabled={locked || undefined}
                          data-availability-locked={locked || undefined}
                          disabled={disabled}
                          title={
                            disabled
                              ? "当前组合下没有图片"
                              : locked
                                ? "当前候选数量尚未验证"
                                : undefined
                          }
                          onClick={
                            locked
                              ? undefined
                              : () => toggleMultiFacet("tag", item.slug)
                          }
                        >
                          <span aria-hidden="true">{selected ? "✓" : "#"}</span>
                          <OverflowMarqueeText as="strong" text={label} />
                          <small>{countLabel(item.image_count)}</small>
                        </button>
                      );
                    })}
                  </SelectorOptions>
                </section>

                <section className="home-glass-card home-author-selector">
                  <SectionHeading
                    index="03"
                    eyebrow="CONTRIBUTORS"
                    title="作者"
                    count={stats.authors.length}
                  />
                  <SelectorOptions className="home-author-options">
                    {stats.authors.map((item) => {
                      const selected = authorSet.has(item.slug);
                      const disabled = isUnavailable(selected, item.image_count);
                      const locked = availabilityUnverified && !selected;
                      const label = facetLabel(item);
                      return (
                        <button
                          type="button"
                          className={selected ? "is-selected" : undefined}
                          key={item.slug}
                          aria-pressed={selected}
                          aria-disabled={locked || undefined}
                          data-availability-locked={locked || undefined}
                          disabled={disabled}
                          title={
                            disabled
                              ? "当前组合下没有图片"
                              : locked
                                ? "当前候选数量尚未验证"
                                : undefined
                          }
                          onClick={
                            locked
                              ? undefined
                              : () => toggleMultiFacet("author", item.slug)
                          }
                        >
                          <OverflowMarqueeText as="strong" text={label} />
                          <small>{countLabel(item.image_count)}</small>
                          <i aria-hidden="true">{selected ? "✓" : "+"}</i>
                        </button>
                      );
                    })}
                  </SelectorOptions>
                </section>
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
