import { configuredSiteDomains, hasExplicitSiteDomain, matchesSiteHost } from "../core/url-validation.ts";
import { getRuntimeConfig } from "./runtime-config-store.ts";

export function isAllowedSiteHost(hostHeader: string) {
  const site = getRuntimeConfig().site;
  if (!hasExplicitSiteDomain(site.domain)) return matchesSiteHost(hostHeader, "");
  return configuredSiteDomains(site).some((domain) => matchesSiteHost(hostHeader, domain));
}

export function imageResourceBaseUrl() {
  const site = getRuntimeConfig().site;
  // Same-origin paths follow the request Host without storing it in shared DTOs.
  if (!hasExplicitSiteDomain(site.domain)) return "/images";
  return `https://${site.domain}/images`;
}

export function staticResourceBaseUrl(config = getRuntimeConfig()) {
  return config.site.assets_base_url || "/assets";
}
