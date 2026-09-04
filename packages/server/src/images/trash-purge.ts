import { appConfig } from "@imageshow/shared";
import type {
  ImagePurgeRequestDto,
  ImagePurgeResponseDto
} from "@imageshow/shared/browser";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import { errorMessage } from "../core/api-error.ts";
import {
  runWithAdvisoryLockAcquisitionSignal
} from "../core/database/advisory-locks.ts";
import { pool } from "../core/database/pools.ts";
import { withTransactionOnClient } from "../core/database/transactions.ts";
import { logger } from "../core/logger.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import { thumbnailRef } from "../storage/objects/image-paths.ts";
import { withImageStorageMutationLock } from "../storage/maintenance-lock.ts";
import {
  assertStorageRemovalResults,
  removeStorageObjectsAndConfirm
} from "../storage/objects/access.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";
import { withTrashMembershipLock } from "./trash-membership-lock.ts";

type PurgeRow = {
  id: string;
  object_key: string;
  md5: string;
  storage_slug: string;
  purge_job_id: string;
};

type QueuePlan = Pick<
  ImagePurgeResponseDto,
  "requested" | "queued" | "already_queued" | "ignored"
> & {
  queueableIds: string[];
  targetIds: string[];
};

type PurgeOptions = {
  signal?: AbortSignal;
};

type PurgeWaitState = {
  remaining: number;
  deferred: number;
};

type PurgeItemOutcome = "deleted" | "failed" | "ignored";

const purgeReturnColumns = [
  "metadata.id",
  "metadata.object_key",
  "metadata.md5",
  "metadata.storage_slug",
  "metadata.purge_job_id"
].join(", ");

const purgeRequestWaitMs = 30_000;
const purgeRequestPollMs = 250;

function numberField(value: unknown, field: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return parsed;
}

function uuidArrayField(value: unknown, field: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return value as string[];
}

async function selectedQueueCounts(
  client: PoolClient,
  ids: string[]
): Promise<QueuePlan> {
  const row = (await client.query(
    `SELECT count(*)::int AS requested,
            count(*) FILTER (
              WHERE metadata.status='deleted'
                AND metadata.purge_job_id IS NOT NULL
            )::int AS already_queued,
            count(*) FILTER (
              WHERE metadata.status='deleted'
                AND metadata.purge_job_id IS NULL
            )::int AS queueable,
            COALESCE(
              array_agg(metadata.id ORDER BY requested.ordinality) FILTER (
                WHERE metadata.status='deleted'
              ),
              '{}'::uuid[]
            ) AS target_ids,
            COALESCE(
              array_agg(metadata.id ORDER BY requested.ordinality) FILTER (
                WHERE metadata.status='deleted'
                  AND metadata.purge_job_id IS NULL
              ),
              '{}'::uuid[]
            ) AS queueable_ids
       FROM unnest($1::uuid[]) WITH ORDINALITY AS requested(id, ordinality)
       LEFT JOIN metadata ON metadata.id=requested.id`,
    [ids]
  )).rows[0] as Record<string, unknown> | undefined;
  const requested = numberField(row?.requested, "selected purge count");
  const alreadyQueued = numberField(
    row?.already_queued,
    "selected already-queued purge count"
  );
  const queueable = numberField(row?.queueable, "selected queueable count");
  const targetIds = uuidArrayField(row?.target_ids, "selected purge targets");
  const queueableIds = uuidArrayField(
    row?.queueable_ids,
    "selected queueable purge targets"
  );
  if (targetIds.length !== alreadyQueued + queueable
      || queueableIds.length !== queueable) {
    throw new Error("PostgreSQL returned inconsistent selected purge targets");
  }
  return {
    requested,
    queued: 0,
    already_queued: alreadyQueued,
    ignored: requested - alreadyQueued - queueable,
    queueableIds,
    targetIds
  };
}

async function allQueueCounts(client: PoolClient): Promise<QueuePlan> {
  const row = (await client.query(
    `SELECT count(*)::int AS requested,
            count(*) FILTER (
              WHERE purge_job_id IS NOT NULL
            )::int AS already_queued,
            count(*) FILTER (
              WHERE purge_job_id IS NULL
            )::int AS queueable,
            COALESCE(
              array_agg(id ORDER BY deleted_at, id),
              '{}'::uuid[]
            ) AS target_ids,
            COALESCE(
              array_agg(id ORDER BY deleted_at, id) FILTER (
                WHERE purge_job_id IS NULL
              ),
              '{}'::uuid[]
            ) AS queueable_ids
       FROM metadata
      WHERE status='deleted'`
  )).rows[0] as Record<string, unknown> | undefined;
  const requested = numberField(row?.requested, "trash purge count");
  const alreadyQueued = numberField(
    row?.already_queued,
    "already-queued trash purge count"
  );
  const queueable = numberField(row?.queueable, "queueable trash purge count");
  const targetIds = uuidArrayField(row?.target_ids, "trash purge targets");
  const queueableIds = uuidArrayField(
    row?.queueable_ids,
    "queueable trash purge targets"
  );
  if (targetIds.length !== alreadyQueued + queueable
      || queueableIds.length !== queueable) {
    throw new Error("PostgreSQL returned inconsistent trash purge targets");
  }
  return {
    requested,
    queued: 0,
    already_queued: alreadyQueued,
    ignored: requested - alreadyQueued - queueable,
    queueableIds,
    targetIds
  };
}

