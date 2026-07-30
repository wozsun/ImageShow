import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router";
import { adminBasePath, publicRootPath } from "./lib/constants.js";
import { useSiteConfig } from "./lib/api/site-data.js";
import { QueryErrorState } from "./components/feedback/QueryErrorState.js";
import { RouteLoadBoundary } from "./components/feedback/RouteLoadBoundary.js";
import { AppLoadingScreen } from "./components/feedback/AppLoadingScreen.js";

const HomePage = lazy(() => import("./pages/home/HomePage.js").then((module) => ({ default: module.HomePage })));
const GalleryPage = lazy(() => import("./pages/gallery/GalleryPage.js").then((module) => ({ default: module.GalleryPage })));
const AdminShell = lazy(() => import("./pages/admin/AdminShell.js").then((module) => ({ default: module.AdminShell })));

export function AppRoutes() {
  const routeLocation = useLocation();
  const siteConfig = useSiteConfig();
  const { data } = siteConfig;
  if (siteConfig.isError) return <QueryErrorState error={siteConfig.error} onRetry={() => void siteConfig.refetch()} fullPage />;
  if (!data) return <AppLoadingScreen />;
  const rootPath = publicRootPath(data.site);
  return (
    <RouteLoadBoundary resetKey={routeLocation.pathname} fullPage>
      <Suspense fallback={<AppLoadingScreen />}>
        <Routes>
          <Route path="/" element={rootPath === "/home" ? <HomePage /> : <GalleryPage />} />
          <Route
            path="/home"
            element={data.site.home.enabled === false ? <Navigate to="/gallery" replace /> : <HomePage />}
          />
          <Route path="/gallery" element={<GalleryPage />} />
          <Route path={`${adminBasePath}/*`} element={<AdminShell />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </RouteLoadBoundary>
  );
}
