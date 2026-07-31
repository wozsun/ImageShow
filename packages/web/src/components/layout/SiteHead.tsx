import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router";
import {
  defaultAdminPreferences,
  type AdminColorScheme
} from "@imageshow/shared/browser";
import { adminBasePath } from "../../lib/constants.js";
import { useSiteConfig } from "../../lib/api/site-data.js";

type BrowserAppearance = "dark" | "light";
export type UiContext = "bootstrap" | "public" | "admin";

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

function syncBrowserSurface(root: HTMLElement) {
  const styles = getComputedStyle(root);
  const browserCanvas = styles.getPropertyValue("--color-browser-canvas").trim();
  const resolvedBackground = styles.backgroundColor.trim();
  ensureMeta("theme-color").content = resolvedBackground || browserCanvas;
}

export function applyUiColorContext(
  uiContext: UiContext,
  adminColorScheme: AdminColorScheme = defaultAdminPreferences.color_scheme
) {
  const appearance: BrowserAppearance =
    uiContext === "admin" ? adminColorScheme : "dark";
  const root = document.documentElement;
  root.dataset.uiContext = uiContext;
  root.dataset.colorScheme = appearance;
  root.classList.toggle("public-page-document", uiContext === "public");
  ensureMeta("color-scheme").content = appearance;
  syncBrowserSurface(root);
}

export function SiteHead() {
  const { pathname } = useLocation();
  const { data } = useSiteConfig();
  const site = data?.site;

  useLayoutEffect(() => {
    const root = document.documentElement;
    if (isAdminRoute(pathname)) {
      if (root.dataset.uiContext !== "admin") {
        applyUiColorContext("bootstrap");
      }
      return;
    }
    applyUiColorContext("public");
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
