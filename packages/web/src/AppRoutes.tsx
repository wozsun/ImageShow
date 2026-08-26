import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { adminBasePath, publicRootPath } from "./lib/constants.js";
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
const publicRoutePreloadIntents = createPublicRoutePreloadIntents(
  homeRouteModule,
  galleryRouteModule
);
const HomePage = lazy(() => homeRouteModule.load().then((module) => ({ default: module.HomePage })));
const GalleryPage = lazy(() => galleryRouteModule.load().then((module) => ({ default: module.GalleryPage })));
const AdminShell = lazy(() => import("./pages/admin/shell/AdminShell.js").then((module) => ({ default: module.AdminShell })));

export function AppRoutes() {
  const routeLocation = useLocation();
  const siteConfig = useSiteConfig();
  const { data } = siteConfig;
  if (siteConfig.isError) return <QueryErrorState error={siteConfig.error} onRetry={() => void siteConfig.refetch()} fullPage />;
  if (!data) return <AppLoadingScreen />;
  const rootPath = publicRootPath(data.site);
  return (
    <PublicRoutePreloadProvider intents={publicRoutePreloadIntents}>
      <RouteLoadBoundary resetKey={routeLocation.pathname} fullPage>
        <Suspense fallback={<AppLoadingScreen />}>
          <Routes>
            <Route path="/" element={rootPath === "/home" ? <HomePage /> : <GalleryPage />} />
            <Route
              path="/home"
              element={data.site.home.enabled === false ? <Navigate to="/gallery" replace /> : <HomePage />}
            />
            <Route path="/gallery" element={<GalleryPage />} />
            <Route
              path="/embed/home"
              element={
                !data.embed.enabled
                  ? <Navigate to="/" replace />
                  : data.site.home.enabled === false
                    ? <Navigate to="/embed/gallery" replace />
                    : <HomePage embedded />
              }
            />
            <Route
              path="/embed/gallery"
              element={data.embed.enabled
                ? <GalleryPage embedded />
                : <Navigate to="/" replace />}
            />
            <Route path={`${adminBasePath}/*`} element={<AdminShell />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </RouteLoadBoundary>
    </PublicRoutePreloadProvider>
  );
}
