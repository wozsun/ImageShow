import { serveStatic } from "@hono/node-server/serve-static";
import { Context as HonoContext, type Context, type Hono } from "hono";
import { join } from "node:path";
import {
  immutableCacheControl,
  noStoreCacheControl,
  publicStaticCacheControl,
  setPublicResourceCors
} from "../core/http/headers.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { serveStaticWithValidators } from "../core/http/static-conditional.ts";
import { serveNegotiatedStatic } from "../core/http/static-encoding.ts";

const publicDir = join(import.meta.dirname, "../public");

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

export function registerAssetRoutes(app: Hono, serveAssets: AssetHandler = createAssetHandler()) {
  const faviconStatic = serveStatic({ path: join(publicDir, "favicon.ico") });
  app.use("/assets/*", (c) => serveAssets(c));
  app.use("/favicon.ico", async (c, next) => {
    await next();
    c.header("Cache-Control", c.res.status < 400 ? publicStaticCacheControl : noStoreCacheControl);
  });
  app.get("/favicon.ico", async (c, next) => {
    return (await serveStaticWithValidators(c, faviconStatic)) ?? next();
  });
}
