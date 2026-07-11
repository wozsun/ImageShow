import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { adminApiBasePath, appConfig } from "@imageshow/shared";
import { getRuntimeConfig, onRuntimeConfigChange } from "./config/runtime-config-store.ts";
import { configureSharpConcurrency } from "./images/processing.ts";
import { cleanupOrphanRawImports } from "./images/imports/temp-files.ts";
import { initializeAdmin, pingDb, pool, runMigrations } from "./core/db.ts";
import { pingRedis, redis } from "./core/redis-client.ts";
import { logger } from "./core/logger.ts";
import { auditAdminMutation } from "./core/audit-log.ts";
import { ensureRuntimeDirectories } from "./storage/storage.ts";
import { fail, noStoreCacheControl, requireAuth, requireCsrf, routeError, securityHeaders } from "./core/http.ts";
import { limitApiRequestBody } from "./core/request-body-limit.ts";
import { registerAdminLogRoutes } from "./routes/admin-logs.ts";
import { registerAdvancedConfigRoutes } from "./routes/advanced-config.ts";
import { registerAdminImageRoutes } from "./routes/admin-images.ts";
import { registerAdminTagRoutes } from "./routes/admin-tags.ts";
import { registerAdminThemeRoutes } from "./routes/admin-themes.ts";
import { registerAdminAuthorRoutes } from "./routes/admin-authors.ts";
import { registerAdminUserRoutes } from "./routes/admin-users.ts";
import { registerCheckRoutes } from "./routes/check.ts";
import { registerDocsRoutes } from "./routes/docs.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerPublicRoutes } from "./routes/public.ts";
import { serveRobotsTxt } from "./routes/robots.ts";
import { handleRandomImage, handleThemeHostRandom, registerRandomRoutes } from "./routes/random.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerStorageRoutes } from "./routes/storage.ts";
import { registerSpaRoutes } from "./routes/spa.ts";
import { registerImportRoutes } from "./routes/imports.ts";
import { drainWorker, startWorker, stopWorker } from "./jobs/worker.ts";
import { enforceThemeHostNavigation, isAllowedSiteHost, specialHost, themeFromHost } from "./themes/host.ts";

const app = new Hono();

app.onError((error, c) => fail(c, error));
app.use("*", async (c, next) => {
  for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
  await next();
});
app.use("*", async (c, next) => {
  if (!isAllowedSiteHost(c.req.header("host") ?? "")) {
    return routeError({ status: 404, message: "Not Found" });
  }
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

app.use("/api/*", limitApiRequestBody);
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
app.use(`${adminApiBasePath}/*`, auditAdminMutation);
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
registerAdminLogRoutes(app);
registerAdvancedConfigRoutes(app);
registerSettingsRoutes(app);
registerStorageRoutes(app);
registerCheckRoutes(app);
registerSpaRoutes(app);

await ensureRuntimeDirectories();
await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);
await pingDb();
await runMigrations();
await initializeAdmin();
await pingRedis();
configureSharpConcurrency();
onRuntimeConfigChange(configureSharpConcurrency);
startWorker();

const serverPort = getRuntimeConfig().port;
const server = serve({ fetch: app.fetch, port: serverPort });
logger.info(`ImageShow listening on :${serverPort}`);

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
