import { getRuntimeConfig } from "./runtime-config-store.ts";

type HostParts = { hostname: string; port: string };
type SiteHostKind = "site" | "static" | "";

function siteHostKind(hostHeader: string): SiteHostKind {
  const raw = hostHeader.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(raw)) return "";
  const current = splitHost(raw);
  const site = getRuntimeConfig().site;
  const root = splitHost(site.domain);
  if (!current.hostname || !root.hostname) return "";
  if (current.port && (Number(current.port) < 1 || Number(current.port) > 65_535)) return "";
  if (root.port && current.port !== root.port) return "";
  if (current.hostname === root.hostname) return "site";
  const staticHostname = `${site.static_subdomain}.${root.hostname}`;
  return current.hostname === staticHostname ? "static" : "";
}

export function isAllowedSiteHost(hostHeader: string) {
  return Boolean(siteHostKind(hostHeader));
}

export function isStaticSiteHost(hostHeader: string) {
  return siteHostKind(hostHeader) === "static";
}

export function staticLocalBaseUrl() {
  const site = getRuntimeConfig().site;
  return `https://${site.static_subdomain}.${site.domain}`;
}

function splitHost(value: string): HostParts {
  const raw = value.trim().toLowerCase();
  if (!raw) return { hostname: "", port: "" };
  const portMatch = /:(\d+)$/.exec(raw);
  const port = portMatch?.[1] ?? "";
  const hostname = port ? raw.slice(0, -port.length - 1) : raw;
  return { hostname, port };
}
