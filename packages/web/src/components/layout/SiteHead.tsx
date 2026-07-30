import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router";
import { adminBasePath } from "../../lib/constants.js";
import { useSiteConfig } from "../../lib/api/site-data.js";

type BrowserAppearance = "dark" | "light";

const browserSurfaceFallback: Record<BrowserAppearance, string> = {
  dark: "#070b15",
  light: "#f5f6f8"
};

function ensureMeta(name: string) {
  let meta = document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = name;
    document.head.appendChild(meta);
  }
  return meta;
}

function isAdminRoute(pathname: string) {
  return pathname === adminBasePath
    || pathname.startsWith(`${adminBasePath}/`);
}

function routeAppearance(pathname: string): BrowserAppearance {
  return isAdminRoute(pathname) ? "light" : "dark";
}

export function SiteHead() {
  const { pathname } = useLocation();
  const { data } = useSiteConfig();
  const site = data?.site;

  useLayoutEffect(() => {
    const appearance = routeAppearance(pathname);
    const root = document.documentElement;
    root.dataset.colorScheme = appearance;
    root.classList.toggle("public-page-document", !isAdminRoute(pathname));
    ensureMeta("color-scheme").content = appearance;

    const browserSurface = getComputedStyle(root).backgroundColor.trim()
      || browserSurfaceFallback[appearance];
    ensureMeta("theme-color").content = browserSurface;
  }, [pathname]);

  useEffect(() => {
    if (!site) return;
    document.title = site.name || "ImageShow";
    const description = ensureMeta("description");
    description.content = site.home.tagline || site.name || "ImageShow";

    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = site.icon_url.endsWith(".svg") ? "image/svg+xml" : "";
    link.href = site.icon_url || "/assets/brand/favicon.svg";
  }, [site?.name, site?.home.tagline, site?.icon_url]);
  return null;
}
