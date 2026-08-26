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
import {
  drainIngestionSessionWorker,
  startIngestionSessionWorker,
  stopIngestionSessionWorker
} from "./images/ingestion/runtime.ts";
import {
  closeDatabasePools,
  configureDatabasePools
} from "./core/database/pools.ts";
import { initializeDatabaseSchema } from "./core/database/schema.ts";
import { ensureSuperAdmin } from "./users/admin-bootstrap.ts";
import { redis } from "./core/redis/client.ts";
import {
  markRuntimeInitializationComplete,
  onBusinessAvailabilityGateOpen,
  startRedisOperationalMonitor,
  stopRedisOperationalMonitor
} from "./core/runtime-availability.ts";
import { configureRuntimeLogger, logger } from "./core/logger.ts";
import { ensureRuntimeDirectories } from "./storage/objects/runtime-directories.ts";
import { drainWorker, startWorker, stopWorker } from "./jobs/worker.ts";
import {
  closeStorageBackendRegistry
} from "./storage/backends/registry.ts";
import { createHttpApp } from "./http-app.ts";
import {
  closeAllAdminSessionConnections
} from "./users/admin-session-connections.ts";

configureDatabasePools(deploymentConfig.database);
initializeRuntimeConfig();
configureRuntimeLogger(() => getRuntimeConfig().log);
const app = createHttpApp();

let coordinatorInitialization: Promise<unknown> | null = null;
let unsubscribeBusinessAvailabilityGate: (() => void) | null = null;
let server: ReturnType<typeof serve> | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let shutdownExitCode = 0;

async function settleCoordinatorInitialization() {
  const current = coordinatorInitialization;
  if (current) await current.catch(() => undefined);
}

try {
  await ensureRuntimeDirectories();
  await initializeDatabaseSchema();
  await ensureSuperAdmin({
    username: bootstrapEnvironment.adminUsername,
    password: bootstrapEnvironment.adminPassword
  });
  configureSharpRuntime();
  onRuntimeConfigChange(configureSharpRuntime);
  markRuntimeInitializationComplete();

  unsubscribeBusinessAvailabilityGate = onBusinessAvailabilityGateOpen(() => {
    if (shuttingDown) return;
    coordinatorInitialization ??= initializeReadyImageCacheCoordinator()
      .catch((error) => {
        logger.warn("startup ready-image cache initialization failed", error);
      })
      .finally(() => {
        if (!shuttingDown) {
          startWorker();
          startIngestionSessionWorker();
        }
      });
  });

  const serverPort = appConfig.applicationPort;
  server = serve({ fetch: app.fetch, port: serverPort });
  logger.info(`ImageShow listening on :${serverPort}`);
  startRedisOperationalMonitor();
} catch (error) {
  logger.error("application startup failed", error);
  await shutdown("startup failure", 1);
  throw error;
}

function shutdown(signal: string, exitCode = 0) {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (shutdownPromise) {
    logger.info(`received ${signal}, shutdown already in progress`);
    return shutdownPromise;
  }
  shuttingDown = true;
  unsubscribeBusinessAvailabilityGate?.();
  unsubscribeBusinessAvailabilityGate = null;
  logger.info(`received ${signal}, shutting down`);
  const hardExit = setTimeout(() => process.exit(1), appConfig.backgroundJob.shutdownHardExitMs);
  hardExit.unref();
  shutdownPromise = (async () => {
    try {
      const currentServer = server;
      server = null;
      closeAllAdminSessionConnections();
      const serverClose = currentServer
        ? new Promise<void>((resolve) => currentServer.close(() => resolve()))
        : Promise.resolve();
      stopRedisOperationalMonitor();
      stopWorker();
      stopIngestionSessionWorker();
      const workerDrain = drainWorker();
      const ingestionWorkerDrain = drainIngestionSessionWorker();
      // Mark every cached driver as retiring before waiting for HTTP bodies.
      // Existing leases may drain; shutdown-time work cannot create a new
      // driver from a stale or freshly loaded registry snapshot.
      const storageRegistryClose = closeStorageBackendRegistry();
      await settleCoordinatorInitialization();
      const readyImageCacheStop = stopReadyImageCacheCoordinator();
      await Promise.all([
        serverClose,
        workerDrain,
        ingestionWorkerDrain,
        readyImageCacheStop,
        storageRegistryClose
      ]);
    } catch (error) {
      shutdownExitCode = 1;
      logger.error("application shutdown failed", error);
    } finally {
      await redis.quit().catch(() => redis.disconnect());
      await closeDatabasePools();
      logger.info("application resources released");
      clearTimeout(hardExit);
      process.exit(shutdownExitCode);
    }
  })();
  return shutdownPromise;
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
