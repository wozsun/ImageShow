import { gallerySelectorValue, GallerySelectorError } from "../../lib/gallery/gallery-selectors.js";
import { basicTagSelection, basicTagValue, TagFilterError, type TagMatchMode } from "@imageshow/shared/browser";
import type { GalleryStatsDto } from "@imageshow/shared/browser";
import {
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from "react";
import { OverflowMarqueeText } from "../../components/data-display/OverflowMarqueeText.js";
import { OverlayScrollbar } from "../../components/layout/OverlayScrollbar.js";
import { useMediaQuery } from "../../hooks/useMediaQuery.js";
import { useOneShotAnimation } from "../../hooks/useOneShotAnimation.js";
import { useRefreshGlint, useRefreshGlintRun } from "../../hooks/useRefreshGlint.js";
import { publicFilterOptionState } from "../../lib/gallery/public-filter-options.js";
import type { GalleryFilters } from "../../lib/gallery/gallery-query.js";
import {
  boundedHomeRevealIndexes,
  brightnessLabels,
  brightnessOptions,
  countLabel,
  deviceLabels,
  deviceOptions,
  facetLabel,
  homeRevealItemLimits,
  homeThemesWithUnsetLast,
  selectedSlugs
} from "./home-ui.js";
import { useOneShotSectionReveal } from "./useOneShotSectionReveal.js";

function HomeRevealSection({
  armed,
  children,
  className = "",
  onAnimationEndCapture,
  onAnimationIterationCapture,
  onFocusCapture,
  revealVariant,
  ...props
}: ComponentPropsWithoutRef<"section"> & {
  armed: boolean;
  revealVariant: "state" | "axes" | "theme" | "tags" | "authors";
}) {
  const {
    revealImmediately,
    revealed,
    revealedImmediately,
    sectionRef
  } = useOneShotSectionReveal(armed);
  const entrance = useOneShotAnimation(
    revealed
    && !revealedImmediately
    && revealVariant !== "state"
  );
  return (
    <section
      {...props}
      ref={sectionRef}
      className={[
        className,
        "home-reveal-section",
        `home-reveal-${revealVariant}`,
        revealedImmediately ? "is-reveal-immediate" : "",
        entrance.active ? "is-reveal-animation-active" : "",
        `is-reveal-${revealed ? "settled" : "pending"}`
      ].filter(Boolean).join(" ")}
      onAnimationEndCapture={(event) => {
        const finalAxesAnimation = revealVariant === "axes"
          && event.animationName === "home-axis-group-reveal"
          && event.target instanceof Element
          && event.target.matches(".home-axis-group:last-child");
        if (
          event.animationName === "home-section-track-glint"
          || finalAxesAnimation
        ) {
          entrance.finish();
        }
        onAnimationEndCapture?.(event);
      }}
      onAnimationIterationCapture={(event) => {
        if (event.animationName === "home-section-track-glint") {
          entrance.finish();
        }
        onAnimationIterationCapture?.(event);
      }}
      onFocusCapture={(event) => {
        revealImmediately();
        onFocusCapture?.(event);
      }}
    >
      {children}
    </section>
  );
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
  count,
  refreshGlintRun,
  isRefreshing,
  reduceMotion,
  action
}: {
  index: string;
  eyebrow: string;
  title: string;
  count: number;
  refreshGlintRun: number;
  isRefreshing: boolean;
  reduceMotion: boolean;
  action?: ReactNode;
}) {
  const glint = useRefreshGlint(refreshGlintRun, isRefreshing, reduceMotion);

  return (
    <header className="home-section-heading">
      <div className="home-section-title">
        <span>{index} / {eyebrow}</span>
        <h2>{title}</h2>
      </div>
      {action}
      <small>{count} 项</small>
      <i
        className={[
          "home-section-track-glint",
          glint.active && !reduceMotion ? "is-refresh-glint-active" : ""
        ].filter(Boolean).join(" ")}
        aria-hidden="true"
        onAnimationIteration={(event) => {
          if (
            event.animationName === "home-section-track-glint"
          ) {
            glint.finishCycle();
          }
        }}
      />
    </header>
  );
}

