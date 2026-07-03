import { useEffect } from "react";
import { defaultSite } from "../../lib/constants.js";
import { useSiteConfig } from "../../lib/api/site-data.js";

export function SiteHead() {
  const { data } = useSiteConfig();
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
