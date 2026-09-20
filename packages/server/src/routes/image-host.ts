import type { Context, MiddlewareHandler } from "hono";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { isAllowedSiteHost } from "../config/site-host.ts";
import { hasExplicitSiteDomain, matchesSiteHost } from "../core/url-validation.ts";
import { publishedLocalPublicUrl } from "../storage/backends/registry.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { noStoreCacheControl } from "../core/http/headers.ts";
import { serveLocalStoredObject } from "../images/stored-image-serving.ts";
import { parseImageObjectKey, thumbnailObjectKey } from "../storage/objects/image-paths.ts";

const corsRequestHeaders = new Set(["range", "if-none-match", "if-modified-since", "if-range"]);

async function serveLocalImageHost(c: Context, base: URL) {
  const path = new URL(c.req.url).pathname;
  const root = base.pathname.replace(/\/+$/, "");
  const prefix = path.startsWith(`${root}/full/`) ? "full"
    : path.startsWith(`${root}/thumbs/`) ? "thumbs" : null;
  const key = prefix ? path.slice(`${root}/${prefix}/`.length) : "";
  const parsed = parseImageObjectKey(key);
  if (!prefix || !parsed || (prefix === "thumbs" && thumbnailObjectKey(parsed.id) !== key)) {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  const method = c.req.method;
  let response: Response;
  if (method === "OPTIONS") {
    const requestedMethod = c.req.header("access-control-request-method") ?? "";
    const requestedHeaders = (c.req.header("access-control-request-headers") ?? "")
      .toLowerCase().split(",").map((header) => header.trim()).filter(Boolean);
    if (!["GET", "HEAD"].includes(requestedMethod)
      || requestedHeaders.some((header) => !corsRequestHeaders.has(header))) {
      return apiErrorResponse({ status: 403, message: "Unsupported image preflight" });
    }
    response = new Response(null, { status: 204, headers: {
      "Cache-Control": noStoreCacheControl,
      "Access-Control-Allow-Methods": "GET, HEAD",
      "Access-Control-Allow-Headers": [...corsRequestHeaders].join(", ")
    } });
  } else if (method === "GET" || method === "HEAD") {
    response = await serveLocalStoredObject(prefix, key, {
      range: c.req.header("range"),
      ifNoneMatch: c.req.header("if-none-match"),
      ifModifiedSince: c.req.header("if-modified-since"),
      ifRange: c.req.header("if-range"),
      isHead: method === "HEAD",
      signal: c.req.raw.signal
    });
  } else {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Expose-Headers", "ETag, Content-Range, Accept-Ranges");
  return response;
}

export function imageHostBoundary(businessGateIsOpen: () => boolean): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!matchesSiteHost(host, "")) return apiErrorResponse({ status: 404, message: "Not Found" });
    const isMain = isAllowedSiteHost(host);
    let localBase: URL | null = null;
    if (!hasExplicitSiteDomain(getRuntimeConfig().site.domain) || !isMain) {
      const publicUrl = publishedLocalPublicUrl();
      if (publicUrl) {
        const base = new URL(publicUrl);
        const authority = host.toLowerCase();
        if (authority === base.host || (!base.port && authority === `${base.hostname}:443`)) localBase = base;
      }
    }
    if (!isMain && !localBase) return apiErrorResponse({ status: 404, message: "Not Found" });
    const healthRequest = !localBase && (c.req.path === "/livez" || c.req.path === "/readyz");
    if (!healthRequest && !businessGateIsOpen()) {
      return apiErrorResponse({
        status: 503, code: "redis_unavailable", message: "Redis cold-start validation has not completed"
      }, { phase: "cold_start" });
    }
    if (localBase) return serveLocalImageHost(c, localBase);
    await next();
  };
}
