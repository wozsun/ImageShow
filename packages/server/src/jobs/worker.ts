import { appConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { logger } from "../core/logger.ts";
import { cleanupOrphanRawImports } from "../images/imports/temp-files.ts";
import { scheduleImportCleanupJob } from "../images/imports/cleanup-job.ts";
import { handleBackgroundJob } from "./handlers.ts";
import {
  claimBackgroundJob,
  cleanupBackgroundJobHistory,
  listRunnableBackgroundJobCounts,
  markBackgroundJobFailed,
  markBackgroundJobIgnored,
  markBackgroundJobSucceeded,
  rescheduleBackgroundJob,
  recoverStaleBackgroundJobs
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

type QueueSliceResult = {
  processed: number;
  durationMs: number;
  budgetExhausted: boolean;
};

async function runBackgroundJobType(type: string, lanes: number): Promise<QueueSliceResult> {
  const startedAt = performance.now();
  const deadline = startedAt + appConfig.backgroundJob.queueSliceMaxMs;
  let claimed = 0;
  let processed = 0;

  const reserveClaim = () => {
    if (claimed >= appConfig.backgroundJob.queueSliceMaxJobs) return false;
    if (performance.now() >= deadline) return false;
    claimed += 1;
    return true;
  };

  async function runLane() {
    while (reserveClaim()) {
      const job = await claimBackgroundJob(type);
      if (!job) return;
      try {
        const outcome = await handleBackgroundJob(job);
        if (outcome.status === "ignored") {
          await markBackgroundJobIgnored(job.id, outcome.reason);
        } else if (outcome.status === "reschedule") {
          await rescheduleBackgroundJob(job.id, outcome.delayMs, outcome.result);
        } else {
          await markBackgroundJobSucceeded(job.id, outcome.result);
        }
      } catch (error) {
        await markBackgroundJobFailed(job, error);
      } finally {
        processed += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, runLane));
  return {
    processed,
    durationMs: performance.now() - startedAt,
    budgetExhausted: claimed >= appConfig.backgroundJob.queueSliceMaxJobs
      || performance.now() >= deadline
  };
}

async function scheduleExpiredImportCleanup() {
  await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);
  await scheduleImportCleanupJob();
}

async function runWorkerTick() {
  const now = Date.now();
  if (now - lastStaleRecovery >= appConfig.backgroundJob.staleRecoveryIntervalMs) {
    const delayMs = lastStaleRecovery
      ? Math.max(0, now - lastStaleRecovery - appConfig.backgroundJob.staleRecoveryIntervalMs)
      : 0;
    lastStaleRecovery = now;
    await recoverStaleBackgroundJobs();
    logger.debug("worker_periodic_task", { task: "stale_recovery", delay_ms: delayMs });
  }
  if (now - lastImportCleanup >= appConfig.backgroundJob.expireUploadsIntervalMs) {
    const delayMs = lastImportCleanup
      ? Math.max(0, now - lastImportCleanup - appConfig.backgroundJob.expireUploadsIntervalMs)
      : 0;
    lastImportCleanup = now;
    await scheduleExpiredImportCleanup();
    logger.debug("worker_periodic_task", { task: "import_cleanup", delay_ms: delayMs });
  }
  if (now - lastHistoryCleanup >= appConfig.backgroundJob.historyCleanupIntervalMs) {
    const delayMs = lastHistoryCleanup
      ? Math.max(0, now - lastHistoryCleanup - appConfig.backgroundJob.historyCleanupIntervalMs)
      : 0;
    lastHistoryCleanup = now;
    await cleanupBackgroundJobHistory();
    logger.debug("worker_periodic_task", { task: "history_cleanup", delay_ms: delayMs });
  }

  const pending = await listRunnableBackgroundJobCounts();
  await Promise.all(pending.map(async (row) => {
    const result = await runBackgroundJobType(
      row.type,
      Math.min(jobTypeConcurrency(row.type), row.n)
    );
    logger.debug("worker_queue_slice", {
      type: row.type,
      backlog: row.n,
      oldest_wait_ms: row.oldest_wait_ms,
      processed: result.processed,
      duration_ms: Math.round(result.durationMs * 100) / 100,
      budget_exhausted: result.budgetExhausted
    });
  }));
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
