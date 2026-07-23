import { errorMessage } from "../../core/api-error.ts";
import { pool } from "../../core/db.ts";
import { logger } from "../../core/logger.ts";
import { enqueueObjectsForCleanup } from "../../storage/move-cleanup.ts";

export type ImportCandidateObject = {
  prefix: "media" | "thumbs" | "_uploads";
  key: string;
  backend: string;
};

export async function cleanupImportCandidatesIfUnreferenced(
  imageId: string,
  candidates: ImportCandidateObject[],
  reason: string,
  isReferenced: () => Promise<boolean>
) {
  if (!candidates.length) return;

  try {
    if (await isReferenced()) return;
  } catch (error) {
    logger.error("import_candidate_ownership_unknown", {
      image_id: imageId,
      reason,
      error: errorMessage(error),
      candidates
    });
    return;
  }

  try {
    await enqueueObjectsForCleanup(imageId, candidates, reason);
  } catch (error) {
    logger.error("import_candidate_cleanup_failed", {
      image_id: imageId,
      reason,
      error: errorMessage(error),
      candidates
    });
    throw error;
  }
}

export async function importCandidateIsPublishedOrRecoverable(
  id: string,
  backend: string,
  finalKey: string,
  executionToken: string,
  signal: AbortSignal
) {
  const referenced = await pool.query(
    `SELECT 1
       FROM metadata
      WHERE storage_slug=$1 AND object_key=$2
      LIMIT 1`,
    [backend, finalKey]
  );
  if (referenced.rowCount) return true;
  const owner = (await pool.query(
    "SELECT status, execution_token FROM import_session WHERE id=$1",
    [id]
  )).rows[0] as {
    status: string;
    execution_token: string | null;
  } | undefined;
  return Boolean(owner && (
    owner.status === "finalized"
    || (
      owner.status === "committing"
      && (signal.aborted || owner.execution_token !== executionToken)
    )
  ));
}

export function cleanupImportCandidate(
  id: string,
  backend: string,
  finalKey: string,
  executionToken: string,
  signal: AbortSignal,
  reason: string
) {
  return (object: ImportCandidateObject) =>
    cleanupImportCandidatesIfUnreferenced(
      id,
      [object],
      reason,
      () => importCandidateIsPublishedOrRecoverable(
        id,
        backend,
        finalKey,
        executionToken,
        signal
      )
    );
}
