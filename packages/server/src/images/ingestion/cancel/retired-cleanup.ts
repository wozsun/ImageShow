import { mapWithWorkerPool } from "../../../core/concurrency.ts";
import { withStorageLocationReadLock } from "../../../storage/maintenance-lock.ts";
import { removeStorageObjectAndConfirm } from "../../../storage/objects/access.ts";
import { removeIngestionRaw } from "../raw/files.ts";
import type { IngestionSessionSnapshot } from "../sessions/model.ts";

async function cleanupRetiredSession(session: IngestionSessionSnapshot) {
  // Cleanup admission is asynchronous and can outlive the tombstone that
  // originally fenced pair reuse. Delete only this frozen generation; a new
  // incarnation may already own another raw in the same image directory by
  // the time a retry runs. Old parts and unknown generations remain age-scan
  // work.
  const cleanups: Promise<unknown>[] = session.raw_generation
    ? [removeIngestionRaw(session.queue, session, session.raw_generation)]
    : [];
  if (session.prepared) {
    cleanups.push(withStorageLocationReadLock(async (signal) => {
      const removals = await Promise.allSettled([
        removeStorageObjectAndConfirm(
          "_uploads",
          session.prepared!.prepared_image_key,
          session.storage_slug,
          { signal }
        ),
        removeStorageObjectAndConfirm(
          "_uploads",
          session.prepared!.prepared_thumbnail_key,
          session.storage_slug,
          { signal }
        )
      ]);
      const failures = removals.flatMap((result) => (
        result.status === "rejected" ? [result.reason] : []
      ));
      if (failures.length) {
        throw new AggregateError(
          failures,
          "Retired import staging cleanup failed"
        );
      }
    }));
  }
  const results = await Promise.allSettled(cleanups);
  const failures = results.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  ));
  if (failures.length) {
    throw new AggregateError(failures, "Retired import cleanup failed");
  }
}

export async function cleanupRetiredSessions(
  cleanupPlans: readonly IngestionSessionSnapshot[]
) {
  const failures: unknown[] = [];
  await mapWithWorkerPool(cleanupPlans, 1, async (session) => {
    try {
      await cleanupRetiredSession(session);
    } catch (error) {
      failures.push(error);
    }
  });
  if (failures.length) {
    throw new AggregateError(failures, "Retired import batch cleanup failed");
  }
}
