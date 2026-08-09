import { appConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { logger } from "../core/logger.ts";
import { cleanupOrphanRawImports } from "../images/imports/temp-files.ts";
import { scheduleImportCleanupJob } from "../images/imports/cleanup-job.ts";
import {
  handleBackgroundJob,
  type BackgroundJobOutcome
} from "./handlers.ts";
import {
  claimBackgroundJob,
  cleanupBackgroundJobHistory,
  listRunnableBackgroundJobCounts,
  markBackgroundJobFailed,
  markBackgroundJobIgnored,
  markBackgroundJobSucceeded,
  renewBackgroundJobLease,
  rescheduleBackgroundJob,
  recoverStaleBackgroundJobs,
  type BackgroundJob
} from "./repository.ts";
import {
  WorkerExecutionCoordinator,
  type WorkerExecutionCompletion
} from "./worker-execution.ts";

let timer: NodeJS.Timeout | undefined;
let tickPromise: Promise<void> | null = null;
let lastStaleRecovery = 0;
let lastImportCleanup = 0;
let lastHistoryCleanup = 0;

function jobTypeConcurrency(type: string): number {
  const config = getRuntimeConfig();
  switch (type) {
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

function logDiscardedBackgroundJobTransition(
  job: { id: string; type: string },
  transition: "failed" | "ignored" | "rescheduled" | "succeeded"
) {
  logger.warn("discarded background job transition after ownership loss", {
    job_id: job.id,
    type: job.type,
    transition
  });
}

async function settleBackgroundJob(
  job: BackgroundJob,
  completion: WorkerExecutionCompletion<BackgroundJobOutcome>
) {
  if (completion.status === "stopped") {
    if (!await rescheduleBackgroundJob(
      job,
      0
    )) {
      logDiscardedBackgroundJobTransition(job, "rescheduled");
    }
    return;
  }
  if (completion.status === "rejected") {
    if (!await markBackgroundJobFailed(job, completion.error)) {
      logDiscardedBackgroundJobTransition(job, "failed");
    }
    return;
  }

  const outcome = completion.value;
  let stored: boolean;
  let transition: "ignored" | "rescheduled" | "succeeded";
  if (outcome.status === "ignored") {
    transition = "ignored";
    stored = await markBackgroundJobIgnored(job, outcome.reason);
  } else if (outcome.status === "reschedule") {
    transition = "rescheduled";
    stored = await rescheduleBackgroundJob(
      job,
      outcome.delayMs
    );
  } else {
    transition = "succeeded";
    stored = await markBackgroundJobSucceeded(job);
  }
  if (!stored) logDiscardedBackgroundJobTransition(job, transition);
}

const taskTimeoutMs = appConfig.backgroundJob.taskTimeoutSeconds * 1_000;
const executionCoordinator = new WorkerExecutionCoordinator<
  BackgroundJob,
  BackgroundJobOutcome
>({
  taskTimeoutMs,
  leaseRenewalIntervalMs: Math.max(1_000, Math.floor(taskTimeoutMs / 3)),
  renewLease: renewBackgroundJobLease,
  execute: handleBackgroundJob,
  settle: settleBackgroundJob,
  onLeaseLost(job) {
    logger.warn("background job lease ownership lost", {
      job_id: job.id,
      type: job.type
    });
  },
  onLeaseRenewalError(job, error) {
    logger.error("background job lease renewal failed", {
      job_id: job.id,
      type: job.type,
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

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
      if (!executionCoordinator.isAccepting()) return;
      const ran = await executionCoordinator.claimAndRun(
        () => claimBackgroundJob(type)
      );
      if (!ran) return;
      processed += 1;
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
  if (!executionCoordinator.isAccepting()) return;
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

  if (!executionCoordinator.isAccepting()) return;
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
  executionCoordinator.start();
  const onTickError = (error: unknown) => logger.error("worker tick failed", error);
  timer = setInterval(() => tick().catch(onTickError), appConfig.backgroundJob.tickIntervalMs);
  void tick().catch(onTickError);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
  executionCoordinator.stop();
}

export async function drainWorker(
  timeoutMs = appConfig.backgroundJob.drainTimeoutMs
) {
  const additionalWork = tickPromise ? [tickPromise] : [];
  const drained = await executionCoordinator.drain(timeoutMs, additionalWork);
  if (!drained) {
    logger.warn("background worker drain deadline exceeded", { timeout_ms: timeoutMs });
  }
  return drained;
}
