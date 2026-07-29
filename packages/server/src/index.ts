import { serve } from "@hono/node-server";
import { appConfig } from "@imageshow/shared";
import { bootstrapEnvironment } from "./config/bootstrap-env.ts";
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  onRuntimeConfigChange
} from "./config/runtime-config-store.ts";
import { configureSharpConcurrency } from "./images/processing.ts";
import { invalidateImageCaches } from "./images/image-cache.ts";
import { cleanupOrphanRawImports } from "./images/imports/temp-files.ts";
import { closeDatabasePools, pingDb, runMigrations } from "./core/db.ts";
import { ensureSuperAdmin } from "./users/admin-bootstrap.ts";
import { pingRedis, redis } from "./core/redis-client.ts";
import { configureRuntimeLogger, logger } from "./core/logger.ts";
import { ensureRuntimeDirectories } from "./storage/runtime-directories.ts";
import { drainWorker, startWorker, stopWorker } from "./jobs/worker.ts";
import {
  closeStorageBackendRegistry,
  onStorageBackendChange
} from "./storage/backend-registry.ts";
import { rebuildRandomPool } from "./random/cache-rebuild.ts";
import {
  cleanupActiveRandomRebuildSpools,
  cleanupOrphanRandomRebuildSpools,
} from "./random/rebuild-spool.ts";
import { createHttpApp } from "./http-app.ts";

initializeRuntimeConfig();
configureRuntimeLogger(() => getRuntimeConfig().log);
const app = createHttpApp();

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
