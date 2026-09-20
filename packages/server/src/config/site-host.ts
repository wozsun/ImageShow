import { hasExplicitSiteDomain, matchesSiteHost } from "../core/url-validation.ts";
import { getRuntimeConfig } from "./runtime-config-store.ts";

export function isAllowedSiteHost(hostHeader: string) {
  return matchesSiteHost(hostHeader, getRuntimeConfig().site.domain);
}

export function imageResourceBaseUrl() {
  const site = getRuntimeConfig().site;
  // Same-origin paths follow the request Host without storing it in shared DTOs.
  if (!hasExplicitSiteDomain(site.domain)) return "/images";
  return `https://${site.domain}/images`;
}
