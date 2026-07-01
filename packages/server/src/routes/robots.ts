import type { Context } from "hono";
import { getRuntimeConfig } from "../config/env.js";
import { noCacheControl, routeError } from "../core/http.js";
import { specialHost, themeFromHost } from "../themes/host.js";

// Host-aware robots.txt, opt-in via site.robots_enabled (default off). While off the app publishes NO
// robots.txt — /robots.txt 404s on every host, so crawlers see no rules at all. Once on, the main
// site exposes only its homepage (the site description) — not the gallery / API / assets / admin;
// resource and theme-gallery hosts (static / link / random / <theme>.<domain>) block everything; the
// docs host is fully crawlable. Served from live config + no-cache so a config change shows on the
// next fetch. Registered before the host guards (index.ts) so it answers on every host.
export function serveRobotsTxt(c: Context) {
  // Opt-in: with crawling disabled (the default) the app publishes no robots.txt — 404 on every host.
  if (!getRuntimeConfig().site.robots_enabled) return routeError({ status: 404, message: "Not Found" });
  const host = c.req.header("host") ?? "";
  const special = specialHost(host);
  // Documentation should be findable; everything the docs host serves is public reference material.
  if (special === "docs") return robotsResponse(c, "User-agent: *\nAllow: /\n");
  // Resource / API hosts and theme-gallery subdomains expose only image resources — block all.
  if (special || themeFromHost(host)) return robotsResponse(c, "User-agent: *\nDisallow: /\n");
  // Main site: whitelist just the homepage (site description). "/" is allowed too so a crawler can
  // follow its redirect to /home; with the homepage disabled there is no description page to expose.
  const body = getRuntimeConfig().site.home_enabled
    ? "User-agent: *\nAllow: /$\nAllow: /home\nDisallow: /\n"
    : "User-agent: *\nDisallow: /\n";
  return robotsResponse(c, body);
}

function robotsResponse(c: Context, body: string) {
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", noCacheControl);
  return c.body(body);
}
