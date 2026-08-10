import {
  jobRescheduled,
  jobSucceeded,
  type BackgroundJobOutcome
} from "../jobs/handler-outcome.ts";
import type { BackgroundJob } from "../jobs/types.ts";
import {
  continueTrashPurge,
  type TrashPurgeWatermark
} from "./trash-purge.ts";

function trashPurgeWatermark(job: BackgroundJob): TrashPurgeWatermark {
  const value = job.payload.watermark;
  if (
    !value
    || typeof value !== "object"
    || typeof (value as Record<string, unknown>).deletedAt !== "string"
    || typeof (value as Record<string, unknown>).id !== "string"
  ) {
    throw new Error("trash.purge job is missing its deletion watermark");
  }
  return value as TrashPurgeWatermark;
}

export async function handleTrashPurgeJob(
  job: BackgroundJob,
  signal: AbortSignal
): Promise<BackgroundJobOutcome> {
  signal.throwIfAborted();
  const result = await continueTrashPurge(trashPurgeWatermark(job), {
    signal
  });
  if (result.failed) {
    throw new Error(
      `trash purge batch failed for ${result.failed} `
      + `of ${result.claimed} claimed images`
    );
  }
  if (result.remaining) {
    return jobRescheduled(result.claimed ? 0 : 1_000);
  }
  return jobSucceeded();
}
