import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { immutableCacheControl, noStoreCacheControl, publicDocsCacheControl, routeError } from "../core/http.ts";
import { specialHost } from "../themes/host.ts";

const docsDir = join(dirname(fileURLToPath(import.meta.url)), "../docs");

export function registerDocsRoutes(app: Hono) {
  const docsStatic = serveStatic({
    root: docsDir,

    precompressed: true,
    onFound: (path, c) => {

      c.header("Cache-Control", path.includes("/assets/") ? immutableCacheControl : publicDocsCacheControl);
    },
    onNotFound: (_path, c) => {
      const notFoundPage = join(docsDir, "404.html");
      if (existsSync(notFoundPage)) {
        c.res = new Response(createReadStream(notFoundPage) as unknown as BodyInit, {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": noStoreCacheControl }
        });
      }
    }
  });

  app.use("*", async (c, next) => {
    if (specialHost(c.req.header("host") ?? "") !== "docs") return next();

    if (!getRuntimeConfig().site.docs_enabled) return routeError({ status: 404, message: "Not Found" });
    return docsStatic(c, async () => {});
  });
}
