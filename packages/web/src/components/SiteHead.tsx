import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api.js";
import { defaultSite, queryKeys } from "../lib/constants.js";
import type { SiteConfig } from "../lib/types.js";

export function SiteHead() {
  const { data } = useQuery<SiteConfig>({ queryKey: queryKeys.siteConfig, queryFn: () => api("/api/site-config") });
  const site = data?.site ?? defaultSite;
  useEffect(() => {
    document.title = site.name || defaultSite.name;
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.type = site.icon_url.endsWith(".svg") ? "image/svg+xml" : "";
    link.href = site.icon_url || defaultSite.icon_url;
  }, [site.name, site.icon_url]);
  return null;
}
