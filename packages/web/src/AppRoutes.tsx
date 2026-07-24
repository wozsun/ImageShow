import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { adminBasePath, publicRootPath } from "./lib/constants.js";
import { themeFromHostname } from "./lib/gallery/theme-host.js";
import { useGalleryFacets, useSiteConfig } from "./lib/api/site-data.js";
import { QueryErrorState } from "./components/feedback/QueryErrorState.js";
import { RouteLoadBoundary } from "./components/feedback/RouteLoadBoundary.js";

const HomePage = lazy(() => import("./pages/home/HomePage.js").then((module) => ({ default: module.HomePage })));
const GalleryPage = lazy(() => import("./pages/gallery/GalleryPage.js").then((module) => ({ default: module.GalleryPage })));
const ThemeHostPage = lazy(() => import("./pages/gallery/GalleryPage.js").then((module) => ({ default: module.ThemeHostPage })));
const AdminShell = lazy(() => import("./pages/admin/AdminShell.js").then((module) => ({ default: module.AdminShell })));

export function AppRoutes() {
  const routeLocation = useLocation();
  const siteConfig = useSiteConfig();
  const { data } = siteConfig;
  const theme = data ? themeFromHostname(location.hostname, data.site.domain) : "";
  const facetsQuery = useGalleryFacets(Boolean(theme));
  const facets = facetsQuery.data;
  if (siteConfig.isError) return <QueryErrorState error={siteConfig.error} onRetry={() => void siteConfig.refetch()} fullPage />;
  if (!data) return <div className="center">加载中</div>;
  if (theme) {
    if (facetsQuery.isError) return <QueryErrorState error={facetsQuery.error} onRetry={() => void facetsQuery.refetch()} fullPage />;
    if (!facets) return <div className="center">加载中</div>;
    if (!facets.themes.some((item) => item.slug === theme)) return <Navigate to="/" replace />;
    return (
      <RouteLoadBoundary resetKey={routeLocation.pathname} fullPage>
        <Suspense fallback={<div className="center">加载中</div>}>
          <Routes>
            <Route path="*" element={<ThemeHostPage theme={theme} />} />
          </Routes>
        </Suspense>
      </RouteLoadBoundary>
    );
  }
  const rootPath = publicRootPath(data.site);
  return (
    <RouteLoadBoundary resetKey={routeLocation.pathname} fullPage>
      <Suspense fallback={<div className="center">加载中</div>}>
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
