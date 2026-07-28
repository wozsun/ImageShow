import type { GalleryStatsDto } from "@imageshow/shared/browser";
import type { RefObject } from "react";
import { homeNumberFormatter } from "./home-ui.js";

export function HomeBackground({ source }: { source: string }) {
  return (
    <div className="home-random-background" aria-hidden="true">
      <img src={source} alt="" fetchPriority="high" />
    </div>
  );
}

export function HomeHero({
  bannerLabel,
  bannerTitle,
  tagline,
  stats,
  catalogRef
}: {
  bannerLabel: string;
  bannerTitle: string;
  tagline: string;
  stats: GalleryStatsDto | undefined;
  catalogRef: RefObject<HTMLElement | null>;
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
    const reduceMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;
    catalogRef.current?.scrollIntoView({
      behavior: reduceMotion ? "auto" : "smooth",
      block: "start"
    });
  };

  return (
    <section className="home-banner" aria-labelledby="home-title">
      <div className="home-banner-copy">
        <span>{bannerLabel}</span>
        <h1 id="home-title">{bannerTitle}</h1>
        {tagline && <p>{tagline}</p>}
      </div>
      <aside
        className="home-site-stats"
        aria-label="全站图库统计"
        aria-live="polite"
      >
        <span>LIBRARY STATS</span>
        <ul>
          {siteStats.map((item) => {
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
