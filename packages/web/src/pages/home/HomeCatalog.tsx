import type { GalleryStatsDto } from "@imageshow/shared/browser";
import { useRef, type ReactNode, type RefObject } from "react";
import { OverflowMarqueeText } from "../../components/data-display/OverflowMarqueeText.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import type { GalleryFilters } from "../../lib/gallery/gallery-query.js";
import {
  brightnessLabels,
  brightnessOptions,
  countLabel,
  deviceLabels,
  deviceOptions,
  facetLabel,
  selectedSlugs
} from "./home-ui.js";

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
      <span className="home-axis-check" aria-hidden="true">✓</span>
      <span className="home-axis-label">{label}</span>
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

export function HomeCatalog({
  catalogRef,
  filters,
  stats,
  isPending,
  isError,
  isRefreshing,
  onFiltersChange,
  onRetry
}: {
  catalogRef: RefObject<HTMLElement | null>;
  filters: GalleryFilters;
  stats: GalleryStatsDto | undefined;
  isPending: boolean;
  isError: boolean;
  isRefreshing: boolean;
  onFiltersChange: (filters: GalleryFilters) => void;
  onRetry: () => void;
}) {
  const availabilityUnverified = isRefreshing || isError;
  const themeSet = new Set(selectedSlugs(filters.theme));
  const tagSet = new Set(selectedSlugs(filters.tag));
  const authorSet = new Set(selectedSlugs(filters.author));
  const deviceCounts = new Map(
    stats?.devices.map((item) => [item.device, item.image_count]) ?? []
  );
  const brightnessCounts = new Map(
    stats?.brightnesses.map((item) => [item.brightness, item.image_count]) ?? []
  );
  const isUnavailable = (selected: boolean, count: number) =>
    !selected && count === 0;

  const updateFilter = (key: keyof GalleryFilters, value: string) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const toggleMultiFacet = (
    key: "theme" | "tag" | "author",
    slug: string
  ) => {
    const selected = selectedSlugs(filters[key]);
    if (availabilityUnverified && !selected.includes(slug)) return;
    const next = selected.includes(slug)
      ? selected.filter((item) => item !== slug)
      : [...selected, slug];
    updateFilter(key, next.join(","));
  };

  return (
    <section
      ref={catalogRef}
      className={`home-catalog${isRefreshing ? " is-refreshing" : ""}`}
      aria-label="图库分类目录"
      aria-busy={isRefreshing}
    >
      {isError && (
        <section className="home-glass-card home-stats-state" role="alert">
          <strong>图库目录暂时无法读取</strong>
          <p>仍可直接进入完整画廊，或重新尝试加载分类数量。</p>
          <button type="button" onClick={onRetry}>
            重新加载
          </button>
        </section>
      )}

      {isPending && (
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
          <section
            className="home-glass-card home-axes-card"
            aria-labelledby="home-axes-title"
          >
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
                      <span
                        className={`home-theme-mark home-accent-${index % 5}`}
                        aria-hidden="true"
                      />
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
  );
}
