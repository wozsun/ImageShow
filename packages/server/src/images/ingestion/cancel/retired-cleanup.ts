import { mapWithWorkerPool } from "../../../core/concurrency.ts";
import { removeIngestionPreparedFiles } from "../raw/prepared.ts";
import { removeIngestionRaw } from "../raw/files.ts";
import type { IngestionSessionSnapshot } from "../sessions/model.ts";

async function cleanupRetiredSession(session: IngestionSessionSnapshot) {
  // Cleanup admission is asynchronous and can outlive the tombstone that
  // originally fenced pair reuse. Delete only this frozen generation; a new
  // incarnation may already own another raw in the same image directory by
  // the time a retry runs. Old parts and unknown generations remain age-scan
  // work.
  const cleanups: Promise<unknown>[] = session.raw_generation
    ? [removeIngestionRaw(session, session.raw_generation)]
    : [];
  if (session.prepared) {
    cleanups.push(removeIngestionPreparedFiles([
      session.prepared.prepared_image_path,
      session.prepared.prepared_thumbnail_path
    ]));
  }
  const results = await Promise.allSettled(cleanups);
  const failures = results.flatMap((result) => (
    result.status === "rejected" ? [result.reason] : []
  ));
  if (failures.length) {
    throw new AggregateError(failures, "Retired Ingestion cleanup failed");
  }
}

export async function cleanupRetiredSessions(
  retiredSessions: readonly IngestionSessionSnapshot[]
) {
  const failures: unknown[] = [];
  await mapWithWorkerPool(retiredSessions, 1, async (session) => {
    try {
      await cleanupRetiredSession(session);
    } catch (error) {
      failures.push(error);
    }
  });
  if (failures.length) {
    throw new AggregateError(failures, "Retired Ingestion batch cleanup failed");
  }
}
