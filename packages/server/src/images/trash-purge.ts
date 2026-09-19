import { storageObjectKey } from "@imageshow/shared/browser";
import type {
  ImagePurgeRequestDto,
  ImagePurgeResponseDto
} from "@imageshow/shared/browser";
import { setTimeout as delay } from "node:timers/promises";
import type { PoolClient } from "pg";
import {
  runWithAdvisoryLockAcquisitionSignal
} from "../core/database/advisory-locks.ts";
import { pool } from "../core/database/pools.ts";
import { withTransactionOnClient } from "../core/database/transactions.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import { thumbnailRef } from "../storage/objects/image-paths.ts";
import { withImageStorageMutationLock } from "../storage/maintenance-lock.ts";
import {
  assertStorageRemovalResults,
  removeStorageObjectsAndConfirm
} from "../storage/objects/access.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";
import { withTrashMembershipLock } from "./trash-membership-lock.ts";
import { imageHasTrashPurgeJobSql } from "./trash-purge-state.ts";
import type { BackgroundJob } from "../jobs/types.ts";

type PurgeRow = {
  id: string;
  ext: string;
  storage_slug: string;
  status: string;
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

const purgeReturnColumns = [
  "metadata.id",
  "metadata.ext",
  "metadata.storage_slug",
  "metadata.status"
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
                AND ${imageHasTrashPurgeJobSql}
            )::int AS already_queued,
            count(*) FILTER (
              WHERE metadata.status='deleted'
                AND NOT ${imageHasTrashPurgeJobSql}
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
                  AND NOT ${imageHasTrashPurgeJobSql}
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
              WHERE ${imageHasTrashPurgeJobSql}
            )::int AS already_queued,
            count(*) FILTER (
              WHERE NOT ${imageHasTrashPurgeJobSql}
            )::int AS queueable,
            COALESCE(
              array_agg(id ORDER BY deleted_at, id),
              '{}'::uuid[]
            ) AS target_ids,
            COALESCE(
              array_agg(id ORDER BY deleted_at, id) FILTER (
                WHERE NOT ${imageHasTrashPurgeJobSql}
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

async function queueTrashPurge(
  client: PoolClient,
  request: ImagePurgeRequestDto
): Promise<QueuePlan> {
  const plan = request.scope === "all"
    ? await allQueueCounts(client)
    : await selectedQueueCounts(client, request.ids);
  if (!plan.queueableIds.length) return plan;

  const jobs = plan.queueableIds.map((imageId) => ({
    id: randomUuidV7(),
    target_id: imageId,
    idempotency_key: `trash.purge:${imageId}`
  }));
  const inserted = await client.query(
    `INSERT INTO background_job(id, type, target_id, idempotency_key)
     SELECT id, 'trash.purge', target_id, idempotency_key
       FROM jsonb_to_recordset($1::jsonb)
         AS input(id uuid, target_id text, idempotency_key text)
     RETURNING id`,
    [JSON.stringify(jobs)]
  );
  if (inserted.rowCount !== plan.queueableIds.length) {
    throw new Error("Trash purge intent was not fully persisted");
  }
  return { ...plan, queued: inserted.rowCount };
}

async function readPurgeWaitState(ids: string[]): Promise<PurgeWaitState> {
  if (!ids.length) return { remaining: 0, deferred: 0 };
  const row = (await pool.query(
    `SELECT count(*)::int AS remaining,
            count(*) FILTER (
              WHERE NOT EXISTS (
                SELECT 1 FROM background_job
                 WHERE type='trash.purge'
                   AND target_id=metadata.id::text
                   AND status IN ('pending', 'running')
              )
            )::int AS deferred
       FROM metadata
      WHERE id=ANY($1::uuid[])`,
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

async function purgeJobImage(
  job: BackgroundJob,
  scheduleSignal: AbortSignal
) {
  const purgeWhileLocked = () => withImageStorageMutationLock(
    job.target_id,
    async (lockSignal) => {
      const admissionSignal = AbortSignal.any([scheduleSignal, lockSignal]);
      admissionSignal.throwIfAborted();
      const row = (await pool.query(
        `SELECT ${purgeReturnColumns}
           FROM background_job
           LEFT JOIN metadata ON metadata.id=$2::uuid
          WHERE background_job.id=$1
            AND background_job.type='trash.purge'
            AND background_job.target_id=$2::text
            AND background_job.status='running'
            AND background_job.execution_token=$3`,
        [job.id, job.target_id, job.execution_token]
      )).rows[0] as (Omit<PurgeRow, "id"> & { id: string | null }) | undefined;
      admissionSignal.throwIfAborted();
      if (!row) throw new Error("Trash purge job execution ownership was lost");
      // A previous attempt may have removed the row before cache settlement.
      if (!row.id) return;
      if (row.status !== "deleted") {
        throw new Error("Trash purge target is not in the trash");
      }

      const thumb = thumbnailRef({ id: row.id, storage_slug: row.storage_slug });
      const removals = await removeStorageObjectsAndConfirm([
        { prefix: thumb.prefix, key: thumb.key, storageSlug: row.storage_slug },
        { prefix: "full", key: storageObjectKey(row.id, row.ext), storageSlug: row.storage_slug }
      ], { signal: lockSignal }, admissionSignal);
      // Once physical deletion starts, finish the database side under the
      // image lock even if this execution's deadline or lease expires.
      lockSignal.throwIfAborted();
      assertStorageRemovalResults(
        removals,
        "无法确认回收站图片的全部存储对象已删除"
      );
      const deleted = await pool.query(
        `DELETE FROM metadata
          WHERE id=$1 AND status='deleted'
            AND storage_slug=$2 AND ext=$3
          RETURNING id`,
        [row.id, row.storage_slug, row.ext]
      );
      lockSignal.throwIfAborted();
      if (deleted.rowCount !== 1) {
        throw new Error("Trash purge target changed during physical deletion");
      }
    }
  );
  return runWithAdvisoryLockAcquisitionSignal(scheduleSignal, purgeWhileLocked);
}

export async function processTrashPurgeJob(
  job: BackgroundJob,
  signal: AbortSignal
) {
  await purgeJobImage(job, signal);
  // Repeat on an empty retry so a failed invalidation cannot lose its owner.
  await invalidateEntityCountCaches(["tag"]);
}
