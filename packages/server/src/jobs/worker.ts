import { appConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { logger } from "../core/logger.ts";
import { cleanupOrphanRawImports } from "../images/imports/temp-files.ts";
import { handleBackgroundJob } from "./handlers.ts";
import {
  claimBackgroundJob,
  cleanupBackgroundJobHistory,
  listRunnableBackgroundJobCounts,
  markBackgroundJobFailed,
  markBackgroundJobIgnored,
  markBackgroundJobSucceeded,
  recoverStaleBackgroundJobs,
  scheduleImportCleanup
} from "./repository.ts";

let timer: NodeJS.Timeout | undefined;
let tickPromise: Promise<void> | null = null;
let lastStaleRecovery = 0;
let lastImportCleanup = 0;
let lastHistoryCleanup = 0;

function jobTypeConcurrency(type: string): number {
  const config = getRuntimeConfig();
  switch (type) {
    case "thumb.generate":
      return config.upload.concurrency;
    case "move.cleanup":
      return config.background_job.move_cleanup_concurrency;
    default:
      return 1;
  }
}

async function runBackgroundJobType(type: string, lanes: number) {
  async function runLane() {
    for (;;) {
      const job = await claimBackgroundJob(type);
      if (!job) return;
      try {
        const outcome = await handleBackgroundJob(job);
        if (outcome.status === "ignored") {
          await markBackgroundJobIgnored(job.id, outcome.reason);
        } else {
          await markBackgroundJobSucceeded(job.id, outcome.result);
        }
      } catch (error) {
        await markBackgroundJobFailed(job, error);
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, runLane));
}

async function scheduleExpiredImportCleanup() {
  await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);
  await scheduleImportCleanup();
}

async function runWorkerTick() {
  const now = Date.now();
  if (now - lastStaleRecovery >= appConfig.backgroundJob.staleRecoveryIntervalMs) {
    lastStaleRecovery = now;
    await recoverStaleBackgroundJobs();
  }
  if (now - lastImportCleanup >= appConfig.backgroundJob.expireUploadsIntervalMs) {
    lastImportCleanup = now;
    await scheduleExpiredImportCleanup();
  }
  if (now - lastHistoryCleanup >= appConfig.backgroundJob.historyCleanupIntervalMs) {
    lastHistoryCleanup = now;
    await cleanupBackgroundJobHistory();
  }

  const pending = await listRunnableBackgroundJobCounts();
  await Promise.all(pending.map((row) => runBackgroundJobType(
    row.type,
    Math.min(jobTypeConcurrency(row.type), row.n)
  )));
}

function tick() {
  if (tickPromise) return tickPromise;
  tickPromise = runWorkerTick().finally(() => {
    tickPromise = null;
  });
  return tickPromise;
}

export function startWorker() {
  if (timer) return;
  const onTickError = (error: unknown) => logger.error("worker tick failed", error);
  timer = setInterval(() => tick().catch(onTickError), appConfig.backgroundJob.tickIntervalMs);
  void tick().catch(onTickError);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function drainWorker(
  timeoutMs = appConfig.backgroundJob.drainTimeoutMs
) {
  if (!tickPromise) return;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([tickPromise.catch(() => undefined), deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
}
