import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { adminApiBasePath, appConfig } from "@imageshow/shared";
import { bootstrapEnvironment } from "./config/bootstrap-env.ts";
import { getRuntimeConfig, onRuntimeConfigChange } from "./config/runtime-config-store.ts";
import { configureSharpConcurrency } from "./images/processing.ts";
import { invalidateImageCaches } from "./images/image-cache.ts";
import { cleanupOrphanRawImports } from "./images/imports/temp-files.ts";
import { closeDatabasePools, pingDb, runMigrations } from "./core/db.ts";
import { ensureSuperAdmin } from "./users/admin-bootstrap.ts";
import { pingRedis, redis } from "./core/redis-client.ts";
import { logger } from "./core/logger.ts";
import { auditAdminMutation } from "./core/audit-log.ts";
import { ensureRuntimeDirectories } from "./storage/runtime-directories.ts";
import { apiErrorResponse, handleApiError } from "./core/http/responses.ts";
import {
  appendVaryHeader,
  noStoreCacheControl,
  securityHeaders
} from "./core/http/headers.ts";
import {
  requireAdminCsrf,
  requireAdminSession
} from "./users/admin-session.ts";
import {
  limitApiRequestBody,
  limitProtectedAdminRequestBody
} from "./core/http/request-body-limit.ts";
import { prepareCompressionThreshold } from "./core/http/compression-threshold.ts";
import { registerAdminLogRoutes } from "./routes/admin-logs.ts";
import { registerAdvancedConfigRoutes } from "./routes/advanced-config.ts";
import { registerAdminImageRoutes } from "./routes/admin-images.ts";
import { registerAdminTagRoutes } from "./routes/admin-tags.ts";
import { registerAdminThemeRoutes } from "./routes/admin-themes.ts";
import { registerAdminAuthorRoutes } from "./routes/admin-authors.ts";
import { registerAdminUserRoutes } from "./routes/admin-users.ts";
import { registerAdminPreferenceRoutes } from "./routes/admin-preferences.ts";
import { registerCheckRoutes } from "./routes/check.ts";
import { registerDocsRoutes } from "./routes/docs.ts";
import { registerHealthRoutes } from "./routes/health.ts";
import { registerProtectedAuthRoutes, registerPublicAuthRoutes } from "./routes/auth.ts";
import { registerPublicRoutes } from "./routes/public.ts";
import { serveRobotsTxt } from "./routes/robots.ts";
import { handleRandomImage, handleThemeHostRandom, registerRandomRoutes } from "./routes/random.ts";
import { registerSettingsRoutes } from "./routes/settings.ts";
import { registerSecurityReportRoutes } from "./routes/security-reports.ts";
import { registerStorageRoutes } from "./routes/storage.ts";
import { registerSpaRoutes } from "./routes/spa.ts";
import { registerImportRoutes } from "./routes/imports.ts";
import { drainWorker, startWorker, stopWorker } from "./jobs/worker.ts";
import { enforceThemeHostNavigation, isAllowedSiteHost, specialHost, themeFromHost } from "./themes/host.ts";
import {
  closeStorageBackendRegistry,
  onStorageBackendChange
} from "./storage/backend-registry.ts";
import { rebuildRandomPool } from "./random/cache-rebuild.ts";
import {
  cleanupActiveRandomRebuildSpools,
  cleanupOrphanRandomRebuildSpools,
} from "./random/rebuild-spool.ts";

const app = new Hono();

app.onError((error, c) => handleApiError(c, error));
app.use("*", async (c, next) => {
  for (const [name, value] of Object.entries(securityHeaders)) c.header(name, value);
  await next();
});
app.use("*", async (c, next) => {
  if (!isAllowedSiteHost(c.req.header("host") ?? "")) {
    return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  await next();
});
app.options("*", async () => new Response(null, { status: 204, headers: { "Cache-Control": noStoreCacheControl } }));
app.get("/robots.txt", serveRobotsTxt);
registerDocsRoutes(app);

app.use("*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  const special = specialHost(host);
  if (special === "random") {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") return apiErrorResponse({ status: 405, message: "Method Not Allowed" });
    if (new URL(c.req.url).pathname !== "/") return apiErrorResponse({ status: 404, message: "Not Found" });
    return handleRandomImage(c);
  }
  if (special === "static" || special === "link") {
    const path = new URL(c.req.url).pathname;
    const allowed = special === "static"
      ? path.startsWith("/media/") || path.startsWith("/thumbs/")
      : path.startsWith("/original/");
    if (!allowed) return apiErrorResponse({ status: 404, message: "Not Found" });
  }
  const theme = themeFromHost(host);
  if (theme && new URL(c.req.url).pathname === "/random") return handleThemeHostRandom(c, theme);
  return next();
});

