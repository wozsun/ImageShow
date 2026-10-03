import { serveStatic } from "@hono/node-server/serve-static";
import { Context as HonoContext, type Context, type Handler, type Hono } from "hono";
import { join } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";
import { siteConfigPayload } from "../config/app-settings.ts";
import {
  immutableCacheControl,
  noStoreCacheControl,
  publicRedirectCacheControl,
  publicStaticCacheControl,
  safeRedirectLocation,
  setPublicResourceCors
} from "../core/http/headers.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { serveStaticWithValidators } from "../core/http/static-conditional.ts";
import { serveNegotiatedStatic } from "../core/http/static-encoding.ts";

const publicDir = join(import.meta.dirname, "../public");
// Operator files under data/asset: images only, nested folders allowed, no hidden segments.
const customAssetPathPattern =
  /^\/asset(?:\/[^/.][^/]*)+\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i;
// Files are placed by the operator but may be opened directly on the site origin.
const customAssetContentSecurityPolicy = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

export function createAssetHandler() {
  const assetStatic = serveNegotiatedStatic(publicDir);
  return async (c: Context, path = c.req.path): Promise<Response> => {
    if (!path.startsWith("/assets/") || !["GET", "HEAD"].includes(c.req.method)) {
      return apiErrorResponse({ status: 404, message: "Not Found" });
    }
    let context = c;
    if (path !== c.req.path) {
      const url = new URL(c.req.url);
      url.pathname = path;
      context = new HonoContext(
        new Request(url, {
          method: c.req.method,
          headers: c.req.raw.headers,
          signal: c.req.raw.signal
        }),
        { env: c.env, path }
      );
    }
    const response =
      (await serveStaticWithValidators(context, assetStatic)) ??
      apiErrorResponse({ status: 404, message: "Not Found" });
    response.headers.set("Vary", "Accept-Encoding");
    response.headers.set(
      "Cache-Control",
      response.status < 400
        ? path.startsWith("/assets/brand/")
          ? publicStaticCacheControl
          : immutableCacheControl
        : noStoreCacheControl
    );
    setPublicResourceCors(response);
    return response;
  };
}

export type AssetHandler = ReturnType<typeof createAssetHandler>;

function createCustomAssetHandler() {
  // Created on first use: the app is assembled before startup creates data/asset.
  let customAssetStatic: Handler | undefined;
  return async (c: Context): Promise<Response> => {
    customAssetStatic ??= serveStatic({
      root: runtimePaths.assetDirectory,
      rewriteRequestPath: (path) => path.slice("/asset".length)
    });
    const response = customAssetPathPattern.test(c.req.path)
      ? await serveStaticWithValidators(c, customAssetStatic)
      : undefined;
    if (!response) return apiErrorResponse({ status: 404, message: "Not Found" });
    response.headers.set(
      "Cache-Control",
      response.status < 400 ? immutableCacheControl : noStoreCacheControl
    );
    response.headers.set("Content-Security-Policy", customAssetContentSecurityPolicy);
    setPublicResourceCors(response);
    return response;
  };
}

function faviconLocation(icon: string) {
  if (!icon.startsWith("/")) return icon;
  // Custom file names may be unencoded; Location only carries encoded paths.
  const url = new URL(icon, "http://localhost");
  // Resolved dot segments may leave "//host"; keep the redirect on this site.
  return `${url.pathname.replace(/^\/+/, "/")}${url.search}${url.hash}`;
}

export function registerAssetRoutes(app: Hono, serveAssets: AssetHandler = createAssetHandler()) {
  app.use("/assets/*", (c) => serveAssets(c));
  app.get("/asset/*", createCustomAssetHandler());
  // Browsers request /favicon.ico for documents without an icon link.
  app.get("/favicon.ico", () => new Response(null, {
    status: 302,
    headers: {
      Location: safeRedirectLocation(faviconLocation(siteConfigPayload().site.icon)),
      "Cache-Control": publicRedirectCacheControl
    }
  }));
}
