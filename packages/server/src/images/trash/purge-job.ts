import { jobSucceeded, type BackgroundJobOutcome } from "../../jobs/handler-outcome.ts";
import type { BackgroundJob } from "../../jobs/types.ts";
import { processTrashPurgeJob } from "./purge.ts";

export async function handleTrashPurgeJob(
  job: BackgroundJob,
  signal: AbortSignal
): Promise<BackgroundJobOutcome> {
  signal.throwIfAborted();
  await processTrashPurgeJob(job, signal);
  return jobSucceeded();
}
