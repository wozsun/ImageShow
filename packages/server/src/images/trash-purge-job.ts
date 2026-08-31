import {
  jobRescheduled,
  jobSucceeded,
  type BackgroundJobOutcome
} from "../jobs/handler-outcome.ts";
import type { BackgroundJob } from "../jobs/types.ts";
import { processTrashPurgeJobBatch } from "./trash-purge.ts";

function isLegacyWatermarkJob(job: BackgroundJob) {
  return Object.hasOwn(job.payload, "watermark");
}

export async function handleTrashPurgeJob(
  job: BackgroundJob,
  signal: AbortSignal
): Promise<BackgroundJobOutcome> {
  signal.throwIfAborted();
  if (isLegacyWatermarkJob(job)) {
    throw new Error(
      "Legacy trash.purge watermark job escaped the 5.4.2 startup upgrade"
    );
  }
  const result = await processTrashPurgeJobBatch(job.id, signal);
  if (result.failed) {
    throw new Error(
      `trash purge batch failed for ${result.failed} `
      + `of ${result.processed} scheduled images`
    );
  }
  if (result.remaining) {
    return jobRescheduled(result.processed ? 0 : 1_000);
  }
  return jobSucceeded();
}
