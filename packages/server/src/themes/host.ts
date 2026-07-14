import type { Context, Next } from "hono";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { getGalleryFilterOptions } from "../random/random-cache.ts";
import { noStoreCacheControl } from "../core/http.ts";

type HostParts = { hostname: string; port: string };
const validatedThemeRequests = new WeakSet<Request>();

function reservedPrefixes() {
  const site = getRuntimeConfig().site;
  return { random: site.random_subdomain, static: site.static_subdomain, docs: site.docs_subdomain, link: site.link_subdomain };
}

function reservedPrefixList() {
  const reserved = reservedPrefixes();
  return [reserved.random, reserved.static, reserved.docs, reserved.link];
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
  return !prefix.includes(".") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix);
}

export function themeFromHost(hostHeader: string) {
  const prefix = hostPrefix(hostHeader);
  if (reservedPrefixList().includes(prefix)) return "";
  return prefix && !prefix.includes(".") && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix) ? prefix : "";
}

export function specialHost(hostHeader: string): "random" | "static" | "docs" | "link" | "" {
  const prefix = hostPrefix(hostHeader);
  if (!prefix) return "";
  const reserved = reservedPrefixes();
  if (prefix === reserved.random) return "random";
  if (prefix === reserved.static) return "static";
  if (prefix === reserved.docs) return "docs";
  if (prefix === reserved.link) return "link";
  return "";
}

export function isReservedSubdomain(label: string): boolean {
  return reservedPrefixList().includes(label);
}

export function staticLocalBaseUrl() {
  const site = getRuntimeConfig().site;
  return `https://${site.static_subdomain}.${site.domain}`;
}

export function linkBaseUrl() {
  const site = getRuntimeConfig().site;
  return `https://${site.link_subdomain}.${site.domain}`;
}

export async function existingThemeFromHost(hostHeader: string) {
  const theme = themeFromHost(hostHeader);
  if (!theme) return "";
  const filterOptions = await getGalleryFilterOptions();
  return filterOptions.themes.includes(theme) ? theme : "";
}

export function rootSiteUrl(c: Context, path = "/") {
  const current = splitHost(c.req.header("host") ?? "");
  const configured = splitHost(getRuntimeConfig().site.domain);
  const host = configured.port || !current.port ? configured.hostname : `${configured.hostname}:${current.port}`;
  const protocol = c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":", "");
  const pathname = path.startsWith("/") ? path : `/${path}`;
  return `${protocol}://${host}${pathname}`;
}

export async function enforceThemeHostNavigation(c: Context, next: Next) {
  const hostHeader = c.req.header("host") ?? "";
  const requestedTheme = themeFromHost(hostHeader);
  if (!requestedTheme) return next();

  const url = new URL(c.req.url);
  if (isThemeInternalPath(url.pathname)) return next();

  const existingTheme = await existingThemeFromHost(hostHeader);
  if (!existingTheme) return new Response(null, {
    status: 302,
    headers: { Location: rootSiteUrl(c), "Cache-Control": noStoreCacheControl }
  });
  validatedThemeRequests.add(c.req.raw);

  if (url.pathname !== "/" || url.search) {
    const protocol = c.req.header("x-forwarded-proto") || url.protocol.replace(":", "");
    return new Response(null, {
      status: 302,
      headers: { Location: `${protocol}://${hostHeader.split(",")[0]}/`, "Cache-Control": noStoreCacheControl }
    });
  }
  return next();
}

export function isValidatedThemeRequest(c: Context) {
  return validatedThemeRequests.has(c.req.raw);
}

function isThemeInternalPath(pathname: string) {
  return pathname === "/favicon.ico" || ["/api/", "/assets/", "/media/", "/thumbs/"].some((prefix) => pathname.startsWith(prefix));
}

function splitHost(value: string): HostParts {
  const raw = value.trim().toLowerCase();
  if (!raw) return { hostname: "", port: "" };
  const portMatch = /:(\d+)$/.exec(raw);
  const port = portMatch?.[1] ?? "";
  const hostname = port ? raw.slice(0, -port.length - 1) : raw;
  return { hostname, port };
}
