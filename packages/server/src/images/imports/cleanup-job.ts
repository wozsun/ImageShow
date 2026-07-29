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
import {
  appendImportCleanupFailure,
  mergeImportCleanupFailures,
  type ImportCleanupFailures
} from "./cleanup-failures.ts";
import {
  clearImportCancelled,
  markImportCancelled,
  type ImportCancellationMarker
} from "./lifecycle.ts";

type ExpiredImportCleanup = {
  id: string;
  storageSlug: string;
  finalObjectKey: string;
};

type ExpiredImportCandidate = {
  id: string;
  cancellation_generation: string;
};

function cancellationOwnerKey(id: string, generation: string) {
  return `${id}:${generation}`;
}

async function cancelExpiredCommittingImports() {
  const candidates = (await pool.query(
    `SELECT id, created_at::text AS cancellation_generation
       FROM import_session
      WHERE status='committing' AND expires_at < now()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [appConfig.trashBatchSize]
  )).rows as ExpiredImportCandidate[];
  if (!candidates.length) return 0;

  let cancelled = 0;
  for (const candidate of candidates) {
    const cancellation = await markImportCancelled(
      candidate.id,
      candidate.cancellation_generation
    );
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
              AND created_at=$2::timestamptz
              AND status='committing'
              AND expires_at < now()`,
          [candidate.id, candidate.cancellation_generation]
        );
      }
    );
    // 未取得锁时没有发布 PostgreSQL 取消；取得锁则已经证明执行者退出。
    await clearImportCancelled(cancellation);
    if (attempt.acquired) {
      cancelled += attempt.value.rowCount ?? 0;
    }
  }
  return cancelled;
}

export async function handleImportCleanupJob(): Promise<BackgroundJobOutcome> {
  const cancelledCommitting = await cancelExpiredCommittingImports();
  const candidates = (await pool.query(
    `SELECT id, created_at::text AS cancellation_generation
       FROM import_session
      WHERE status IN (
        'created','materializing','received','preparing','ready',
        'finalized','failed','cancelled'
      )
        AND expires_at < now()
      ORDER BY expires_at ASC
      LIMIT $1`,
    [appConfig.trashBatchSize]
  )).rows as ExpiredImportCandidate[];
  const cancellations = await Promise.all(candidates.map((candidate) =>
    markImportCancelled(candidate.id, candidate.cancellation_generation)
  ));
  const cancellationByOwner = new Map(
    cancellations.map((cancellation) => [
      cancellationOwnerKey(cancellation.id, cancellation.generation),
      cancellation
    ])
  );

  const rows = (await pool.query(
    `WITH candidates AS (
       SELECT *
         FROM unnest($1::uuid[], $2::timestamptz[])
           AS candidate(id, created_at)
     ),
     expired AS (
       SELECT session.id
         FROM import_session AS session
         JOIN candidates AS candidate
           ON candidate.id=session.id
          AND candidate.created_at=session.created_at
        WHERE session.status IN (
          'created','materializing','received','preparing','ready',
          'finalized','failed','cancelled'
        )
          AND session.expires_at < now()
        ORDER BY session.expires_at ASC
        FOR UPDATE OF session SKIP LOCKED
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
      RETURNING session.id,
                session.created_at::text AS cancellation_generation`,
    [
      candidates.map(({ id }) => id),
      candidates.map(({ cancellation_generation }) =>
        cancellation_generation
      )
    ]
  )).rows as ExpiredImportCandidate[];
  const claimedOwners = new Set(rows.map((row) =>
    cancellationOwnerKey(row.id, row.cancellation_generation)
  ));
  await Promise.all(cancellations
    .filter((cancellation) => !claimedOwners.has(cancellationOwnerKey(
      cancellation.id,
      cancellation.generation
    )))
    .map(clearImportCancelled));

  const cleanups: ExpiredImportCleanup[] = [];
  const failures: ImportCleanupFailures = new Map();
  for (const row of rows) {
    const cancellation = cancellationByOwner.get(cancellationOwnerKey(
      row.id,
      row.cancellation_generation
    ));
    if (!cancellation) {
      appendImportCleanupFailure(
        failures,
        row.id,
        new Error("Import cleanup lost cancellation marker ownership")
      );
      continue;
    }
    try {
      await abortActiveImport(row.id);
      await withImportSessionLock(row.id, async (signal) => {
        signal.throwIfAborted();
        const session = (await pool.query(
          `SELECT status, storage_slug, final_object_key,
                  created_at::text AS cancellation_generation
             FROM import_session
            WHERE id=$1`,
          [row.id]
        )).rows[0] as {
          status: string;
          storage_slug: string;
          final_object_key: string;
          cancellation_generation: string;
        } | undefined;
        if (
          !session
          || session.cancellation_generation !==
            row.cancellation_generation
          || !["cancelled", "finalized"].includes(session.status)
        ) {
          await clearImportCancelled(cancellation);
          return;
        }
        // 会话锁与已收口的本地执行共同证明取消竞态窗口已经结束。
        await clearImportCancelled(cancellation);
        signal.throwIfAborted();
        cleanups.push({
          id: row.id,
          storageSlug: session.storage_slug,
          finalObjectKey: session.final_object_key
        });
      });
    } catch (error) {
      appendImportCleanupFailure(failures, row.id, error);
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
    mergeImportCleanupFailures(failures, stagingFailures);
  }

  try {
    const rawFailures = await removeRawImports(cleanupIds);
    mergeImportCleanupFailures(failures, rawFailures);
  } catch (error) {
    for (const id of cleanupIds) {
      appendImportCleanupFailure(failures, id, error);
    }
  }

  await mapWithWorkerPool(
    cleanups,
    getRuntimeConfig().background_job.move_cleanup_concurrency,
    async ({ id, finalObjectKey, storageSlug }) => {
      try {
        await cleanupFinalImportObjects(id, finalObjectKey, storageSlug);
      } catch (error) {
        appendImportCleanupFailure(failures, id, error);
      }
    }
  );

  const cleanedIds = cleanupIds.filter((id) => !failures.has(id));
  const cleanedIdSet = new Set(cleanedIds);
  const cleanedCandidates = rows.filter(({ id }) => cleanedIdSet.has(id));

  const deletedExpired = await pool.query(
    `DELETE FROM import_session AS session
      USING unnest($1::uuid[], $2::timestamptz[])
        AS candidate(id, created_at)
      WHERE session.id=candidate.id
        AND session.created_at=candidate.created_at
        AND session.status IN ('cancelled','finalized')`,
    [
      cleanedCandidates.map(({ id }) => id),
      cleanedCandidates.map(({ cancellation_generation }) =>
        cancellation_generation
      )
    ]
  );
  await Promise.all(cleanedCandidates
    .map((row) => cancellationByOwner.get(cancellationOwnerKey(
      row.id,
      row.cancellation_generation
    )))
    .filter((
      cancellation
    ): cancellation is ImportCancellationMarker => Boolean(cancellation))
    .map(clearImportCancelled));
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
