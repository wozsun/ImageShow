import { serve } from "@hono/node-server";
import { appConfig } from "@imageshow/shared";
import { bootstrapEnvironment } from "./config/bootstrap-env.ts";
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  onRuntimeConfigChange
} from "./config/runtime-config-store.ts";
import { configureSharpConcurrency } from "./images/processing.ts";
import {
  initializeReadyImageCacheCoordinator,
  stopReadyImageCacheCoordinator
} from "./images/ready-cache/coordinator.ts";
import { cleanupOrphanRawImports } from "./images/imports/temp-files.ts";
import { closeDatabasePools, pingDb, runMigrations } from "./core/db.ts";
import { ensureSuperAdmin } from "./users/admin-bootstrap.ts";
import { redis } from "./core/redis-client.ts";
import { configureRuntimeLogger, logger } from "./core/logger.ts";
import { ensureRuntimeDirectories } from "./storage/runtime-directories.ts";
import { drainWorker, startWorker, stopWorker } from "./jobs/worker.ts";
import {
  closeStorageBackendRegistry
} from "./storage/backend-registry.ts";
import { createHttpApp } from "./http-app.ts";

initializeRuntimeConfig();
configureRuntimeLogger(() => getRuntimeConfig().log);
const app = createHttpApp();

await ensureRuntimeDirectories();
await pingDb();
await runMigrations();
await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);
await ensureSuperAdmin({
  username: bootstrapEnvironment.adminUsername,
  password: bootstrapEnvironment.adminPassword
});
configureSharpConcurrency();
onRuntimeConfigChange(configureSharpConcurrency);
await initializeReadyImageCacheCoordinator().catch((error) => {
  logger.warn("startup ready-image cache initialization failed", error);
});
startWorker();

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
    stopWorker();
    const readyImageCacheStop = stopReadyImageCacheCoordinator();
    const workerDrain = drainWorker();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.all([
      workerDrain,
      readyImageCacheStop
    ]);
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
