import { useEffect, useLayoutEffect } from "react";
import { useLocation } from "react-router";
import { adminBasePath } from "../../lib/constants.js";
import { useSiteConfig } from "../../lib/api/site-data.js";
import { applyUiColorContext } from "../../lib/ui/apply-ui-color-context.js";

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
