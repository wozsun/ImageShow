import { getRuntimeConfig } from "./runtime-config-store.ts";

type HostParts = { hostname: string; port: string };

export function hasExplicitSiteDomain(domain: string) {
  return domain !== "" && domain !== "example.com";
}

export function isAllowedSiteHost(hostHeader: string) {
  const raw = hostHeader.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(raw)) return false;
  const current = splitHost(raw);
  const site = getRuntimeConfig().site;
  if (!current.hostname) return false;
  if (current.port && (Number(current.port) < 1 || Number(current.port) > 65_535)) return false;
  if (!hasExplicitSiteDomain(site.domain)) return true;
  const root = splitHost(site.domain);
  return current.hostname === root.hostname && (!root.port || current.port === root.port);
}

export function imageResourceBaseUrl() {
  const site = getRuntimeConfig().site;
  // Same-origin paths follow the request Host without storing it in shared DTOs.
  if (!hasExplicitSiteDomain(site.domain)) return "/images";
  return `https://${site.domain}/images`;
}

function splitHost(value: string): HostParts {
  const raw = value.trim().toLowerCase();
  if (!raw) return { hostname: "", port: "" };
  const portMatch = /:(\d+)$/.exec(raw);
  const port = portMatch?.[1] ?? "";
  const hostname = port ? raw.slice(0, -port.length - 1) : raw;
  return { hostname, port };
}
