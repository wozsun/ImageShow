import type { Context } from "hono";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { robotsCacheControl } from "../core/http/headers.ts";
import { specialHost, themeFromHost } from "../themes/host.ts";

export function serveRobotsTxt(context: Context) {
  if (!getRuntimeConfig().site.robots_enabled) {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  const host = context.req.header("host") ?? "";
  const special = specialHost(host);

  if (special === "docs") {
    return robotsResponse(context, "User-agent: *\nAllow: /\n");
  }
  if (special || themeFromHost(host)) {
    return robotsResponse(context, "User-agent: *\nDisallow: /\n");
  }

  const body = getRuntimeConfig().site.home.enabled
    ? "User-agent: *\nAllow: /$\nAllow: /home\nDisallow: /\n"
    : "User-agent: *\nDisallow: /\n";
  return robotsResponse(context, body);
}

function robotsResponse(context: Context, body: string) {
  context.header("Content-Type", "text/plain; charset=utf-8");
  context.header("Cache-Control", robotsCacheControl);
  return context.body(body);
}
