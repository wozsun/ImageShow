import { appConfig } from "@imageshow/shared";
import type {
  ImagePurgeRequestDto,
  ImagePurgeResponseDto
} from "@imageshow/shared/browser";
import { errorMessage } from "../core/api-error.ts";
import { pool } from "../core/database-pools.ts";
import { enqueue } from "../jobs/repository.ts";
import { logger } from "../core/logger.ts";
import { getStorageBackend } from "../storage/backend-registry.ts";
import { thumbnailRef } from "../storage/image-paths.ts";
import { withImageStorageMutationLock } from "../storage/maintenance-lock.ts";
import { assertThumbnailRepairNotPending } from "../storage/move-cleanup.ts";
import {
  removeStorageObjectAndConfirm
} from "../storage/object-access.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";
import { withTrashMembershipLock } from "./trash-membership-lock.ts";

type PurgeRow = {
  id: string;
  object_key: string;
  md5: string;
  storage_slug: string;
  purge_attempts: number;
};

type PurgeOptions = {
  signal?: AbortSignal;
};

export type TrashPurgeWatermark = {
  deletedAt: string;
  id: string;
};

type PurgeTarget =
  | { ids: string[] }
  | { watermark: TrashPurgeWatermark };

type PurgeClaimOutcome =
  | { status: "deleted"; row: PurgeRow }
  | { status: "failed" }
  | { status: "ignored" };

const purgeReturnColumns = [
  "metadata.id",
  "metadata.object_key",
  "metadata.md5",
  "metadata.storage_slug",
  "metadata.purge_attempts"
].join(", ");

function targetPredicate(target: PurgeTarget, params: unknown[]) {
  if ("ids" in target) {
    return `AND id = ANY($${params.push(target.ids)}::uuid[])`;
  }
  const deletedAtParameter = params.push(target.watermark.deletedAt);
  const idParameter = params.push(target.watermark.id);
  return `AND (deleted_at, id) <= (
    $${deletedAtParameter}::timestamptz,
    $${idParameter}::uuid
  )`;
}

async function claimPurgeRows(target: PurgeTarget) {
  const params: unknown[] = [];
  const predicate = targetPredicate(target, params);
  const limit = "ids" in target
    ? Math.min(appConfig.trashBatchSize, target.ids.length)
    : appConfig.trashBatchSize;
  const limitParameter = params.push(limit);
  return (await pool.query(
    `WITH candidates AS (
       SELECT id
         FROM metadata
        WHERE status='deleted'
          AND (
            purge_state IN ('idle', 'failed')
            OR (
              purge_state='purging'
              AND purge_started_at < now() - interval '15 minutes'
            )
          )
          ${predicate}
        ORDER BY deleted_at ASC, id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT $${limitParameter}
     )
     UPDATE metadata
        SET purge_state='purging',
            purge_started_at=now(),
            purge_attempts=purge_attempts + 1,
            purge_error=NULL,
            updated_at=now()
       FROM candidates
      WHERE metadata.id=candidates.id
      RETURNING ${purgeReturnColumns}`,
    params
  )).rows as PurgeRow[];
}

async function releasePurgeClaims(rows: PurgeRow[]) {
  if (!rows.length) return;
  await pool.query(
    `UPDATE metadata
        SET purge_state='idle',
            purge_started_at=NULL,
            updated_at=now()
        FROM unnest($1::uuid[], $2::integer[])
          AS claim(id, purge_attempts)
      WHERE metadata.id=claim.id
        AND metadata.status='deleted'
        AND metadata.purge_state='purging'
        AND metadata.purge_attempts=claim.purge_attempts`,
    [
      rows.map((row) => row.id),
      rows.map((row) => row.purge_attempts)
    ]
  );
}

