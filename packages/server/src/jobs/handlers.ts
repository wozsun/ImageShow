import {
  jobIgnored,
  jobSucceeded,
  type BackgroundJobOutcome
} from "./handler-outcome.ts";
import type { BackgroundJob, BackgroundJobType } from "./types.ts";
import { handleThumbnailJob } from "../images/thumbnail-job.ts";
import { handleTrashPurgeJob } from "../images/trash-purge-job.ts";
import { handleImportCleanupJob } from "../images/imports/cleanup-job.ts";
import { rebuildRandomPool } from "../random/cache-rebuild.ts";
import { handleMoveCleanupJob } from "../storage/move-cleanup-job.ts";

type BackgroundJobHandler = (
  job: BackgroundJob
) => Promise<BackgroundJobOutcome>;

const backgroundJobHandlers = {
  "thumb.generate": handleThumbnailJob,
  "move.cleanup": handleMoveCleanupJob,
  "import.cleanup": handleImportCleanupJob,
  "trash.purge": handleTrashPurgeJob,
  "cache.rebuild": async () => {
    await rebuildRandomPool();
    return jobSucceeded();
  }
} satisfies Record<BackgroundJobType, BackgroundJobHandler>;

export type { BackgroundJobOutcome } from "./handler-outcome.ts";

export async function handleBackgroundJob(
  job: BackgroundJob
): Promise<BackgroundJobOutcome> {
  const handler = backgroundJobHandlers[
    job.type as BackgroundJobType
  ] as BackgroundJobHandler | undefined;
  return handler ? handler(job) : jobIgnored("not implemented");
}
