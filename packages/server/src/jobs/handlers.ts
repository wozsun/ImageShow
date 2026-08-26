import {
  jobSucceeded,
  type BackgroundJobOutcome
} from "./handler-outcome.ts";
import type { BackgroundJob, BackgroundJobType } from "./types.ts";
import { handleTrashPurgeJob } from "../images/trash-purge-job.ts";
import { ensureReadyImageCacheCurrent } from "../images/ready-cache/coordinator.ts";
import { handleMoveCleanupJob } from "../storage/move-cleanup-job.ts";
import { runWithAdvisoryLockSignal } from "../core/database-advisory-locks.ts";

type BackgroundJobHandler = (
  job: BackgroundJob,
  signal: AbortSignal
) => Promise<BackgroundJobOutcome>;

const backgroundJobHandlers: Record<
  BackgroundJobType,
  BackgroundJobHandler
> = {
  "move.cleanup": handleMoveCleanupJob,
  "trash.purge": handleTrashPurgeJob,
  "cache.rebuild": async (_job, signal) => {
    await ensureReadyImageCacheCurrent({ signal });
    return jobSucceeded();
  }
};

export type { BackgroundJobOutcome } from "./handler-outcome.ts";

export async function handleBackgroundJob(
  job: BackgroundJob,
  signal: AbortSignal = new AbortController().signal
): Promise<BackgroundJobOutcome> {
  const handler = backgroundJobHandlers[job.type];
  return runWithAdvisoryLockSignal(signal, () => handler(job, signal));
}
