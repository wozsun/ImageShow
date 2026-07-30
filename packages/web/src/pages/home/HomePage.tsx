import type { GalleryStatsDto } from "@imageshow/shared/browser";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { AppLoadingIndicator } from "../../components/feedback/AppLoadingScreen.js";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import { useDocumentMotionPaused } from "../../hooks/useDocumentMotionPaused.js";
import { usePublicNavigationEntrance } from "../../hooks/usePublicNavigationEntrance.js";
import { useGalleryStats, useSiteConfig } from "../../lib/api/site-data.js";
import {
  emptyGalleryFilters,
  galleryRouteSearchParams,
  type GalleryFilters
} from "../../lib/gallery/gallery-query.js";
import { HomeCatalog } from "./HomeCatalog.js";
import { HomeFilterBar } from "./HomeFilterBar.js";
import { HomeBackground, HomeHero } from "./HomeHero.js";
import { useHomeEntrance } from "./useHomeEntrance.js";

export function HomePage() {
  const catalogRef = useRef<HTMLElement>(null);
  const lastSuccessfulStatsRef = useRef<GalleryStatsDto | undefined>(undefined);
  const {
    hadAppearedBeforeMount: navigationHadAppearedBeforeMount,
    markAppeared: markNavigationAppeared,
    motionAllowed: navigationMotionAllowed
  } = usePublicNavigationEntrance();
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
  const entrance = useHomeEntrance(
    background,
    catalogRef,
    navigationHadAppearedBeforeMount || !navigationMotionAllowed
  );
  const motionPaused = useDocumentMotionPaused();

  useLayoutEffect(() => {
    if (entrance.navigationRevealed) markNavigationAppeared();
  }, [
    entrance.navigationRevealed,
    markNavigationAppeared
  ]);

  return (
    <main
      className="page home-page"
      data-motion-paused={motionPaused || undefined}
    >
      <HomeBackground
        source={background}
        ready={entrance.backgroundReady}
        readyAfterForeground={entrance.backgroundReadyAfterForeground}
        imageRef={entrance.imageRef}
        onLoad={entrance.onBackgroundLoad}
        onError={entrance.onBackgroundError}
      />
      <div
        className={[
          "home-startup-feedback",
          entrance.heroRevealed ? "is-settled" : "is-active"
        ].join(" ")}
        aria-hidden={entrance.heroRevealed ? true : undefined}
      >
        <AppLoadingIndicator />
      </div>
      <div
        className={[
          "public-navigation-frame",
          "home-navigation-frame",
          `is-entrance-${entrance.navigationRevealed
            ? "visible"
            : "pending"}`
        ].join(" ")}
        aria-hidden={entrance.navigationRevealed ? undefined : true}
        inert={entrance.navigationRevealed ? undefined : true}
      >
        <div className="public-navigation-stack">
          <AppHeader />
          <HomeFilterBar
            animateEntrance={
              navigationHadAppearedBeforeMount && navigationMotionAllowed
            }
            filters={filters}
            stats={stats}
            isPending={statsQuery.isPending}
            isError={statsQuery.isError}
            isPlaceholderData={statsQuery.isPlaceholderData}
            onFiltersChange={setFilters}
          />
        </div>
      </div>
      <div className="home-filter-bar-spacer" aria-hidden="true" />
      <HomeHero
        revealed={entrance.heroRevealed}
        bannerLabel={bannerLabel}
        bannerTitle={bannerTitle}
        tagline={tagline}
        stats={stats}
        catalogRef={catalogRef}
        onCatalogIntent={entrance.revealImmediately}
      />
      <HomeCatalog
        catalogRef={catalogRef}
        armed={entrance.catalogArmed}
        filters={filters}
        stats={stats}
        isPending={statsQuery.isPending}
        isError={statsQuery.isError}
        isRefreshing={statsQuery.isFetching}
        onFiltersChange={setFilters}
        onRetry={() => void statsQuery.refetch()}
        onCatalogIntent={entrance.revealImmediately}
      />
    </main>
  );
}