async function countRemainingPurgeRows(target: PurgeTarget) {
  const params: unknown[] = [];
  const predicate = targetPredicate(target, params);
  const result = await pool.query(
    `SELECT count(*)::int AS count
       FROM metadata
      WHERE status='deleted'
        ${predicate}`,
    params
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function captureTrashPurgeWatermark() {
  return withTrashMembershipLock(async (client) => {
    const row = (await client.query(
      `SELECT deleted_at::text AS deleted_at,
              id,
              (count(*) OVER())::int AS requested
         FROM metadata
        WHERE status='deleted'
        ORDER BY deleted_at DESC, id DESC
        LIMIT 1`
    )).rows[0] as {
      deleted_at: string;
      id: string;
      requested: number;
    } | undefined;
    if (!row) return null;
    return {
      requested: Number(row.requested),
      watermark: {
        // PostgreSQL timestamptz carries microseconds; serializing a JS Date
        // would truncate the maximum row and accidentally exclude it.
        deletedAt: row.deleted_at,
        id: row.id
      }
    };
  });
}

async function markPurgeFailed(row: PurgeRow, error: unknown) {
  const message = errorMessage(error).slice(0, 2_000);
  await pool.query(
    `UPDATE metadata
        SET purge_state='failed', purge_error=$2, updated_at=now()
      WHERE id=$1
        AND status='deleted'
        AND purge_state='purging'
        AND purge_attempts=$3`,
    [row.id, message, row.purge_attempts]
  );
}

async function recordPurgeFailure(row: PurgeRow, error: unknown) {
  try {
    await markPurgeFailed(row, error);
  } catch (stateError) {
    logger.error("trash_purge_failure_state_update_failed", {
      image_id: row.id,
      purge_attempt: row.purge_attempts,
      purge_error: errorMessage(error),
      state_error: errorMessage(stateError)
    });
  }
}

async function purgeClaimedRow(claim: PurgeRow): Promise<PurgeRow | null> {
  return withImageStorageMutationLock(claim.id, async (signal) => {
    signal.throwIfAborted();
    const row = (await pool.query(
      `SELECT ${purgeReturnColumns}
         FROM metadata
        WHERE id=$1
          AND status='deleted'
          AND purge_state='purging'
          AND purge_attempts=$2`,
      [claim.id, claim.purge_attempts]
    )).rows[0] as PurgeRow | undefined;
    signal.throwIfAborted();
    if (!row) return null;

    const thumb = thumbnailRef(row);
    const backend = await getStorageBackend(row.storage_slug);
    signal.throwIfAborted();
    await assertThumbnailRepairNotPending(row.id, backend, thumb.key);
    signal.throwIfAborted();
    const removals = await Promise.allSettled([
      removeStorageObjectAndConfirm(
        thumb.prefix,
        thumb.key,
        row.storage_slug,
        { signal }
      ),
      removeStorageObjectAndConfirm(
        "media",
        row.object_key,
        row.storage_slug,
        { signal }
      )
    ]);
    signal.throwIfAborted();
    const removalErrors = removals.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (removalErrors.length) {
      throw new AggregateError(
        removalErrors,
        "Failed to remove all image objects"
      );
    }
    signal.throwIfAborted();

    const deleted = await pool.query(
      `DELETE FROM metadata
        WHERE id=$1
          AND status='deleted'
          AND purge_state='purging'
          AND purge_attempts=$2
          AND storage_slug=$3
          AND object_key=$4
        RETURNING id`,
      [row.id, row.purge_attempts, row.storage_slug, row.object_key]
    );
    signal.throwIfAborted();
    return deleted.rowCount ? row : null;
  });
}

function isSignalAbort(error: unknown, signal?: AbortSignal) {
  return signal?.aborted === true && error === signal.reason;
}

async function processPurgeClaim(
  row: PurgeRow,
  signal?: AbortSignal
): Promise<PurgeClaimOutcome> {
  try {
    signal?.throwIfAborted();
    const deleted = await purgeClaimedRow(row);
    if (deleted) return { status: "deleted", row: deleted };
    await recordPurgeFailure(row, new Error(
      "Purge ownership was lost before metadata deletion"
    ));
  } catch (error) {
    if (isSignalAbort(error, signal)) throw error;
    await recordPurgeFailure(row, error);
  }

  const current = (await pool.query(
    "SELECT status FROM metadata WHERE id=$1",
    [row.id]
  )).rows[0] as { status: string } | undefined;
  if (!current) return { status: "deleted", row };
  return current.status === "deleted"
    ? { status: "failed" }
    : { status: "ignored" };
}

async function purgeTargetBatch(
  target: PurgeTarget,
  options: PurgeOptions = {}
) {
  const rows = await claimPurgeRows(target);
  const deletedRows: PurgeRow[] = [];
  const finalizationErrors: unknown[] = [];
  let failed = 0;

  try {
    for (let offset = 0; offset < rows.length; offset += 10) {
      const results = await Promise.allSettled(
        rows.slice(offset, offset + 10).map((row) =>
          processPurgeClaim(row, options.signal)
        )
      );
      for (const result of results) {
        if (result.status === "fulfilled") {
          if (result.value.status === "deleted") {
            deletedRows.push(result.value.row);
          } else if (result.value.status === "failed") {
            failed += 1;
          }
        }
      }
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected) throw rejected.reason;
    }
  } catch (error) {
    finalizationErrors.push(error);
  }

  try {
    await releasePurgeClaims(rows);
  } catch (error) {
    finalizationErrors.push(error);
  }

  try {
    if (rows.length) await invalidateEntityCountCaches(["tag"]);
  } catch (error) {
    finalizationErrors.push(error);
  }
  if (finalizationErrors.length === 1) throw finalizationErrors[0];
  if (finalizationErrors.length > 1) {
    throw new AggregateError(
      finalizationErrors,
      "Trash purge batch failed during processing or finalization"
    );
  }

  return {
    claimed: rows.length,
    deleted: deletedRows.length,
    failed,
    remaining: await countRemainingPurgeRows(target)
  };
}

async function purgeSelectedImages(
  ids: string[],
  options: PurgeOptions
): Promise<ImagePurgeResponseDto> {
  let deleted = 0;
  let failed = 0;
  let remaining = 0;
  for (let offset = 0; offset < ids.length; offset += appConfig.trashBatchSize) {
    const target = { ids: ids.slice(offset, offset + appConfig.trashBatchSize) };
    const result = await purgeTargetBatch(target, options);
    deleted += result.deleted;
    failed += result.failed;
    remaining += result.remaining;
  }
  return {
    requested: ids.length,
    deleted,
    failed,
    remaining,
    ignored: Math.max(0, ids.length - deleted - remaining)
  };
}

export async function purgeImages(
  request: ImagePurgeRequestDto,
  options: PurgeOptions = {}
): Promise<ImagePurgeResponseDto> {
  if (request.scope === "selected") {
    return purgeSelectedImages(request.ids, options);
  }

  const captured = await captureTrashPurgeWatermark();
  if (!captured) {
    return {
      requested: 0,
      deleted: 0,
      failed: 0,
      remaining: 0,
      ignored: 0
    };
  }
  await scheduleTrashPurge(captured.watermark);
  const result = await purgeTargetBatch(
    { watermark: captured.watermark },
    options
  );
  return {
    requested: captured.requested,
    deleted: result.deleted,
    failed: result.failed,
    remaining: result.remaining,
    ignored: Math.max(
      0,
      captured.requested - result.deleted - result.remaining
    )
  };
}

function scheduleTrashPurge(watermark: TrashPurgeWatermark) {
  return enqueue("trash.purge", "", { watermark });
}

export function continueTrashPurge(
  watermark: TrashPurgeWatermark,
  options: PurgeOptions = {}
) {
  return purgeTargetBatch({ watermark }, options);
}
