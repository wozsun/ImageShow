import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { adminApiBasePath, appConfig } from "@imageshow/shared";
import { env, onRuntimeConfigChange } from "./config/env.js";
import { applyImageConcurrency } from "./images/processing.js";
import { cleanupOrphanRawImports } from "./images/imports/temp-files.js";
import { initializeAdmin, pingDb, pool, runMigrations } from "./core/db.js";
import { pingRedis, redis } from "./core/redis-client.js";
import { logger } from "./core/logger.js";
import { ensureStorage } from "./storage/storage.js";
import { fail, noStoreCacheControl, requireAuth, requireCsrf, routeError, securityHeaders } from "./core/http.js";
import { registerAdminImageRoutes } from "./routes/admin-images.js";
import { registerAdminTagRoutes } from "./routes/admin-tags.js";
import { registerAdminThemeRoutes } from "./routes/admin-themes.js";
import { registerAdminAuthorRoutes } from "./routes/admin-authors.js";
import { registerAdminUserRoutes } from "./routes/admin-users.js";
import { registerCheckRoutes } from "./routes/check.js";
import { registerDocsRoutes } from "./routes/docs.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.js";
import { registerPublicRoutes } from "./routes/public.js";
import { serveRobotsTxt } from "./routes/robots.js";
import { handleRandomImage, handleThemeHostRandom, registerRandomRoutes } from "./routes/random.js";
import { registerSettingsRoutes } from "./routes/settings.js";
import { registerStaticRoutes } from "./routes/spa.js";
import { registerImportRoutes } from "./routes/imports.js";
import { drainWorker, startWorker, stopWorker } from "./jobs/tasks.js";
import { enforceThemeHostNavigation, specialHost, themeFromHost } from "./themes/host.js";

const app = new Hono();

app.onError((error, c) => fail(c, error));
app.use("*", async (c, next) => {
  for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
  await next();
});
app.options("*", async () => new Response(null, { status: 204 }));
app.get("/robots.txt", serveRobotsTxt);
registerDocsRoutes(app);

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
    const allowed = path.startsWith("/media/") || path.startsWith("/thumbs/") || (special === "link" && path.startsWith("/original/"));
    if (!allowed) return routeError({ status: 404, message: "Not Found" });
  }
  const theme = themeFromHost(host);
  if (theme && new URL(c.req.url).pathname === "/random") return handleThemeHostRandom(c, theme);
  return next();
});

const mediaHostGuard = async (c: Parameters<typeof enforceThemeHostNavigation>[0], next: Parameters<typeof enforceThemeHostNavigation>[1]) => {
  const special = specialHost(c.req.header("host") ?? "");
  if (special === "static" || special === "link") return next();
  return routeError({ status: 404, message: "Not Found" });
};
app.use("/media/*", mediaHostGuard);
app.use("/thumbs/*", mediaHostGuard);
app.use("/original/*", mediaHostGuard);
app.use("*", enforceThemeHostNavigation);

const apiCompress = compress();
app.use("/api/*", async (c, next) => {
  if (new URL(c.req.url).pathname === `${adminApiBasePath}/imports/events`) return next();
  return apiCompress(c, next);
});
app.use("/api/*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", noStoreCacheControl);
});

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
registerImportRoutes(app);
registerSettingsRoutes(app);
registerCheckRoutes(app);
registerStaticRoutes(app);

await ensureStorage();
await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);
await pingDb();
await runMigrations();
await initializeAdmin();
await pingRedis();
applyImageConcurrency();
onRuntimeConfigChange(applyImageConcurrency);
startWorker();

const server = serve({ fetch: app.fetch, port: env.PORT });
logger.info(`ImageShow listening on :${env.PORT}`);

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down`);
  const hardExit = setTimeout(() => process.exit(1), appConfig.backgroundJob.shutdownHardExitMs);
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