const mediaHostGuard = async (c: Parameters<typeof enforceThemeHostNavigation>[0], next: Parameters<typeof enforceThemeHostNavigation>[1]) => {
  const special = specialHost(c.req.header("host") ?? "");
  if (special === "static" || special === "link") return next();
  return apiErrorResponse({ status: 404, message: "Not Found" });
};
app.use("/media/*", mediaHostGuard);
app.use("/thumbs/*", mediaHostGuard);
app.use("/original/*", mediaHostGuard);
app.use("*", enforceThemeHostNavigation);

app.use("/api/*", limitApiRequestBody);
app.use("/api/*", async (c, next) => {
  await next();
  appendVaryHeader(c, "Accept-Encoding");
});
const apiCompress = compress({ threshold: 1024 });
app.use("/api/*", async (c, next) => {
  if (new URL(c.req.url).pathname === `${adminApiBasePath}/imports/events`) return next();
  let temporaryContentLength = false;
  await apiCompress(c, async () => {
    await next();
    temporaryContentLength = await prepareCompressionThreshold(c, 1024);
  });
  if (temporaryContentLength && !c.res.headers.has("Content-Encoding")) {
    c.res.headers.delete("Content-Length");
  }
});
app.use("/api/*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", noStoreCacheControl);
});

registerHealthRoutes(app);
registerPublicRoutes(app);
registerRandomRoutes(app);
registerPublicAuthRoutes(app);
registerSecurityReportRoutes(app);

app.use(`${adminApiBasePath}/*`, requireAdminSession);
app.use(`${adminApiBasePath}/*`, auditAdminMutation);
app.use(`${adminApiBasePath}/*`, async (c, next) => {
  if (c.req.method !== "GET") return requireAdminCsrf(c, next);
  await next();
});
app.use(`${adminApiBasePath}/*`, limitProtectedAdminRequestBody);
registerProtectedAuthRoutes(app);

registerAdminImageRoutes(app);
registerAdminTagRoutes(app);
registerAdminThemeRoutes(app);
registerAdminAuthorRoutes(app);
registerAdminUserRoutes(app);
registerAdminPreferenceRoutes(app);
registerImportRoutes(app);
registerAdminLogRoutes(app);
registerAdvancedConfigRoutes(app);
registerSettingsRoutes(app);
registerStorageRoutes(app);
registerCheckRoutes(app);
registerSpaRoutes(app);
app.notFound(() => apiErrorResponse({ status: 404, message: "Not Found" }));

await ensureRuntimeDirectories();
await cleanupOrphanRandomRebuildSpools();
await pingDb();
await runMigrations();
await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);
await ensureSuperAdmin({
  username: bootstrapEnvironment.adminUsername,
  password: bootstrapEnvironment.adminPassword
});
await pingRedis();
configureSharpConcurrency();
onRuntimeConfigChange(configureSharpConcurrency);
let publicUrlConfigSignature = publicUrlConfigCacheSignature();
onRuntimeConfigChange(() => {
  const nextSignature = publicUrlConfigCacheSignature();
  if (nextSignature === publicUrlConfigSignature) return;
  publicUrlConfigSignature = nextSignature;
  void invalidateImageCaches();
});
onStorageBackendChange(() => {
  void invalidateImageCaches().catch((error) => {
    logger.warn("storage change cache invalidation failed", error);
  });
});
startWorker();
const startupRandomPool = rebuildRandomPool({ requireFresh: false }).catch((error) => {
  // Redis is a derived layer. A failed warm-up is retried by normal reads and
  // queued rebuild jobs without preventing the HTTP service from starting.
  logger.warn("startup random pool warm-up failed", error);
});

const serverPort = appConfig.applicationPort;
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
    await startupRandomPool;
    await cleanupActiveRandomRebuildSpools();
    await closeStorageBackendRegistry();
    await redis.quit().catch(() => redis.disconnect());
    await closeDatabasePools();
  } finally {
    clearTimeout(hardExit);
    process.exit(0);
  }
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

function publicUrlConfigCacheSignature() {
  const { site } = getRuntimeConfig();
  return JSON.stringify({
    domain: site.domain,
    static_subdomain: site.static_subdomain,
    link_subdomain: site.link_subdomain
  });
}
