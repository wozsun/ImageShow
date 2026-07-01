import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { adminApiBasePath, appConfig } from "@imageshow/shared";
import { env, onRuntimeConfigChange } from "./config/env.js";
import { applyImageConcurrency } from "./images/processing.js";
import { initializeAdmin, pingDb, pool, runMigrations } from "./core/db.js";
import { pingRedis, redis } from "./core/redis.js";
import { logger } from "./core/logger.js";
import { ensureStorage } from "./storage/storage.js";
import { fail, requireAuth, requireCsrf, routeError, securityHeaders } from "./core/http.js";
import { registerAdminImageRoutes } from "./routes/admin-images.js";
import { registerAdminTagRoutes } from "./routes/admin-tags.js";
import { registerAdminThemeRoutes } from "./routes/admin-themes.js";
import { registerAdminAuthorRoutes } from "./routes/admin-authors.js";
import { registerAdminUserRoutes } from "./routes/admin-users.js";
import { registerAdminLinkRoutes } from "./routes/admin-links.js";
import { registerCheckRoutes } from "./routes/check.js";
import { registerDocsRoutes } from "./routes/docs.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.js";
import { registerPublicRoutes } from "./routes/public.js";
import { serveRobotsTxt } from "./routes/robots.js";
import { handleRandomImage, handleThemeHostRandom, registerRandomRoutes } from "./routes/random.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerStaticRoutes } from "./routes/spa.js";
import { registerUploadRoutes } from "./routes/uploads.js";
import { drainWorker, startWorker, stopWorker } from "./jobs/tasks.js";
import { enforceThemeHostNavigation, specialHost, themeFromHost } from "./themes/host.js";

const app = new Hono();

app.onError((error, c) => fail(c, error));
app.use("*", async (c, next) => {
  for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
  await next();
});
app.options("*", async () => new Response(null, { status: 204 }));
// Host-aware robots.txt (routes/robots.ts). Registered before the docs short-circuit and the host
// guards below so it answers on every host — including static/link/random, which otherwise 404 any
// non-asset path, and docs, which otherwise serves only the bundled site.
app.get("/robots.txt", serveRobotsTxt);
// docs.<domain> serves the bundled VitePress site and short-circuits the rest of
// the app (registered before the other host middleware on purpose).
registerDocsRoutes(app);
// Host-based access control for the reserved subdomains:
//   random.<domain> → the random API only, at "/" with GET/HEAD; everything else 404.
//   static.<domain> → object bytes only, under /media/* and /thumbs/*; else 404.
//   link.<domain>   → link-image bytes only, under /media/* (proxied original) and
//                     /thumbs/* (stored thumbnail); else 404.
app.use("*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  const special = specialHost(host);
  if (special === "random") {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return routeError({ status: 405, message: "Method Not Allowed" });
    if (new URL(c.req.url).pathname !== "/") return routeError({ status: 404, message: "Not Found" });
    return handleRandomImage(c);
  }
  if (special === "static" || special === "link") {
    const path = new URL(c.req.url).pathname;
    if (!path.startsWith("/media/") && !path.startsWith("/thumbs/")) return routeError({ status: 404, message: "Not Found" });
  }
  // <theme>.<domain>/random serves the random API scoped to that theme. Handled
  // here, before the theme-host navigation guard would redirect /random to "/".
  const theme = themeFromHost(host);
  if (theme && new URL(c.req.url).pathname === "/random") return handleThemeHostRandom(c, theme);
  return next();
});
// Object bytes are exposed only on the cookie-isolated static.<domain> host (stored
// objects + thumbnails) and link.<domain> host (link images); the main and theme hosts
// never serve /media or /thumbs.
const mediaHostGuard = async (c: Parameters<typeof enforceThemeHostNavigation>[0], next: Parameters<typeof enforceThemeHostNavigation>[1]) => {
  const special = specialHost(c.req.header("host") ?? "");
  if (special === "static" || special === "link") return next();
  return routeError({ status: 404, message: "Not Found" });
};
app.use("/media/*", mediaHostGuard);
app.use("/thumbs/*", mediaHostGuard);
app.use("*", enforceThemeHostNavigation);

// Compress the dynamic JSON API responses (they're otherwise sent uncompressed). Static assets
// are already served precompressed via serveStatic, and image bytes / the SPA document are
// handled separately, so scope compression to /api only — never re-compressing those.
app.use("/api/*", compress());

registerHealthRoutes(app);
registerPublicRoutes(app);
registerRandomRoutes(app);
registerPublicAuthRoutes(app);

app.use(`${adminApiBasePath}/*`, requireAuth);
registerProtectedAuthRoutes(app);
app.use(`${adminApiBasePath}/*`, async (c, next) => {
  if (c.req.method !== "GET") return requireCsrf(c, next);
  await next();
});

registerAdminImageRoutes(app);
registerAdminTagRoutes(app);
registerAdminThemeRoutes(app);
registerAdminAuthorRoutes(app);
registerAdminUserRoutes(app);
registerAdminLinkRoutes(app);
registerUploadRoutes(app);
registerSettingsRoutes(app);
registerCheckRoutes(app);
registerStaticRoutes(app);

await ensureStorage();
await pingDb();
await runMigrations();
await initializeAdmin();
await pingRedis();
// Bound libvips' thread pool to upload.concurrency now, and keep it in sync when the admin
// saves settings or hot-reloads config.json.
applyImageConcurrency();
onRuntimeConfigChange(applyImageConcurrency);
startWorker();

const server = serve({ fetch: app.fetch, port: env.PORT });
logger.info(`ImageShow listening on :${env.PORT}`);

// Graceful shutdown: stop accepting connections, let the current worker tick
// finish (bounded), then close Redis and the database pool. Idempotent, with a
// hard-exit backstop so a hung connection can't keep the process alive forever.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down`);
  const hardExit = setTimeout(() => process.exit(1), appConfig.operationLog.shutdownHardExitMs);
  hardExit.unref();
  try {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    stopWorker();
    await drainWorker();
    await redis.quit().catch(() => redis.disconnect());
    await pool.end().catch(() => undefined);
  } finally {
    clearTimeout(hardExit);
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
