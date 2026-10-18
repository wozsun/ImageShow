import { randomUUIDv7 } from "node:crypto";
import { STORAGE_PREFIXES } from "../../storage/objects/keys.ts";
import type {
  ImagePurgeRequestDto,
  ImagePurgeResponseDto
} from "@imageshow/shared/browser";
import type { PoolClient } from "pg";
import { imageObjectKey } from "../../storage/objects/image-paths.ts";
import { pool } from "../../core/database/pools.ts";
import { withTransactionOnClient } from "../../core/database/transactions.ts";
import { withImageStorageMutationLock } from "../../storage/maintenance-lock.ts";
import {
  assertStorageRemovalResults,
  removeStorageObjectsAndConfirm
} from "../../storage/objects/access.ts";
import { invalidateEntityCountCaches } from "../../vocab/cache.ts";
import { withTrashMembershipLock } from "./membership-lock.ts";
import { imageHasTrashPurgeJobSql } from "./purge-state.ts";
import type { BackgroundJob } from "../../jobs/types.ts";
import { wakeBackgroundJobs } from "../../jobs/wake.ts";
import { notifyTrashPurgeProgress } from "./purge-progress.ts";

type PurgeRow = {
  id: string;
  storage_slug: string;
  status: string;
};

type QueuePlan = Pick<
  ImagePurgeResponseDto,
  "requested" | "queued" | "already_queued" | "ignored"
> & {
  queueableIds: string[];
};

const purgeReturnColumns = [
  "metadata.id",
  "metadata.storage_slug",
  "metadata.status"
].join(", ");

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
  const row = (
    await client.query(
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
                  AND NOT ${imageHasTrashPurgeJobSql}
              ),
              '{}'::uuid[]
            ) AS queueable_ids
       FROM unnest($1::uuid[]) WITH ORDINALITY AS requested(id, ordinality)
       LEFT JOIN metadata ON metadata.id=requested.id`,
      [ids]
    )
  ).rows[0] as Record<string, unknown> | undefined;
  const requested = numberField(row?.requested, "selected purge count");
  const alreadyQueued = numberField(
    row?.already_queued,
    "selected already-queued purge count"
  );
  const queueable = numberField(row?.queueable, "selected queueable count");
  const queueableIds = uuidArrayField(
    row?.queueable_ids,
    "selected queueable purge targets"
  );
  if (queueableIds.length !== queueable) {
    throw new Error("PostgreSQL returned inconsistent selected purge targets");
  }
  return {
    requested,
    queued: 0,
    already_queued: alreadyQueued,
    ignored: requested - alreadyQueued - queueable,
    queueableIds
  };
}

async function allQueueCounts(client: PoolClient): Promise<QueuePlan> {
  const row = (
    await client.query(
      `SELECT count(*)::int AS requested,
            count(*) FILTER (
              WHERE ${imageHasTrashPurgeJobSql}
            )::int AS already_queued,
            count(*) FILTER (
              WHERE NOT ${imageHasTrashPurgeJobSql}
            )::int AS queueable,
            COALESCE(
              array_agg(id ORDER BY deleted_at, id) FILTER (
                WHERE NOT ${imageHasTrashPurgeJobSql}
              ),
              '{}'::uuid[]
            ) AS queueable_ids
       FROM metadata
      WHERE status='deleted'`
    )
  ).rows[0] as Record<string, unknown> | undefined;
  const requested = numberField(row?.requested, "trash purge count");
  const alreadyQueued = numberField(
    row?.already_queued,
    "already-queued trash purge count"
  );
  const queueable = numberField(row?.queueable, "queueable trash purge count");
  const queueableIds = uuidArrayField(
    row?.queueable_ids,
    "queueable trash purge targets"
  );
  if (queueableIds.length !== queueable) {
    throw new Error("PostgreSQL returned inconsistent trash purge targets");
  }
  return {
    requested,
    queued: 0,
    already_queued: alreadyQueued,
    ignored: requested - alreadyQueued - queueable,
    queueableIds
  };
}

async function queueTrashPurge(
  client: PoolClient,
  request: ImagePurgeRequestDto
): Promise<QueuePlan> {
  const plan =
    request.scope === "all"
      ? await allQueueCounts(client)
      : await selectedQueueCounts(client, request.ids);
  if (!plan.queueableIds.length) return plan;

  const jobs = plan.queueableIds.map((imageId) => ({
    id: randomUUIDv7(),
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

/**
 * Persist the complete user-confirmed deletion intent and return its receipt.
 * The sole background owner deletes the images; clients follow the global
 * progress stream, and a disconnect never cancels the durable intent.
 */
export async function purgeImages(
  request: ImagePurgeRequestDto
): Promise<ImagePurgeResponseDto> {
  const plan = await withTrashMembershipLock((client) =>
    withTransactionOnClient(
      client,
      (transaction) => queueTrashPurge(transaction, request)
    )
  );
  if (plan.queued) {
    wakeBackgroundJobs();
    notifyTrashPurgeProgress();
  }
  return {
    requested: plan.requested,
    queued: plan.queued,
    already_queued: plan.already_queued,
    ignored: plan.ignored
  };
}

async function purgeJobImage(
  job: BackgroundJob,
  scheduleSignal: AbortSignal
) {
  return withImageStorageMutationLock(job.target_id, async (lockSignal) => {
    const admissionSignal = AbortSignal.any([scheduleSignal, lockSignal]);
    admissionSignal.throwIfAborted();
    const row = (
      await pool.query(
        `SELECT ${purgeReturnColumns}
         FROM background_job
         LEFT JOIN metadata ON metadata.id=$2::uuid
        WHERE background_job.id=$1
          AND background_job.type='trash.purge'
          AND background_job.target_id=$2::text
          AND background_job.status='running'
          AND background_job.execution_token=$3`,
        [job.id, job.target_id, job.execution_token]
      )
    ).rows[0] as (Omit<PurgeRow, "id"> & { id: string | null }) | undefined;
    admissionSignal.throwIfAborted();
    if (!row) throw new Error("Trash purge job execution ownership was lost");
    // A previous attempt may have removed the row before cache settlement.
    if (!row.id) return;
    if (row.status !== "deleted") {
      throw new Error("Trash purge target is not in the trash");
    }

    const removals = await removeStorageObjectsAndConfirm(
      STORAGE_PREFIXES.map((prefix) => ({ prefix, key: imageObjectKey(row.id!), storageSlug: row.storage_slug })),
      { signal: lockSignal },
      admissionSignal
    );
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
          AND storage_slug=$2
        RETURNING id`,
      [row.id, row.storage_slug]
    );
    lockSignal.throwIfAborted();
    if (deleted.rowCount !== 1) {
      throw new Error("Trash purge target changed during physical deletion");
    }
  });
}

export async function processTrashPurgeJob(
  job: BackgroundJob,
  signal: AbortSignal
) {
  try {
    await purgeJobImage(job, signal);
  } finally {
    try {
      // A lost DELETE acknowledgement may still remove every association.
      // Empty retries also retire any list retained by a failed invalidation.
      await invalidateEntityCountCaches(["theme", "tag", "author"]);
    } finally {
      notifyTrashPurgeProgress();
    }
  }
}
