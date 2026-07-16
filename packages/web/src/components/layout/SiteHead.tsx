import { useEffect } from "react";
import { useSiteConfig } from "../../lib/api/site-data.js";

export function SiteHead() {
  const { data } = useSiteConfig();
  const site = data?.site;
  useEffect(() => {
    if (!site) return;
    document.title = site.name || "ImageShow";
    let description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (!description) {
      description = document.createElement("meta");
      description.name = "description";
      document.head.appendChild(description);
    }
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
