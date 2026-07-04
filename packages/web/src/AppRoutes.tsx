import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { adminBasePath, publicHomePath } from "./lib/constants.js";
import { themeFromHostname, rootSiteOrigin } from "./lib/gallery/theme-host.js";
import { useGalleryFacets, useSiteConfig } from "./lib/api/site-data.js";

const HomePage = lazy(() => import("./pages/HomePage.js").then((module) => ({ default: module.HomePage })));
const GalleryPage = lazy(() => import("./pages/GalleryPage.js").then((module) => ({ default: module.GalleryPage })));
const ThemeHostPage = lazy(() => import("./pages/GalleryPage.js").then((module) => ({ default: module.ThemeHostPage })));
const AdminShell = lazy(() => import("./pages/AdminShell.js").then((module) => ({ default: module.AdminShell })));

export function AppRoutes() {
  const { data } = useSiteConfig();
  const theme = data ? themeFromHostname(location.hostname, rootSiteOrigin(data.site.domain)) : "";
  const { data: facets } = useGalleryFacets(Boolean(theme));
  if (!data) return <div className="center">加载中</div>;
  if (theme) {
    if (!facets) return <div className="center">加载中</div>;
    if (!facets.themes.some((item) => item.slug === theme)) return <Navigate to="/" replace />;
    return (
      <Suspense fallback={<div className="center">加载中</div>}>
        <Routes>
          <Route path="*" element={<ThemeHostPage theme={theme} />} />
        </Routes>
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<div className="center">加载中</div>}>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route
          path="/home"
          element={data.site.home.enabled === false ? <Navigate to="/gallery" replace /> : <HomePage />}
        />
        <Route path="/gallery" element={<GalleryPage />} />
        <Route path={`${adminBasePath}/*`} element={<AdminShell />} />
      </Routes>
    </Suspense>
  );
}

function RootRedirect() {
  const { data } = useSiteConfig();
  if (!data) return <div className="center">加载中</div>;
  const target = data.site.root_redirect === "gallery" ? "/gallery" : publicHomePath(data.site);
  return <Navigate to={target} replace />;
}
