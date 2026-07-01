import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { adminBasePath, publicHomePath } from "./lib/constants.js";
import { themeFromHostname, rootSiteOrigin } from "./lib/theme-host.js";
import { useGalleryOptions, useSiteConfig } from "./lib/site-data.js";

// Route components are code-split: a public visitor on /home or /gallery never downloads the
// (much larger) admin bundle, and each page loads as its own lazy chunk under Suspense.
const HomePage = lazy(() => import("./pages/HomePage.js").then((module) => ({ default: module.HomePage })));
const GalleryPage = lazy(() => import("./pages/GalleryPage.js").then((module) => ({ default: module.GalleryPage })));
const ThemeHostPage = lazy(() => import("./pages/GalleryPage.js").then((module) => ({ default: module.ThemeHostPage })));
const AdminShell = lazy(() => import("./pages/AdminShell.js").then((module) => ({ default: module.AdminShell })));

export function AppRoutes() {
  // site-config drives routing; gallery-options is only needed by the theme-host branch but is
  // fetched in parallel (no enabled-gate) so the first paint doesn't serialize the two requests.
  const { data } = useSiteConfig();
  const { data: options } = useGalleryOptions();
  if (!data) return <div className="center">加载中</div>;
  const fixedTheme = themeFromHostname(window.location.hostname, data.site.domain);
  if (fixedTheme) {
    if (!options) return <div className="center">加载中</div>;
    if (!options.themes.some((theme) => theme.slug === fixedTheme)) {
      window.location.replace(rootSiteOrigin(data.site.domain));
      return <div className="center">跳转中</div>;
    }
    return (
      <Suspense fallback={<div className="center">加载中</div>}>
        <Routes>
          <Route path="*" element={<ThemeHostPage theme={fixedTheme} />} />
        </Routes>
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<div className="center">加载中</div>}>
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        {/* Home off ⇒ /home steps aside for the gallery; the HomePage component never mounts. */}
        <Route
          path="/home"
          element={data.site.home_enabled === false ? <Navigate to="/gallery" replace /> : <HomePage />}
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
