import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { adminBasePath, publicHomeBrowsePath, publicRootPath } from "./lib/constants.js";
import { useSiteConfig } from "./lib/api/site-data.js";
import { QueryErrorState } from "./components/feedback/QueryErrorState.js";
import { RouteLoadBoundary } from "./components/feedback/RouteLoadBoundary.js";
import { AppLoadingScreen } from "./components/feedback/AppLoadingScreen.js";
import {
  createPublicRouteModuleLoader,
  createPublicRoutePreloadIntents,
  PublicRoutePreloadProvider
} from "./lib/public-route-modules.js";

const homeRouteModule = createPublicRouteModuleLoader(
  () => import("./pages/home/HomePage.js")
);
const galleryRouteModule = createPublicRouteModuleLoader(
  () => import("./pages/gallery/GalleryPage.js")
);
const showRouteModule = createPublicRouteModuleLoader(
  () => import("./pages/show/ShowRoutePage.js")
);
const publicRoutePreloadIntents = createPublicRoutePreloadIntents(
  homeRouteModule,
  showRouteModule,
  galleryRouteModule
);
const HomePage = lazy(() => homeRouteModule.load().then((module) => ({ default: module.HomePage })));
const GalleryPage = lazy(() => galleryRouteModule.load().then((module) => ({ default: module.GalleryPage })));
const ShowPage = lazy(() => showRouteModule.load().then((module) => ({
  default: module.ShowRoutePage
})));
const AdminShell = lazy(() => import("./pages/admin/shell/AdminShell.js").then((module) => ({ default: module.AdminShell })));

function PublicPageNotFound() {
  return (
    <main className="center" role="main">
      <div className="query-error-state">
        <strong>404</strong>
        <p>当前没有启用的公开页面</p>
      </div>
    </main>
  );
}

function publicFallback(rootPath: ReturnType<typeof publicRootPath>) {
  return rootPath
    ? <Navigate to={rootPath} replace />
    : <PublicPageNotFound />;
}

export function AppRoutes() {
  const routeLocation = useLocation();
  const siteConfig = useSiteConfig();
  const { data } = siteConfig;
  if (!data) {
    if (siteConfig.isError) return <QueryErrorState error={siteConfig.error} onRetry={() => void siteConfig.refetch()} fullPage />;
    return <AppLoadingScreen />;
  }
  const rootPath = publicRootPath(data.site);
  const embeddedBrowsePath = publicHomeBrowsePath(data.site, true);
  return (
    <PublicRoutePreloadProvider intents={publicRoutePreloadIntents}>
      <RouteLoadBoundary resetKey={routeLocation.pathname} fullPage>
        <Suspense fallback={<AppLoadingScreen />}>
          <Routes>
            <Route
              path="/"
              element={rootPath === "/home"
                ? <HomePage site={data.site} />
                : rootPath === "/show"
                  ? <ShowPage settings={data.site.show} />
                  : rootPath === "/gallery"
                    ? <GalleryPage order={data.site.gallery.order} />
                    : <PublicPageNotFound />}
            />
            <Route
              path="/home"
              element={data.site.home.enabled === false
                ? publicFallback(rootPath)
                : <HomePage site={data.site} />}
            />
            <Route
              path="/gallery"
              element={data.site.gallery.enabled
                ? <GalleryPage order={data.site.gallery.order} />
                : publicFallback(rootPath)}
            />
            <Route
              path="/show"
              element={data.site.show.enabled
                ? <ShowPage settings={data.site.show} />
                : publicFallback(rootPath)}
            />
            <Route
              path="/embed/home"
              element={
                !data.embed.enabled
                  ? publicFallback(rootPath)
                  : data.site.home.enabled === false
                    ? embeddedBrowsePath
                      ? <Navigate to={embeddedBrowsePath} replace />
                      : publicFallback(rootPath)
                    : <HomePage embedded site={data.site} />
              }
            />
            <Route
              path="/embed/show"
              element={data.embed.enabled && data.site.show.enabled
                ? <ShowPage embedded settings={data.site.show} />
                : publicFallback(rootPath)}
            />
            <Route
              path="/embed/gallery"
              element={data.embed.enabled && data.site.gallery.enabled
                ? <GalleryPage embedded order={data.site.gallery.order} />
                : publicFallback(rootPath)}
            />
            <Route path={`${adminBasePath}/*`} element={<AdminShell siteName={data.site.name} />} />
            <Route path="*" element={publicFallback(rootPath)} />
          </Routes>
        </Suspense>
      </RouteLoadBoundary>
    </PublicRoutePreloadProvider>
  );
}
