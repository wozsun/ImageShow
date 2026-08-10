import {
  jobRescheduled,
  jobSucceeded,
  type BackgroundJobOutcome
} from "../jobs/handler-outcome.ts";
import { enqueue } from "../jobs/repository.ts";
import type { BackgroundJob } from "../jobs/types.ts";
import { purgeDeletedImages } from "./trash-purge.ts";

export async function handleTrashPurgeJob(
  _job: BackgroundJob,
  signal: AbortSignal
): Promise<BackgroundJobOutcome> {
  signal.throwIfAborted();
  const result = await purgeDeletedImages(undefined, { signal });
  if (result.failed) {
    throw new Error(
      `trash purge batch failed for ${result.failed} `
      + `of ${result.requested} claimed images`
    );
  }
  if (result.remaining) {
    return jobRescheduled(result.requested ? 0 : 1_000);
  }
  return jobSucceeded();
}

export function scheduleTrashPurge() {
  // A concurrent empty-trash request may discover more work after a running
  // row counted zero remaining. An independent row preserves that wake-up.
  return enqueue("trash.purge");
}