async function insertTrashPurgeJob(client: PoolClient, jobId: string) {
  await client.query(
    `INSERT INTO background_job(id, type, target_id, payload)
     VALUES($1, 'trash.purge', '', $2::jsonb)`,
    [jobId, JSON.stringify({ retain_exhausted: true })]
  );
}

async function bindPurgeJob(
  client: PoolClient,
  ids: string[],
  jobId: string
) {
  return client.query(
    `UPDATE metadata
        SET purge_job_id=$1, updated_at=now()
      WHERE id=ANY($2::uuid[])
        AND status='deleted'
        AND purge_job_id IS NULL
      RETURNING id`,
    [jobId, ids]
  );
}

async function queueTrashPurge(
  client: PoolClient,
  request: ImagePurgeRequestDto
): Promise<QueuePlan> {
  const plan = request.scope === "all"
    ? await allQueueCounts(client)
    : await selectedQueueCounts(client, request.ids);
  if (!plan.queueableIds.length) return plan;

  const jobId = randomUuidV7();
  await insertTrashPurgeJob(client, jobId);
  const bound = await bindPurgeJob(client, plan.queueableIds, jobId);
  if (bound.rowCount !== plan.queueableIds.length) {
    throw new Error(
      "Trash membership changed while binding a persistent purge job"
    );
  }
  return {
    ...plan,
    queued: bound.rowCount,
  };
}

async function readPurgeWaitState(ids: string[]): Promise<PurgeWaitState> {
  if (!ids.length) return { remaining: 0, deferred: 0 };
  const row = (await pool.query(
    `SELECT count(*)::int AS remaining,
            count(*) FILTER (
              WHERE background_job.id IS NULL
                 OR background_job.type <> 'trash.purge'
                 OR background_job.status IN ('failed', 'succeeded')
            )::int AS deferred
       FROM unnest($1::uuid[]) AS target(id)
       JOIN metadata
         ON metadata.id=target.id
        AND metadata.status='deleted'
        AND metadata.purge_job_id IS NOT NULL
       LEFT JOIN background_job
         ON background_job.id=metadata.purge_job_id`,
    [ids]
  )).rows[0] as Record<string, unknown> | undefined;
  return {
    remaining: numberField(row?.remaining, "remaining purge request count"),
    deferred: numberField(row?.deferred, "deferred purge request count")
  };
}

