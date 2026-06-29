import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import { adminBasePath } from "@imageshow/shared";
import { createReadStream, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "../config/env.js";
import { immutableCacheControl, noCacheControl, spaDocumentHeaders } from "../core/http.js";
import { existingThemeFromHost, rootSiteUrl, themeFromHost } from "../themes/host.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");

// Static asset + SPA serving with theme-subdomain access gating (themes/host.ts).
// Not a domain API: serves index.html / assets / favicon and redirects unknown
// theme hosts back to the root site.
export function registerStaticRoutes(app: Hono) {
  app.use("/assets/*", async (c, next) => {
    await next();
    c.header("Cache-Control", immutableCacheControl);
  });
  // precompressed: 按 Accept-Encoding 优先发预构建的 .br，其次 .gz（构建时由 copy-assets 生成），
  // 并自动带上 Content-Encoding 与 Vary: Accept-Encoding；客户端不接受时回退原文件。
  app.use("/assets/*", serveStatic({ root: publicDir, precompressed: true }));
  app.get("/favicon.ico", serveStatic({ path: join(publicDir, "favicon.ico") }));

  app.get("/", async (c) => {
    const hostHeader = c.req.header("host") ?? "";
    const requestedTheme = themeFromHost(hostHeader);
    if (!requestedTheme) {
      const { root_redirect, home_enabled } = getRuntimeConfig().site;
      // Home off ⇒ the gallery is the landing even if root_redirect is still "home".
      return c.redirect(!home_enabled || root_redirect === "gallery" ? "/gallery" : "/home", 302);
    }
    return await existingThemeFromHost(hostHeader) ? spaHandler(c) : c.redirect(rootSiteUrl(c), 302);
  });
  app.get("/home", themeAwareSpaHandler);
  app.get("/gallery", themeAwareSpaHandler);
  app.get(adminBasePath, themeAwareSpaHandler);
  app.get(`${adminBasePath}/*`, themeAwareSpaHandler);
}

// 按 Accept-Encoding 选出最优的预压缩变体（br > gzip）。命中则返回压缩文件路径与对应编码，
// 否则回退原文件（无 Content-Encoding）。index.html 走自定义响应，不经 serveStatic，故在此手动协商。
function precompressedVariant(c: Context, filePath: string): { path: string; encoding?: string } {
  const accept = c.req.header("accept-encoding") ?? "";
  for (const [encoding, ext] of [["br", ".br"], ["gzip", ".gz"]] as const) {
    if (accept.includes(encoding) && existsSync(filePath + ext)) return { path: filePath + ext, encoding };
  }
  return { path: filePath };
}

async function spaHandler(c: Context) {
  const { path, encoding } = precompressedVariant(c, join(publicDir, "index.html"));
  // Spread the security headers in: this fresh Response bypasses the global c.header()
  // middleware (index.ts), so without this the HTML document would ship with no CSP / COOP.
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": noCacheControl,
    Vary: "Accept-Encoding",
    ...spaDocumentHeaders
  };
  if (encoding) headers["Content-Encoding"] = encoding;
  return new Response(createReadStream(path) as unknown as BodyInit, { headers });
}

async function themeAwareSpaHandler(c: Context) {
  const hostHeader = c.req.header("host") ?? "";
  const requestedTheme = themeFromHost(hostHeader);
  if (!requestedTheme) return spaHandler(c);
  return await existingThemeFromHost(hostHeader) ? spaHandler(c) : c.redirect(rootSiteUrl(c), 302);
}
