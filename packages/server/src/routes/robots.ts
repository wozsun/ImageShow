import type { Context } from "hono";
import { getRuntimeConfig } from "../config/env.js";
import { robotsCacheControl, routeError } from "../core/http.js";
import { specialHost, themeFromHost } from "../themes/host.js";

export function serveRobotsTxt(c: Context) {

  if (!getRuntimeConfig().site.robots_enabled) return routeError({ status: 404, message: "Not Found" });
  const host = c.req.header("host") ?? "";
  const special = specialHost(host);

  if (special === "docs") return robotsResponse(c, "User-agent: *\nAllow: /\n");

  if (special || themeFromHost(host)) return robotsResponse(c, "User-agent: *\nDisallow: /\n");

  const body = getRuntimeConfig().site.home.enabled
    ? "User-agent: *\nAllow: /$\nAllow: /home\nDisallow: /\n"
    : "User-agent: *\nDisallow: /\n";
  return robotsResponse(c, body);
}

function robotsResponse(c: Context, body: string) {
  c.header("Content-Type", "text/plain; charset=utf-8");
  c.header("Cache-Control", robotsCacheControl);
  return c.body(body);
}
