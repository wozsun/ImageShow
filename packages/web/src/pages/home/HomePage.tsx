import {
  basicTagSelection,
  readableFilterSearch,
  type TagMatchMode,
  type PublicSiteSettings,
  publicHomeBrowsePath
} from "@imageshow/shared/browser";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  AppLoadingText,
  type AppLoadingExtraDots
} from "../../components/feedback/AppLoadingScreen.js";
import { AppHeader } from "../../components/navigation/AppHeader.js";
import { useDocumentMotionPause } from "../../hooks/useDocumentMotionPause.js";
import { usePublicNavigationEntrance } from "../../hooks/usePublicNavigationEntrance.js";
import { usePublicFilterStats } from "../../hooks/usePublicFilterStats.js";
import { useGalleryFacets } from "../../lib/api/site-queries.js";
import {
  emptyGalleryFilters,
  galleryRouteSearchParams,
  galleryStatsSearch,
  type GalleryFilters
} from "../../lib/gallery/gallery-query.js";
import { HomeCatalog } from "./HomeCatalog.js";
import { HomeFilterBar } from "./HomeFilterBar.js";
import { HomeFooter } from "./HomeFooter.js";
import { HomeBackground, HomeHero } from "./HomeHero.js";
import { useHomeEntrance } from "./useHomeEntrance.js";
import "../../styles/public-core.css";
import "../../styles/home.css";
import "../../styles/home-catalog.css";
import "../../styles/home-responsive.css";

const homeLoadingDotSteps: ReadonlyArray<{
  delayMs: number;
  extraDots: AppLoadingExtraDots;
}> = [
  { delayMs: 100, extraDots: 1 },
  { delayMs: 300, extraDots: 2 },
  { delayMs: 600, extraDots: 3 }
];

function HomeStartupLoadingText({ active }: { active: boolean }) {
  const [extraDots, setExtraDots] = useState<AppLoadingExtraDots>(0);

  useEffect(() => {
    if (!active) return;
    setExtraDots(0);
    const timers = homeLoadingDotSteps.map((step) =>
      window.setTimeout(() => setExtraDots(step.extraDots), step.delayMs)
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [active]);

  return <AppLoadingText extraDots={extraDots} />;
}

export function HomePage({
  embedded = false,
  site
}: {
  embedded?: boolean;
  site: Pick<PublicSiteSettings, "home" | "show" | "gallery" | "icp" | "mps" | "footer">;
}) {
  const catalogRef = useRef<HTMLElement>(null);
  const {
    hadAppearedBeforeMount: navigationHadAppearedBeforeMount,
    markAppeared: markNavigationAppeared,
    motionAllowed: navigationMotionAllowed,
    shouldAnimate: shouldAnimateNavigation
  } = usePublicNavigationEntrance();
  const [filters, setFilters] = useState<GalleryFilters>({
    ...emptyGalleryFilters
  });
  const [tagMode, setTagMode] = useState<TagMatchMode>("any");
  const updateFilters = (next: GalleryFilters) => {
    setFilters(next);
    if (next.tag) setTagMode(basicTagSelection(next.tag).mode);
    else if (filters.tag || !Object.values(next).some(Boolean)) setTagMode("any");
  };
  const statsSearch = useMemo(
    () => galleryStatsSearch(filters),
    [filters]
  );
  const statsQuery = usePublicFilterStats(statsSearch);
  const stats = statsQuery.displayData;
  const facetsQuery = useGalleryFacets();
  const facets = facetsQuery.data;
  // A failed background refresh keeps the loaded facets on display.
  const catalogFailed = statsQuery.isError || (facetsQuery.isError && !facets);
  const background = site.home.background;
  const bannerLabel = site.home.banner_label;
  const bannerTitle = site.home.banner_title;
  const browsePath = publicHomeBrowsePath(site, embedded);
  const entrance = useHomeEntrance(
    background,
    catalogRef,
    navigationHadAppearedBeforeMount || !navigationMotionAllowed
  );
  useDocumentMotionPause();

  useLayoutEffect(() => {
    if (entrance.navigationRevealed) markNavigationAppeared();
  }, [
    entrance.navigationRevealed,
    markNavigationAppeared
  ]);

  const startupFeedbackSettled =
    entrance.backgroundReady
      || entrance.deadlineReached
      || entrance.heroRevealed;

  return (
    <main className={`page home-page${embedded ? " is-embedded" : ""}`}>
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
          startupFeedbackSettled ? "is-settled" : ""
        ]
          .filter(Boolean)
          .join(" ")}
        aria-hidden={startupFeedbackSettled ? true : undefined}
      >
        <HomeStartupLoadingText active={!startupFeedbackSettled} />
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
          {!embedded && (
            <AppHeader
              browseSearch={readableFilterSearch(galleryRouteSearchParams(filters))}
              animateEntrance={shouldAnimateNavigation && entrance.navigationRevealed}
            />
          )}
          <HomeFilterBar
            entranceReady={entrance.navigationRevealed}
            filters={filters}
            browsePath={browsePath}
            stats={stats}
            facets={facets}
            isPending={statsQuery.isPending}
            isError={statsQuery.isError}
            isPlaceholderData={statsQuery.isPlaceholderData}
            onFiltersChange={updateFilters}
          />
        </div>
      </div>
      <div className="home-filter-bar-spacer" aria-hidden="true" />
      <HomeHero
        revealed={entrance.heroRevealed}
        bannerLabel={bannerLabel}
        bannerTitle={bannerTitle}
        stats={stats}
        catalogRef={catalogRef}
        onCatalogIntent={entrance.revealImmediately}
      />
      <HomeCatalog
        catalogRef={catalogRef}
        armed={entrance.catalogArmed}
        filters={filters}
        stats={stats}
        facets={facets}
        isPending={statsQuery.isPending || facetsQuery.isPending}
        isError={catalogFailed}
        isRefreshing={statsQuery.isFetching}
        availabilityUnverified={statsQuery.availabilityUnverified}
        onFiltersChange={updateFilters}
        tagMode={tagMode}
        onTagModeChange={setTagMode}
        onRetry={() => {
          if (statsQuery.isError) void statsQuery.refetch();
          if (facetsQuery.isError) void facetsQuery.refetch();
        }}
        onCatalogIntent={entrance.revealImmediately}
      />
      <HomeFooter site={site} embedded={embedded} />
    </main>
  );
}
