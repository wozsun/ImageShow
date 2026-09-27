import { clearVariantScratchAtStartup } from "./images/variants/scratch.ts";
import { serve } from "@hono/node-server";
import { appConfig } from "@imageshow/shared";
import { bootstrapEnvironment } from "./config/bootstrap-env.ts";
import { deploymentConfig } from "./config/deployment-config.ts";
import {
  getRuntimeConfig,
  initializeRuntimeConfig
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
import {
  drainBackgroundJobWorker,
  startBackgroundJobWorker,
  stopBackgroundJobWorker
} from "./jobs/worker.ts";
import {
  closeStorageBackendRegistry,
  assertLocalImageHostForSite
} from "./storage/backends/registry.ts";
import { createHttpApp } from "./http-app.ts";
import { closeAllAdminSessionConnections } from "./users/admin-session-connections.ts";
import { acquireApplicationHost } from "./core/database/application-host.ts";

let coordinatorInitialization: Promise<unknown> | null = null;
let unsubscribeBusinessAvailabilityGate: (() => void) | null = null;
let server: ReturnType<typeof serve> | null = null;
let shuttingDown = false;
let shutdownPromise: Promise<void> | null = null;
let shutdownExitCode = 0;
const startupAbort = new AbortController();
let startupPromise: Promise<void> | null = null;
let applicationHost: Awaited<ReturnType<typeof acquireApplicationHost>> | undefined;

async function settleCoordinatorInitialization() {
  const current = coordinatorInitialization;
  if (current) await current.catch(() => undefined);
}

async function waitForShutdownStage<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Shutdown stage deadline exceeded")),
          Math.max(0, deadline - performance.now()));
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function initializeApplication() {
  configureDatabasePools(deploymentConfig.database);
  applicationHost = await acquireApplicationHost();
  applicationHost.signal.addEventListener("abort", () => void shutdown("application host ownership lost", 1), { once: true });
  startupAbort.signal.throwIfAborted();
  initializeRuntimeConfig();
  configureRuntimeLogger(() => getRuntimeConfig().log);
  configureSharpRuntime();
  const app = createHttpApp();
  await ensureRuntimeDirectories();
  await clearVariantScratchAtStartup();
  await initializeDatabaseSchema();
  await assertLocalImageHostForSite(getRuntimeConfig().site.domain);
  await ensureSuperAdmin({
    username: bootstrapEnvironment.adminUsername,
    password: bootstrapEnvironment.adminPassword
  });
  startupAbort.signal.throwIfAborted();
  markRuntimeInitializationComplete();

  unsubscribeBusinessAvailabilityGate = onBusinessAvailabilityGateOpen(() => {
    if (shuttingDown) return;
    coordinatorInitialization ??= initializeReadyImageCacheCoordinator()
      .catch((error) => {
        logger.warn("startup ready-image cache initialization failed", error);
      })
      .finally(() => {
        if (!shuttingDown) {
          startBackgroundJobWorker();
          startIngestionSessionWorker();
        }
      });
  });

  const serverPort = appConfig.applicationPort;
  server = serve({ fetch: app.fetch, port: serverPort });
  logger.info(`ImageShow listening on :${serverPort}`);
  startRedisOperationalMonitor();
}

function shutdown(signal: string, exitCode = 0) {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (shutdownPromise) {
    logger.info(`received ${signal}, shutdown already in progress`);
    return shutdownPromise;
  }
  shuttingDown = true;
  startupAbort.abort(new Error(`Application stopping: ${signal}`));
  unsubscribeBusinessAvailabilityGate?.();
  unsubscribeBusinessAvailabilityGate = null;
  logger.info(`received ${signal}, shutting down`);
  const deadline = performance.now() + appConfig.backgroundJob.shutdownHardExitMs;
  const drainDeadline = deadline - appConfig.backgroundJob.shutdownCleanupReserveMs;
  let stage = "startup";
  const hardExit = setTimeout(() => {
    logger.error("application shutdown hard deadline exceeded; interrupted work will recover on restart", { stage });
    process.exit(1);
  }, appConfig.backgroundJob.shutdownHardExitMs);
  shutdownPromise = (async () => {
    try {
      await waitForShutdownStage(startupPromise?.catch(() => undefined) ?? Promise.resolve(), drainDeadline);
      stage = "drain";
      const currentServer = server;
      server = null;
      closeAllAdminSessionConnections();
      const serverClose = currentServer
        ? new Promise<void>((resolve) => currentServer.close(() => resolve()))
        : Promise.resolve();
      stopRedisOperationalMonitor();
      stopBackgroundJobWorker();
      stopIngestionSessionWorker();
      const remainingDrainMs = Math.max(0, drainDeadline - performance.now());
      const backgroundJobWorkerDrain = drainBackgroundJobWorker(remainingDrainMs);
      const ingestionWorkerDrain = drainIngestionSessionWorker(remainingDrainMs);
      // Mark every cached driver as retiring before waiting for HTTP bodies.
      // Existing leases may drain; shutdown-time work cannot create a new
      // driver from a stale or freshly loaded registry snapshot.
      const storageRegistryClose = closeStorageBackendRegistry();
      const readyImageCacheStop = settleCoordinatorInitialization().then(() => stopReadyImageCacheCoordinator());
      const [, backgroundDrained, ingestionDrained] = await waitForShutdownStage(Promise.all([
        serverClose,
        backgroundJobWorkerDrain,
        ingestionWorkerDrain,
        readyImageCacheStop,
        storageRegistryClose
      ]), drainDeadline);
      if (!backgroundDrained || ingestionDrained.some((drained) => !drained)) {
        throw new Error("Application work did not finish draining");
      }
      stage = "connections";
      await waitForShutdownStage((async () => {
        await redis.quit().catch(() => redis.disconnect());
        await applicationHost?.close();
        await closeDatabasePools();
      })(), deadline);
      logger.info("application resources released");
      clearTimeout(hardExit);
      process.exit(shutdownExitCode);
    } catch (error) {
      // Do not release the host lease or dependencies while timed-out work may
      // still be committing. Process termination leaves recovery to its owners.
      logger.error("application shutdown incomplete; exiting for recovery", { stage, error });
      clearTimeout(hardExit);
      process.exit(1);
    }
  })();
  return shutdownPromise;
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

startupPromise = initializeApplication();
try { await startupPromise; } catch (error) {
  logger.error("application startup failed", error);
  await shutdown("startup failure", 1);
}
