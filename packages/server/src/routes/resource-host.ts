import type { Context, MiddlewareHandler } from "hono";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { isAllowedSiteHost } from "../config/site-host.ts";
import { hasExplicitSiteDomain, matchesSiteHost, publicUrlMatchesHost } from "../core/url-validation.ts";
import { publishedLocalPublicUrl } from "../storage/backends/registry.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { noStoreCacheControl } from "../core/http/headers.ts";
import { serveLocalStoredObject } from "../images/stored-image-serving.ts";
import { parseImageObjectKey, thumbnailObjectKey } from "../storage/objects/image-paths.ts";
import type { AssetHandler } from "./spa.ts";

const corsRequestHeaders = new Set(["range", "if-none-match", "if-modified-since", "if-range"]);

function resourcePreflight(c: Context) {
  const requestedMethod = c.req.header("access-control-request-method") ?? "";
  const requestedHeaders = (c.req.header("access-control-request-headers") ?? "")
    .toLowerCase().split(",").map((header) => header.trim()).filter(Boolean);
  if (!["GET", "HEAD"].includes(requestedMethod)
    || requestedHeaders.some((header) => !corsRequestHeaders.has(header))) {
    return apiErrorResponse({ status: 403, message: "Unsupported resource preflight" });
  }
  return new Response(null, { status: 204, headers: {
    "Cache-Control": noStoreCacheControl,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD",
    "Access-Control-Allow-Headers": [...corsRequestHeaders].join(", ")
  } });
}

function localImageObject(path: string, base: URL) {
  const root = base.pathname.replace(/\/+$/, "");
  const prefix = path.startsWith(`${root}/full/`) ? "full"
    : path.startsWith(`${root}/thumbs/`) ? "thumbs" : null;
  const key = prefix ? path.slice(`${root}/${prefix}/`.length) : "";
  const parsed = parseImageObjectKey(key);
  return prefix && parsed && (prefix !== "thumbs" || thumbnailObjectKey(parsed.id) === key)
    ? { prefix, key } as const : null;
}

async function serveLocalImageHost(c: Context, object: NonNullable<ReturnType<typeof localImageObject>>) {
  const { prefix, key } = object;
  const method = c.req.method;
  let response: Response;
  if (method === "OPTIONS") {
    response = resourcePreflight(c);
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

export function resourceHostBoundary(
  businessGateIsOpen: () => boolean,
  serveAssets: AssetHandler
): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host") ?? "";
    if (!matchesSiteHost(host, "")) return apiErrorResponse({ status: 404, message: "Not Found" });
    const isMain = isAllowedSiteHost(host);
    const site = getRuntimeConfig().site;
    let localBase: URL | null = null;
    let assetsBase: URL | null = null;
    if (!hasExplicitSiteDomain(site.domain) || !isMain) {
      const publicUrl = publishedLocalPublicUrl();
      if (publicUrl) {
        const base = new URL(publicUrl);
        if (publicUrlMatchesHost(base, host)) localBase = base;
      }
      if (site.assets_base_url) {
        const base = new URL(site.assets_base_url);
        if (publicUrlMatchesHost(base, host)) assetsBase = base;
      }
    }
    if (!isMain && !localBase && !assetsBase) return apiErrorResponse({ status: 404, message: "Not Found" });
    const healthRequest = !localBase && !assetsBase && (c.req.path === "/livez" || c.req.path === "/readyz");
    if (!healthRequest && !businessGateIsOpen()) {
      return apiErrorResponse({
        status: 503, code: "redis_unavailable", message: "Redis cold-start validation has not completed"
      }, { phase: "cold_start" });
    }
    if (!localBase && !assetsBase) return next();
    // Image and static resource URLs may share a Host with separate namespaces.
    const path = new URL(c.req.url).pathname;
    if (localBase) {
      const object = localImageObject(path, localBase);
      if (object) return serveLocalImageHost(c, object);
    }
    if (assetsBase) {
      const root = assetsBase.pathname.replace(/\/+$/, "");
      if (path.startsWith(`${root}/`)) {
        if (c.req.method === "OPTIONS") return resourcePreflight(c);
        return serveAssets(c, `/assets${path.slice(root.length)}`);
      }
    }
    return apiErrorResponse({ status: 404, message: "Not Found" });
  };
}
