import type { GalleryStatsDto } from "@imageshow/shared/browser";
import type {
  CSSProperties,
  RefObject,
  SyntheticEvent
} from "react";
import { homeNumberFormatter } from "./home-ui.js";

export function HomeBackground({
  source,
  ready,
  readyAfterForeground,
  imageRef,
  onLoad,
  onError
}: {
  source: string;
  ready: boolean;
  readyAfterForeground: boolean;
  imageRef: RefObject<HTMLImageElement | null>;
  onLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
  onError: (event: SyntheticEvent<HTMLImageElement>) => void;
}) {
  return (
    <div
      className={[
        "home-random-background",
        ready ? "is-ready" : "",
        readyAfterForeground ? "is-ready-after-foreground" : ""
      ].filter(Boolean).join(" ")}
      aria-hidden="true"
    >
      <div className="home-background-image-frame">
        <img
          key={source}
          ref={imageRef}
          alt=""
          decoding="async"
          fetchPriority="high"
          onLoad={onLoad}
          onError={onError}
        />
      </div>
      <span className="home-background-atmosphere" aria-hidden="true" />
    </div>
  );
}

export function HomeHero({
  revealed,
  bannerLabel,
  bannerTitle,
  stats,
  catalogRef,
  onCatalogIntent
}: {
  revealed: boolean;
  bannerLabel: string;
  bannerTitle: string;
  stats: GalleryStatsDto | undefined;
  catalogRef: RefObject<HTMLElement | null>;
  onCatalogIntent: () => void;
}) {
  const totalImages = stats?.total_images ?? 0;
  const themeCount = stats?.themes.filter(
    (item) => item.slug !== "none"
  ).length ?? 0;
  const siteStats = [
    { label: "全站图片", value: totalImages, unit: "张", primary: true },
    { label: "主题", value: themeCount, unit: "个" },
    { label: "标签", value: stats?.tags.length ?? 0, unit: "个" },
    { label: "作者", value: stats?.authors.length ?? 0, unit: "位" }
  ];

  const scrollToCatalog = () => {
    onCatalogIntent();
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    catalogRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start"
    });
  };

  return (
    <section
      className={`home-banner is-entrance-${revealed ? "visible" : "pending"}`}
      aria-labelledby="home-title"
      aria-hidden={revealed ? undefined : true}
      inert={revealed ? undefined : true}
    >
      <div className="home-banner-copy">
        <span className="home-banner-label">{bannerLabel}</span>
        <h1 id="home-title" className="home-banner-title">{bannerTitle}</h1>
      </div>
      <aside
        className="home-site-stats"
        aria-label="全站图库统计"
        aria-live="polite"
      >
        <span>LIBRARY STATS</span>
        <ul>
          {siteStats.map((item, index) => {
            const value = stats
              ? homeNumberFormatter.format(item.value)
              : "—";
            const longValueLength = item.primary ? 10 : 6;
            const wideValueLength = item.primary ? 7 : 4;
            const valueWidth = value.length >= longValueLength
              ? "long"
              : value.length >= wideValueLength
                ? "wide"
                : undefined;
            return (
              <li
                key={item.label}
                className={item.primary ? "is-primary" : undefined}
                data-value-width={valueWidth}
                style={{
                  "--home-stat-index": index
                } as CSSProperties}
              >
                <div className="home-stat-value">
                  <strong>{value}</strong>
                  <span>{item.unit}</span>
                </div>
                <small>{item.label}</small>
              </li>
            );
          })}
        </ul>
      </aside>
      <button
        type="button"
        className="home-scroll-cue"
        onClick={scrollToCatalog}
      >
        向下浏览与筛选 <span aria-hidden="true">↓</span>
      </button>
    </section>
  );
}
