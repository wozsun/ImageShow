import { useQuery } from "@tanstack/react-query";
import { Navigate, Route, Routes } from "react-router-dom";
import { api } from "./lib/api.js";
import { adminBasePath, queryKeys } from "./lib/constants.js";
import { themeFromHostname, rootSiteOrigin } from "./lib/theme-host.js";
import type { GalleryOptions, SiteConfig } from "./lib/types.js";
import { AdminShell } from "./pages/AdminShell.js";
import { GalleryPage, ThemeHostPage } from "./pages/GalleryPage.js";
import { HomePage } from "./pages/HomePage.js";

export function AppRoutes() {
  const { data } = useQuery<SiteConfig>({ queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config") });
  const { data: options } = useQuery<GalleryOptions>({ queryKey: queryKeys.galleryOptions, queryFn: () => api("/api/gallery-options"), enabled: Boolean(data) });
  if (!data) return <div className="center">加载中</div>;
  const fixedTheme = themeFromHostname(window.location.hostname, data.site.domain);
  if (fixedTheme) {
    if (!options) return <div className="center">加载中</div>;
    if (!options.themes.includes(fixedTheme)) {
      window.location.replace(rootSiteOrigin(data.site.domain));
      return <div className="center">跳转中</div>;
    }
    return (
      <Routes>
        <Route path="*" element={<ThemeHostPage theme={fixedTheme} />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/home" element={<HomePage />} />
      <Route path="/gallery" element={<GalleryPage />} />
      <Route path={`${adminBasePath}/*`} element={<AdminShell />} />
    </Routes>
  );
}

function RootRedirect() {
  const { data } = useQuery<SiteConfig>({ queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config") });
  if (!data) return <div className="center">加载中</div>;
  return <Navigate to={data.site.root_redirect === "gallery" ? "/gallery" : "/home"} replace />;
}
