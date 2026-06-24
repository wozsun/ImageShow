import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono } from "hono";
import { adminBasePath } from "@imageshow/shared";
import { createReadStream } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getRuntimeConfig } from "../config/env.js";
import { existingThemeFromHost, rootSiteUrl, themeFromHost } from "../core/theme-host.js";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "../public");
const htmlCache = "no-cache";
const immutableCache = "public, max-age=31536000, immutable";

export function registerStaticRoutes(app: Hono) {
  app.use("/assets/*", async (c, next) => {
    await next();
    c.header("Cache-Control", immutableCache);
  });
  app.use("/assets/*", serveStatic({ root: publicDir }));
  app.get("/favicon.ico", serveStatic({ path: join(publicDir, "favicon.ico") }));

  app.get("/", async (c) => {
    const hostHeader = c.req.header("host") ?? "";
    const requestedTheme = themeFromHost(hostHeader);
    if (!requestedTheme) return c.redirect(getRuntimeConfig().site.root_redirect === "gallery" ? "/gallery" : "/home", 302);
    return await existingThemeFromHost(hostHeader) ? spaHandler() : c.redirect(rootSiteUrl(c), 302);
  });
  app.get("/home", themeAwareSpaHandler);
  app.get("/gallery", themeAwareSpaHandler);
  app.get(adminBasePath, themeAwareSpaHandler);
  app.get(`${adminBasePath}/*`, themeAwareSpaHandler);
}

async function spaHandler() {
  return new Response(createReadStream(join(publicDir, "index.html")) as unknown as BodyInit, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": htmlCache }
  });
}

async function themeAwareSpaHandler(c: Context) {
  const hostHeader = c.req.header("host") ?? "";
  const requestedTheme = themeFromHost(hostHeader);
  if (!requestedTheme) return spaHandler();
  return await existingThemeFromHost(hostHeader) ? spaHandler() : c.redirect(rootSiteUrl(c), 302);
}