export function HomeCatalog({
  catalogRef,
  armed,
  filters,
  stats,
  isPending,
  isError,
  isRefreshing,
  availabilityUnverified,
  onFiltersChange,
  tagMode,
  onTagModeChange,
  onRetry,
  onCatalogIntent
}: {
  catalogRef: RefObject<HTMLElement | null>;
  armed: boolean;
  filters: GalleryFilters;
  stats: GalleryStatsDto | undefined;
  isPending: boolean;
  isError: boolean;
  isRefreshing: boolean;
  availabilityUnverified: boolean;
  onFiltersChange: (filters: GalleryFilters) => void;
  tagMode: TagMatchMode;
  onTagModeChange: (mode: TagMatchMode) => void;
  onRetry: () => void;
  onCatalogIntent: () => void;
}) {
  const refreshGlintRun = useRefreshGlintRun(isRefreshing);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const themeSet = new Set(selectedSlugs(filters.theme));
  const tagSet = new Set(basicTagSelection(filters.tag).selected);
  const [selectionError, setSelectionError] = useState<{ field: "theme" | "tag" | "author"; message: string } | null>(null);
  const authorSet = new Set(selectedSlugs(filters.author));
  const deviceCounts = new Map(
    stats?.devices.map((item) => [item.device, item.image_count]) ?? []
  );
  const brightnessCounts = new Map(
    stats?.brightnesses.map((item) => [item.brightness, item.image_count]) ?? []
  );
  const themes = homeThemesWithUnsetLast(stats?.themes ?? []);
  const themeRevealIndexes = boundedHomeRevealIndexes(
    themes,
    themeSet,
    availabilityUnverified,
    homeRevealItemLimits.themes
  );
  const tagRevealIndexes = boundedHomeRevealIndexes(
    stats?.tags ?? [],
    tagSet,
    availabilityUnverified,
    homeRevealItemLimits.tags
  );
  const authorRevealIndexes = boundedHomeRevealIndexes(
    stats?.authors ?? [],
    authorSet,
    availabilityUnverified,
    homeRevealItemLimits.authors
  );

  const updateFilter = (key: keyof GalleryFilters, value: string) => {
    onFiltersChange({ ...filters, [key]: value });
  };

  const toggleMultiFacet = (
    key: "theme" | "tag" | "author",
    slug: string
  ) => {
    const selected = key === "tag" ? [...tagSet] : selectedSlugs(filters[key]);
    if (availabilityUnverified && !selected.includes(slug)) return;
    const next = selected.includes(slug)
      ? selected.filter((item) => item !== slug)
      : [...selected, slug];
    try {
      updateFilter(key, key === "tag" ? basicTagValue(next, tagMode) : gallerySelectorValue(key, next));
      setSelectionError(null);
    } catch (error) {
      if (!(error instanceof TagFilterError) && !(error instanceof GallerySelectorError)) throw error;
      setSelectionError({ field: key, message: error.message });
    }
  };

  return (
    <section
      ref={catalogRef}
      className={[
        "home-catalog",
        isRefreshing ? "is-refreshing" : "",
        `is-entrance-${armed ? "armed" : "pending"}`
      ].filter(Boolean).join(" ")}
      aria-label="图库分类目录"
      aria-busy={isRefreshing}
      aria-hidden={armed ? undefined : true}
      inert={armed ? undefined : true}
      onFocusCapture={onCatalogIntent}
    >
      {isError && (
        <HomeRevealSection
          armed={armed}
          className="home-glass-card home-stats-state"
          revealVariant="state"
          role="alert"
        >
          <strong>图库目录暂时无法读取</strong>
          <p>仍可直接进入完整画廊，或重新尝试加载分类数量。</p>
          <button type="button" onClick={onRetry}>
            重新加载
          </button>
        </HomeRevealSection>
      )}

      {isPending && !isError && (
        <HomeRevealSection
          armed={armed}
          className="home-glass-card home-stats-state"
          revealVariant="state"
          aria-live="polite"
        >
          <strong>正在整理图库目录</strong>
          <p>主题、标签和作者会在读取完成后全部显示。</p>
          <div className="home-loading-lines" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </HomeRevealSection>
      )}

      {stats && (
        <>
          <HomeRevealSection
            armed={armed}
            className="home-glass-card home-axes-card"
            revealVariant="axes"
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
                      {...publicFilterOptionState({ selected: filters.device === value,
                        count: value ? deviceCounts.get(value) : undefined,
                        unverified: availabilityUnverified, unrestricted: value === "" })}
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
                      {...publicFilterOptionState({ selected: filters.brightness === value,
                        count: value ? brightnessCounts.get(value) : undefined,
                        unverified: availabilityUnverified, unrestricted: value === "" })}
                      label={brightnessLabels[value]}
                      onClick={() => updateFilter("brightness", value)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </HomeRevealSection>

          <div className="home-selector-layout">
            <HomeRevealSection
              armed={armed}
              className="home-glass-card home-theme-selector"
              revealVariant="theme"
            >
              <SectionHeading
                index="01"
                eyebrow="THEMES"
                title="主题"
                count={themes.length}
                refreshGlintRun={refreshGlintRun}
                isRefreshing={isRefreshing}
                reduceMotion={reduceMotion}
              />
              {selectionError?.field === "theme" && <p className="muted" role="alert">{selectionError.message}</p>}
              <SelectorOptions className="home-theme-options">
                {themes.map((item, index) => {
                  const selected = themeSet.has(item.slug);
                  const { disabled, locked } = publicFilterOptionState({
                    selected, count: item.image_count, unverified: availabilityUnverified
                  });
                  const label = facetLabel(item);
                  const revealIndex = themeRevealIndexes.get(item.slug);
                  return (
                    <button
                      type="button"
                      className={selected ? "is-selected" : undefined}
                      key={item.slug}
                      data-reveal-item={revealIndex === undefined
                        ? undefined
                        : true}
                      style={revealIndex === undefined
                        ? undefined
                        : {
                            "--home-reveal-index": revealIndex
                          } as CSSProperties}
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
            </HomeRevealSection>

            <div className="home-selector-side">
              <HomeRevealSection
                armed={armed}
                className="home-glass-card home-tag-selector"
                revealVariant="tags"
              >
                <SectionHeading
                  index="02"
                  eyebrow="TAGS"
                  title="标签"
                  count={stats.tags.length}
                  refreshGlintRun={refreshGlintRun}
                  isRefreshing={isRefreshing}
                  reduceMotion={reduceMotion}
                  action={(
                    <div className="home-tag-mode" data-mode={tagMode} role="group" aria-label="标签筛选方式">
                      {(["any", "all"] as const).map((mode) => (
                        <AxisButton
                          key={mode}
                          selected={tagMode === mode}
                          disabled={false}
                          locked={false}
                          label={mode === "any" ? "任一" : "全部"}
                          onClick={() => {
                            try {
                              if (tagSet.size) updateFilter("tag", basicTagValue([...tagSet], mode));
                              onTagModeChange(mode);
                              setSelectionError(null);
                            } catch (error) {
                              if (!(error instanceof TagFilterError)) throw error;
                              setSelectionError({ field: "tag", message: error.message });
                            }
                          }}
                        />
                      ))}
                    </div>
                  )}
                />
                {selectionError?.field === "tag" && <p className="muted" role="alert">{selectionError.message}</p>}
                <SelectorOptions className="home-tag-options">
                  {stats.tags.map((item) => {
                    const selected = tagSet.has(item.slug);
                    const { disabled, locked } = publicFilterOptionState({
                      selected, count: item.image_count, unverified: availabilityUnverified
                    });
                    const label = facetLabel(item);
                    const revealIndex = tagRevealIndexes.get(item.slug);
                    return (
                      <button
                        type="button"
                        className={`${selected ? "is-selected" : ""}${item.image_count === 0 ? " is-empty" : ""}`.trim()}
                        key={item.slug}
                        data-reveal-item={revealIndex === undefined
                          ? undefined
                          : true}
                        style={revealIndex === undefined
                          ? undefined
                          : {
                              "--home-reveal-index": revealIndex
                            } as CSSProperties}
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
              </HomeRevealSection>

              <HomeRevealSection
                armed={armed}
                className="home-glass-card home-author-selector"
                revealVariant="authors"
              >
                <SectionHeading
                  index="03"
                  eyebrow="CONTRIBUTORS"
                  title="作者"
                  count={stats.authors.length}
                  refreshGlintRun={refreshGlintRun}
                  isRefreshing={isRefreshing}
                  reduceMotion={reduceMotion}
                />
                {selectionError?.field === "author" && <p className="muted" role="alert">{selectionError.message}</p>}
                <SelectorOptions className="home-author-options">
                  {stats.authors.map((item) => {
                    const selected = authorSet.has(item.slug);
                    const { disabled, locked } = publicFilterOptionState({
                      selected, count: item.image_count, unverified: availabilityUnverified
                    });
                    const label = facetLabel(item);
                    const revealIndex = authorRevealIndexes.get(item.slug);
                    return (
                      <button
                        type="button"
                        className={selected ? "is-selected" : undefined}
                        key={item.slug}
                        data-reveal-item={revealIndex === undefined
                          ? undefined
                          : true}
                        style={revealIndex === undefined
                          ? undefined
                          : {
                              "--home-reveal-index": revealIndex
                            } as CSSProperties}
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
              </HomeRevealSection>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
