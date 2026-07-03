import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import { adminBasePath } from "@imageshow/shared";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "../config/env.js";
import { siteConfigPayload } from "../config/settings.js";
import { immutableCacheControl, noStoreCacheControl, publicDocumentCacheControl, publicStaticCacheControl, spaDocumentHeaders } from "../core/http.js";
import { existingThemeFromHost, rootSiteUrl, themeFromHost } from "../themes/host.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");

export function registerStaticRoutes(app: Hono) {
  app.use("/assets/*", async (c, next) => {
    await next();
    c.header("Cache-Control", c.res.status < 400
      ? c.req.path.startsWith("/assets/brand/") ? publicStaticCacheControl : immutableCacheControl
      : noStoreCacheControl);
  });
  app.use("/assets/*", serveStatic({ root: publicDir, precompressed: true }));
  app.use("/favicon.ico", async (c, next) => {
    await next();
    c.header("Cache-Control", c.res.status < 400 ? publicStaticCacheControl : noStoreCacheControl);
  });
  app.get("/favicon.ico", serveStatic({ path: join(publicDir, "favicon.ico") }));

  app.get("/", async (c) => {
    const hostHeader = c.req.header("host") ?? "";
    const requestedTheme = themeFromHost(hostHeader);
    if (!requestedTheme) {
      const { root_redirect, home } = getRuntimeConfig().site;
      return new Response(null, {
        status: 302,
        headers: {
          Location: !home.enabled || root_redirect === "gallery" ? "/gallery" : "/home",
          "Cache-Control": publicDocumentCacheControl
        }
      });
    }
    return await existingThemeFromHost(hostHeader) ? spaHandler(c) : new Response(null, {
      status: 302,
      headers: { Location: rootSiteUrl(c), "Cache-Control": noStoreCacheControl }
    });
  });
  app.get("/home", themeAwareSpaHandler);
  app.get("/gallery", themeAwareSpaHandler);
  app.get(adminBasePath, themeAwareSpaHandler);
  app.get(`${adminBasePath}/*`, themeAwareSpaHandler);
}

let spaTemplate: string | null = null;

function buildSpaDocument(): string {
  spaTemplate ??= readFileSync(join(publicDir, "index.html"), "utf8");
  const site = getRuntimeConfig().site;
  const inlineConfig = JSON.stringify(siteConfigPayload()).replace(/</g, "\\u003c");
  const head =
    `<link rel="preconnect" href="https://${site.static_subdomain}.${site.domain}" crossorigin>` +
    `<script type="application/json" id="__site_config__">${inlineConfig}</script>`;
  return spaTemplate.replace("</head>", `${head}</head>`);
}

async function spaHandler(_c: Context) {
  return new Response(buildSpaDocument(), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": publicDocumentCacheControl,
      ...spaDocumentHeaders
    }
  });
}

async function themeAwareSpaHandler(c: Context) {
  const hostHeader = c.req.header("host") ?? "";
  const requestedTheme = themeFromHost(hostHeader);
  if (!requestedTheme) return spaHandler(c);
  return await existingThemeFromHost(hostHeader) ? spaHandler(c) : new Response(null, {
    status: 302,
    headers: { Location: rootSiteUrl(c), "Cache-Control": noStoreCacheControl }
  });
}
