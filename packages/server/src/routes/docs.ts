import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "../config/env.js";
import { immutableCacheControl, noCacheControl, routeError } from "../core/http.js";
import { specialHost } from "../themes/host.js";

// The VitePress build output, copied here from packages/docs/.vitepress/dist by
// scripts/copy-assets.mjs (compiled file lives at dist/routes/docs.js, so ../docs
// is dist/docs). Absent in dev (docs are a build artifact): run `vitepress dev`
// separately there.
const docsDir = join(dirname(fileURLToPath(import.meta.url)), "../docs");

// docs.<domain> serves the bundled documentation site and nothing else — no API,
// no main SPA, no object bytes. Mounted before the other host middleware so a docs
// request short-circuits the rest of the app: the no-op `next` below stops a miss
// from falling through to the main app, and onNotFound renders the docs 404 page.
export function registerDocsRoutes(app: Hono) {
  const docsStatic = serveStatic({
    root: docsDir,
    // 同主站资源：优先发预压缩的 .br/.gz（copy-assets 也会预压缩 docs 目录），自动带 Content-Encoding/Vary。
    precompressed: true,
    onFound: (path, c) => {
      // Hashed VitePress assets are immutable; HTML must always be revalidated.
      c.header("Cache-Control", path.includes("/assets/") ? immutableCacheControl : noCacheControl);
    },
    onNotFound: (_path, c) => {
      const notFoundPage = join(docsDir, "404.html");
      if (existsSync(notFoundPage)) {
        c.res = new Response(createReadStream(notFoundPage) as unknown as BodyInit, {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": noCacheControl }
        });
      }
    }
  });

  app.use("*", async (c, next) => {
    if (specialHost(c.req.header("host") ?? "") !== "docs") return next();
    // The docs prefix stays reserved (so no theme can take it), but serving the site is
    // gated: with site.docs_enabled off, the docs host returns 404 instead of the docs.
    if (!getRuntimeConfig().site.docs_enabled) return routeError({ status: 404, message: "Not Found" });
    return docsStatic(c, async () => {});
  });
}
