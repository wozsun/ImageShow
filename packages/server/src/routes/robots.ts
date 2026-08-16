import type { Context } from "hono";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import {
  apiErrorResponse,
  cacheableContentResponse
} from "../core/http/responses.ts";
import { robotsCacheControl } from "../core/http/headers.ts";
import { isStaticSiteHost } from "../config/site-host.ts";

export function serveRobotsTxt(context: Context) {
  if (!getRuntimeConfig().site.robots_enabled) {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  const host = context.req.header("host") ?? "";

  if (isStaticSiteHost(host)) {
    return robotsResponse(context, "User-agent: *\nDisallow: /\n");
  }

  const body = getRuntimeConfig().site.home.enabled
    ? "User-agent: *\nAllow: /$\nAllow: /home\nDisallow: /\n"
    : "User-agent: *\nDisallow: /\n";
  return robotsResponse(context, body);
}

function robotsResponse(context: Context, body: string) {
  return cacheableContentResponse(context, body, {
    cacheControl: robotsCacheControl,
    contentType: "text/plain; charset=utf-8"
  });
}
