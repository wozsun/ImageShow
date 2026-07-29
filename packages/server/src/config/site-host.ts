import { getRuntimeConfig } from "./runtime-config-store.ts";

type HostParts = { hostname: string; port: string };

function reservedPrefixes() {
  const site = getRuntimeConfig().site;
  return {
    random: site.random_subdomain,
    static: site.static_subdomain,
    link: site.link_subdomain
  };
}

function reservedPrefixList() {
  const reserved = reservedPrefixes();
  return [reserved.random, reserved.static, reserved.link];
}

function hostPrefix(hostHeader: string) {
  const current = splitHost(hostHeader);
  const root = splitHost(getRuntimeConfig().site.domain);
  if (!current.hostname || !root.hostname || !current.hostname.endsWith(`.${root.hostname}`)) return "";
  return current.hostname.slice(0, -root.hostname.length - 1);
}

export function isAllowedSiteHost(hostHeader: string) {
  const raw = hostHeader.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(?::\d{1,5})?$/.test(raw)) return false;
  const current = splitHost(raw);
  const root = splitHost(getRuntimeConfig().site.domain);
  if (!current.hostname || !root.hostname) return false;
  if (current.port && (Number(current.port) < 1 || Number(current.port) > 65_535)) return false;
  if (root.port && current.port !== root.port) return false;
  if (current.hostname === root.hostname) return true;
  if (!current.hostname.endsWith(`.${root.hostname}`)) return false;
  const prefix = current.hostname.slice(0, -root.hostname.length - 1);
  return reservedPrefixList().includes(prefix);
}

export function specialHost(hostHeader: string): "random" | "static" | "link" | "" {
  const prefix = hostPrefix(hostHeader);
  if (!prefix) return "";
  const reserved = reservedPrefixes();
  if (prefix === reserved.random) return "random";
  if (prefix === reserved.static) return "static";
  if (prefix === reserved.link) return "link";
  return "";
}

export function staticLocalBaseUrl() {
  const site = getRuntimeConfig().site;
  return `https://${site.static_subdomain}.${site.domain}`;
}

export function linkBaseUrl() {
  const site = getRuntimeConfig().site;
  return `https://${site.link_subdomain}.${site.domain}`;
}

function splitHost(value: string): HostParts {
  const raw = value.trim().toLowerCase();
  if (!raw) return { hostname: "", port: "" };
  const portMatch = /:(\d+)$/.exec(raw);
  const port = portMatch?.[1] ?? "";
  const hostname = port ? raw.slice(0, -port.length - 1) : raw;
  return { hostname, port };
}
