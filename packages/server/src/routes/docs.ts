import { serveStatic } from "@hono/node-server/serve-static";
import type { Hono } from "hono";
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { specialHost } from "../core/theme-host.js";

// The VitePress build output, copied here from packages/docs/.vitepress/dist by
// scripts/copy-assets.mjs (compiled file lives at dist/routes/docs.js, so ../docs
// is dist/docs). Absent in dev (docs are a build artifact): run `vitepress dev`
// separately there.
const docsDir = join(dirname(fileURLToPath(import.meta.url)), "../docs");
const htmlCache = "no-cache";
const immutableCache = "public, max-age=31536000, immutable";

// docs.<domain> serves the bundled documentation site and nothing else — no API,
// no main SPA, no object bytes. Mounted before the other host middleware so a docs
// request short-circuits the rest of the app: the no-op `next` below stops a miss
// from falling through to the main app, and onNotFound renders the docs 404 page.
export function registerDocsRoutes(app: Hono) {
  const docsStatic = serveStatic({
    root: docsDir,
    onFound: (path, c) => {
      // Hashed VitePress assets are immutable; HTML must always be revalidated.
      c.header("Cache-Control", path.includes("/assets/") ? immutableCache : htmlCache);
    },
    onNotFound: (_path, c) => {
      const notFoundPage = join(docsDir, "404.html");
      if (existsSync(notFoundPage)) {
        c.res = new Response(createReadStream(notFoundPage) as unknown as BodyInit, {
          status: 404,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": htmlCache }
        });
      }
    }
  });

  app.use("*", async (c, next) => {
    if (specialHost(c.req.header("host") ?? "") !== "docs") return next();
    return docsStatic(c, async () => {});
  });
}
