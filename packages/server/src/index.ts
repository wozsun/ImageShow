import { serve } from "@hono/node-server";
import { appConfig } from "@imageshow/shared";
import { bootstrapEnvironment } from "./config/bootstrap-env.ts";
import { deploymentConfig } from "./config/deployment-config.ts";
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  onRuntimeConfigChange
} from "./config/runtime-config-store.ts";
import { configureSharpRuntime } from "./images/processing.ts";
import {
  initializeReadyImageCacheCoordinator,
  stopReadyImageCacheCoordinator
} from "./images/ready-cache/coordinator.ts";
import { cleanupOrphanRawImports } from "./images/imports/temp-files.ts";
import {
  closeDatabasePools,
  configureDatabasePools
} from "./core/database-pools.ts";
import {
  initializeDatabaseSchema,
  pingDatabase
} from "./core/database-schema.ts";
import { ensureSuperAdmin } from "./users/admin-bootstrap.ts";
import { redis } from "./core/redis-client.ts";
import {
  markRuntimeInitializationComplete,
  onBusinessAvailabilityGateOpen,
  startRedisOperationalMonitor,
  stopRedisOperationalMonitor
} from "./core/runtime-availability.ts";
import { configureRuntimeLogger, logger } from "./core/logger.ts";
import { ensureRuntimeDirectories } from "./storage/runtime-directories.ts";
import { drainWorker, startWorker, stopWorker } from "./jobs/worker.ts";
import {
  closeStorageBackendRegistry
} from "./storage/backend-registry.ts";
import { initializeThumbnailRepairState } from "./storage/thumbnail-repair-state.ts";
import { createHttpApp } from "./http-app.ts";
import {
  acquireApplicationLifecycleLock,
  type ApplicationLifecycleLock
} from "./core/application-lifecycle-lock.ts";

configureDatabasePools(deploymentConfig.database);
initializeRuntimeConfig();
configureRuntimeLogger(() => getRuntimeConfig().log);
const app = createHttpApp();

let lifecycleLock: ApplicationLifecycleLock | null = null;
let lifecycleOwnershipLoss: Error | null = null;
let coordinatorInitialization: Promise<unknown> | null = null;
let server: ReturnType<typeof serve> | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let shutdownExitCode = 0;

async function settleCoordinatorInitialization() {
  const current = coordinatorInitialization;
  if (current) await current.catch(() => undefined);
}

await ensureRuntimeDirectories();
await pingDatabase();
await initializeDatabaseSchema();
try {
  lifecycleLock = await acquireApplicationLifecycleLock();
} catch (error) {
  await closeDatabasePools();
  throw error;
}

void lifecycleLock.ownershipLost.then((error) => {
  lifecycleOwnershipLoss = error;
  shuttingDown = true;
  logger.error("application lifecycle lock ownership lost", error);
  void shutdown("lifecycle lock loss", 1);
});

try {
  await initializeThumbnailRepairState();
  lifecycleLock.assertOwned();
  await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);
  lifecycleLock.assertOwned();
  await ensureSuperAdmin({
    username: bootstrapEnvironment.adminUsername,
    password: bootstrapEnvironment.adminPassword
  });
  lifecycleLock.assertOwned();
  configureSharpRuntime();
  onRuntimeConfigChange(configureSharpRuntime);
  markRuntimeInitializationComplete();

  onBusinessAvailabilityGateOpen(() => {
    coordinatorInitialization ??= initializeReadyImageCacheCoordinator()
      .catch((error) => {
        logger.warn("startup ready-image cache initialization failed", error);
      })
      .finally(() => {
        if (!shuttingDown) startWorker();
      });
  });

  lifecycleLock.assertOwned();
  const serverPort = appConfig.applicationPort;
  server = serve({ fetch: app.fetch, port: serverPort });
  logger.info(`ImageShow listening on :${serverPort}`);
  startRedisOperationalMonitor();
} catch (error) {
  const startupError = lifecycleOwnershipLoss ?? error;
  if (!lifecycleOwnershipLoss) {
    logger.error("application startup failed", startupError);
  }
  await shutdown("startup failure", 1);
  throw startupError;
}

function shutdown(signal: string, exitCode = 0) {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (shutdownPromise) return shutdownPromise;
  shuttingDown = true;
  logger.info(`received ${signal}, shutting down`);
  const hardExit = setTimeout(() => process.exit(1), appConfig.backgroundJob.shutdownHardExitMs);
  hardExit.unref();
  shutdownPromise = (async () => {
    try {
      const currentServer = server;
      server = null;
      const serverClose = currentServer
        ? new Promise<void>((resolve) => currentServer.close(() => resolve()))
        : Promise.resolve();
      stopRedisOperationalMonitor();
      stopWorker();
      const workerDrain = drainWorker();
      // Mark every cached driver as retiring before waiting for HTTP bodies.
      // Existing leases may drain; shutdown-time work cannot create a new
      // driver from a stale or freshly loaded registry snapshot.
      const storageRegistryClose = closeStorageBackendRegistry();
      await settleCoordinatorInitialization();
      const readyImageCacheStop = stopReadyImageCacheCoordinator();
      await Promise.all([
        serverClose,
        workerDrain,
        readyImageCacheStop,
        storageRegistryClose
      ]);
      await redis.quit().catch(() => redis.disconnect());
      await closeDatabasePools();
      await lifecycleLock?.release().catch((error) => {
        logger.error("application lifecycle lock release failed", error);
      });
    } finally {
      clearTimeout(hardExit);
      process.exit(shutdownExitCode);
    }
  })();
  return shutdownPromise;
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