async function waitForPurgeTargets(
  plan: QueuePlan,
  signal?: AbortSignal
): Promise<ImagePurgeResponseDto> {
  const deadline = Date.now() + purgeRequestWaitMs;
  let state = await readPurgeWaitState(plan.targetIds);
  while (state.remaining && !state.deferred && Date.now() < deadline) {
    signal?.throwIfAborted();
    const remainingWaitMs = Math.min(
      purgeRequestPollMs,
      deadline - Date.now()
    );
    if (remainingWaitMs <= 0) break;
    try {
      await delay(
        remainingWaitMs,
        undefined,
        signal ? { signal } : undefined
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw error;
    }
    state = await readPurgeWaitState(plan.targetIds);
  }
  return {
    requested: plan.requested,
    queued: plan.queued,
    already_queued: plan.already_queued,
    deleted: plan.targetIds.length - state.remaining,
    remaining: state.remaining,
    ignored: plan.ignored
  };
}

/**
 * Persist the complete user-confirmed deletion intent, then keep the ordinary
 * confirmation request open while the sole background owner finishes that
 * exact 1...N set. A disconnect or bounded wait ending after commit never
 * cancels the durable intent.
 */
export async function purgeImages(
  request: ImagePurgeRequestDto,
  options: PurgeOptions = {}
): Promise<ImagePurgeResponseDto> {
  const plan = await withTrashMembershipLock((client) => withTransactionOnClient(
    client,
    (transaction) => queueTrashPurge(transaction, request)
  ));
  return waitForPurgeTargets(plan, options.signal);
}

async function readPurgeJobBatch(jobId: string) {
  return (await pool.query(
    `SELECT id
       FROM metadata
      WHERE status='deleted'
        AND purge_job_id=$1
      ORDER BY deleted_at ASC, id ASC
      LIMIT $2`,
    [jobId, appConfig.trashBatchSize]
  )).rows as Array<{ id: string }>;
}

async function readCurrentPurgeOwner(id: string) {
  return (await pool.query(
    `SELECT status, purge_job_id
       FROM metadata
      WHERE id=$1`,
    [id]
  )).rows[0] as {
    status: string;
    purge_job_id: string | null;
  } | undefined;
}

async function purgeJobImage(
  imageId: string,
  jobId: string,
  scheduleSignal: AbortSignal
): Promise<PurgeRow | null> {
  const purgeWhileLocked = () => withImageStorageMutationLock(
    imageId,
    async (lockSignal) => {
      const admissionSignal = AbortSignal.any([scheduleSignal, lockSignal]);
      admissionSignal.throwIfAborted();
      const row = (await pool.query(
        `SELECT ${purgeReturnColumns}
           FROM metadata
          WHERE id=$1
            AND status='deleted'
            AND purge_job_id=$2`,
        [imageId, jobId]
      )).rows[0] as PurgeRow | undefined;
      admissionSignal.throwIfAborted();
      if (!row) return null;

      const thumb = thumbnailRef(row);
      const removals = await removeStorageObjectsAndConfirm([
        {
          prefix: thumb.prefix,
          key: thumb.key,
          storageSlug: row.storage_slug
        },
        {
          prefix: "full",
          key: row.object_key,
          storageSlug: row.storage_slug
        }
      ], { signal: lockSignal }, admissionSignal);
      // Physical deletion is irreversible. Once the driver starts, finish the
      // PostgreSQL side under the image lock even if the job deadline fires.
      lockSignal.throwIfAborted();
      assertStorageRemovalResults(
        removals,
        "无法确认回收站图片的全部存储对象已删除"
      );
      lockSignal.throwIfAborted();

      const deleted = await pool.query(
        `DELETE FROM metadata
          WHERE id=$1
            AND status='deleted'
            AND purge_job_id=$2
            AND storage_slug=$3
            AND object_key=$4
          RETURNING id`,
        [row.id, jobId, row.storage_slug, row.object_key]
      );
      lockSignal.throwIfAborted();
      return deleted.rowCount ? row : null;
    }
  );
  return runWithAdvisoryLockAcquisitionSignal(
    scheduleSignal,
    purgeWhileLocked
  );
}

async function processPurgeJobImage(
  imageId: string,
  jobId: string,
  signal: AbortSignal
): Promise<PurgeItemOutcome> {
  try {
    signal.throwIfAborted();
    const deleted = await purgeJobImage(imageId, jobId, signal);
    if (deleted) return "deleted";
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const current = await readCurrentPurgeOwner(imageId);
    if (!current) return "deleted";
    logger.error("trash_purge_image_failed", {
      image_id: imageId,
      job_id: jobId,
      error: errorMessage(error)
    });
    return current.status === "deleted" && current.purge_job_id === jobId
      ? "failed"
      : "ignored";
  }

  const current = await readCurrentPurgeOwner(imageId);
  if (!current) return "deleted";
  if (current.status === "deleted" && current.purge_job_id === jobId) {
    logger.error("trash_purge_image_ownership_unchanged", {
      image_id: imageId,
      job_id: jobId
    });
    return "failed";
  }
  return "ignored";
}

async function countPurgeJobImages(jobId: string) {
  const row = (await pool.query(
    `SELECT count(*)::int AS count
       FROM metadata
      WHERE status='deleted' AND purge_job_id=$1`,
    [jobId]
  )).rows[0] as { count?: unknown } | undefined;
  return numberField(row?.count, "remaining purge job image count");
}

export async function processTrashPurgeJobBatch(
  jobId: string,
  signal: AbortSignal
) {
  const batch = await readPurgeJobBatch(jobId);
  let deleted = 0;
  let failed = 0;
  let processingError: unknown;
  let processingFailed = false;
  try {
    for (const row of batch) {
      signal.throwIfAborted();
      const outcome = await processPurgeJobImage(row.id, jobId, signal);
      if (outcome === "deleted") deleted += 1;
      else if (outcome === "failed") failed += 1;
    }
  } catch (error) {
    processingError = error;
    processingFailed = true;
  }

  let invalidationError: unknown;
  let invalidationFailed = false;
  try {
    // An empty retry may be the recovery pass after every metadata row was
    // deleted but the previous cache invalidation failed. Repeat the idempotent
    // invalidation before allowing that durable task to settle successfully.
    if (deleted || batch.length === 0) {
      await invalidateEntityCountCaches(["tag"]);
    }
  } catch (error) {
    invalidationError = error;
    invalidationFailed = true;
  }
  if (processingFailed && invalidationFailed) {
    throw new AggregateError(
      [processingError, invalidationError],
      "Trash purge batch failed during processing and cache invalidation"
    );
  }
  if (processingFailed) throw processingError;
  if (invalidationFailed) throw invalidationError;
  return {
    processed: batch.length,
    deleted,
    failed,
    remaining: await countPurgeJobImages(jobId)
  };
}
