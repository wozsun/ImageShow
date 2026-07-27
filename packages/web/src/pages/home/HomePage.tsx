import type { GalleryStatsDto } from "@imageshow/shared/browser";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import { useGalleryStats, useSiteConfig } from "../../lib/api/site-data.js";
import {
  emptyGalleryFilters,
  galleryRouteSearchParams,
  type GalleryFilters
} from "../../lib/gallery/gallery-query.js";
import { HomeCatalog } from "./HomeCatalog.js";
import { HomeFilterBar } from "./HomeFilterBar.js";
import { HomeBackground, HomeHero } from "./HomeHero.js";

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

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.add("home-document");
    return () => root.classList.remove("home-document");
  }, []);

  const stats = currentStats ?? lastSuccessfulStatsRef.current;
  const background = siteQuery.data?.site.home.background
    || "/random?m=redirect";
  const bannerLabel = siteQuery.data?.site.home.banner_label
    || "ImageShow · A FAN-MADE PHOTO HANDBOOK";
  const bannerTitle = siteQuery.data?.site.home.banner_title
    || "我们一起，\n收藏这些瞬间。";
  const tagline = siteQuery.data?.site.home.tagline
    ?? "一个由粉丝共同整理、投稿和维护的图片收藏站。";

  return (
    <main className="page home-page">
      <AppHeader />
      <HomeBackground source={background} />
      <HomeFilterBar
        filters={filters}
        stats={stats}
        isPending={statsQuery.isPending}
        isError={statsQuery.isError}
        isPlaceholderData={statsQuery.isPlaceholderData}
        onFiltersChange={setFilters}
      />
      <HomeHero
        bannerLabel={bannerLabel}
        bannerTitle={bannerTitle}
        tagline={tagline}
        stats={stats}
        catalogRef={catalogRef}
      />
      <HomeCatalog
        catalogRef={catalogRef}
        filters={filters}
        stats={stats}
        isPending={statsQuery.isPending}
        isError={statsQuery.isError}
        isRefreshing={statsQuery.isFetching}
        onFiltersChange={setFilters}
        onRetry={() => void statsQuery.refetch()}
      />
    </main>
  );
}
