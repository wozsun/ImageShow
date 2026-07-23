import { appConfig } from "@imageshow/shared";
import { errorMessage } from "../../core/api-error.ts";
import { mapWithWorkerPool } from "../../core/concurrency.ts";
import { pool } from "../../core/db.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import {
  jobSucceeded,
  type BackgroundJobOutcome
} from "../../jobs/handler-outcome.ts";
import {
  tryWithStorageLocationReadAndAdvisoryLocks
} from "../../storage/maintenance-lock.ts";
import { abortActiveImport } from "./execution.ts";
import {
  importSessionLockKey,
  withImportSessionLock
} from "./session-lock.ts";
import {
  cleanupFinalImportObjects,
  cleanupStagedObjectsBatch
} from "./staging.ts";
import {
  cleanupOrphanRawImports,
  removeRawImports
} from "./temp-files.ts";

type ExpiredImportCleanup = {
  id: string;
  storageSlug: string;
  finalObjectKey: string;
};

function appendFailure(
  failures: Map<string, unknown[]>,
  id: string,
  error: unknown
) {
  const current = failures.get(id);
  if (current) current.push(error);
  else failures.set(id, [error]);
}

async function cancelExpiredCommittingImports() {
  const candidates = (await pool.query(
    `SELECT id
       FROM import_session
      WHERE status='committing' AND expires_at < now()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [appConfig.trashBatchSize]
  )).rows as Array<{ id: string }>;
  if (!candidates.length) return 0;

  let cancelled = 0;
  for (const candidate of candidates) {
    const attempt = await tryWithStorageLocationReadAndAdvisoryLocks(
      [{ key: importSessionLockKey(candidate.id), acquisition: "try" }],
      (signal) => {
        signal.throwIfAborted();
        return pool.query(
          `UPDATE import_session
              SET status='cancelled',
                  execution_token=NULL,
                  raw_token=NULL,
                  error='提交进程中断且会话已过期',
                  updated_at=now()
            WHERE id=$1
              AND status='committing'
              AND expires_at < now()`,
          [candidate.id]
        );
      }
    );
    if (attempt.acquired) {
      cancelled += attempt.value.rowCount ?? 0;
    }
  }
  return cancelled;
}

export async function handleImportCleanupJob(): Promise<BackgroundJobOutcome> {
  const cancelledCommitting = await cancelExpiredCommittingImports();
  const rows = (await pool.query(
    `WITH expired AS (
       SELECT id
         FROM import_session
        WHERE status IN (
          'created','materializing','received','preparing','ready',
          'finalized','failed','cancelled'
        )
          AND expires_at < now()
        ORDER BY expires_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $1
     )
     UPDATE import_session AS session
        SET status=CASE
              WHEN session.status='finalized' THEN 'finalized'
              ELSE 'cancelled'
            END,
            execution_token=NULL,
            raw_token=NULL,
            updated_at=now()
       FROM expired
      WHERE session.id=expired.id
      RETURNING session.id`,
    [appConfig.trashBatchSize]
  )).rows as Array<{ id: string }>;

  const cleanups: ExpiredImportCleanup[] = [];
  const failures = new Map<string, unknown[]>();
  for (const row of rows) {
    try {
      await abortActiveImport(row.id);
      await withImportSessionLock(row.id, async (signal) => {
        signal.throwIfAborted();
        const session = (await pool.query(
          `SELECT status, storage_slug, final_object_key
             FROM import_session
            WHERE id=$1`,
          [row.id]
        )).rows[0] as {
          status: string;
          storage_slug: string;
          final_object_key: string;
        } | undefined;
        if (
          !session
          || !["cancelled", "finalized"].includes(session.status)
        ) {
          return;
        }
        signal.throwIfAborted();
        cleanups.push({
          id: row.id,
          storageSlug: session.storage_slug,
          finalObjectKey: session.final_object_key
        });
      });
    } catch (error) {
      appendFailure(failures, row.id, error);
    }
  }

  const cleanupIds = cleanups.map(({ id }) => id);
  const byStorage = new Map<string, string[]>();
  for (const cleanup of cleanups) {
    const ids = byStorage.get(cleanup.storageSlug);
    if (ids) ids.push(cleanup.id);
    else byStorage.set(cleanup.storageSlug, [cleanup.id]);
  }
  for (const [storageSlug, ids] of byStorage) {
    const stagingFailures = await cleanupStagedObjectsBatch(ids, storageSlug);
    for (const [id, errors] of stagingFailures) {
      for (const error of errors) appendFailure(failures, id, error);
    }
  }

  try {
    const rawFailures = await removeRawImports(cleanupIds);
    for (const [id, errors] of rawFailures) {
      for (const error of errors) appendFailure(failures, id, error);
    }
  } catch (error) {
    for (const id of cleanupIds) appendFailure(failures, id, error);
  }

  await mapWithWorkerPool(
    cleanups,
    getRuntimeConfig().background_job.move_cleanup_concurrency,
    async ({ id, finalObjectKey, storageSlug }) => {
      try {
        await cleanupFinalImportObjects(id, finalObjectKey, storageSlug);
      } catch (error) {
        appendFailure(failures, id, error);
      }
    }
  );

  const cleanedIds = cleanupIds.filter((id) => !failures.has(id));

  const deletedExpired = await pool.query(
    `DELETE FROM import_session
      WHERE id = ANY($1::uuid[])
        AND status IN ('cancelled','finalized')`,
    [cleanedIds]
  );
  await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);

  if (failures.size) {
    const messages = [...failures].map(([id, errors]) => (
      `${id}: ${errors.map(errorMessage).join(", ")}`
    ));
    throw new Error(`import cleanup failed: ${messages.join("; ")}`);
  }
  return jobSucceeded({
    cleaned: deletedExpired.rowCount ?? 0,
    cancelled_committing: cancelledCommitting
  });
}

export async function scheduleImportCleanupJob() {
  await pool.query(
    `INSERT INTO background_job(id, type, status)
     SELECT $1, 'import.cleanup', 'pending'
      WHERE EXISTS (
        SELECT 1 FROM import_session WHERE expires_at < now()
      )
        AND NOT EXISTS (
          SELECT 1
            FROM background_job
           WHERE type='import.cleanup'
             AND status IN ('pending', 'running')
        )`,
    [randomUuidV7()]
  );
}
