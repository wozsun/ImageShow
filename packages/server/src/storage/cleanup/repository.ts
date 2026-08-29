import type { PoolClient } from "pg";
import { pool } from "../../core/database/pools.ts";
import { enqueueRerunnableJobs } from "../../jobs/repository.ts";
import type {
  CapturedMoveCleanupObject,
  MoveCleanupJobPayload
} from "./types.ts";

function normalizedCleanupObjects(
  objects: readonly CapturedMoveCleanupObject[]
) {
  return [...new Map(
    objects.map((object) => [
      `${object.backend}:${object.prefix}:${object.key}`,
      object
    ])
  ).values()].sort((left, right) => (
    `${left.backend}:${left.prefix}:${left.key}`
      .localeCompare(`${right.backend}:${right.prefix}:${right.key}`)
  ));
}

function cleanupIdempotencyKey(
  imageId: string,
  objects: readonly CapturedMoveCleanupObject[],
  guardToken?: string
) {
  const cleanupKey = objects
    .map((object) => `${object.backend}:${object.prefix}:${object.key}`)
    .join("|");
  const guardScope = guardToken ? `:guard:${guardToken}` : "";
  return `move.cleanup:${imageId}:${cleanupKey}${guardScope}`;
}

export async function enqueueMoveCleanupJob(
  imageId: string,
  objects: readonly CapturedMoveCleanupObject[],
  reason: string,
  options: Readonly<{
    client?: PoolClient;
    guardToken?: string;
    confirmAbsentAfter?: Date;
  }> = {}
) {
  await enqueueMoveCleanupJobs([{
    imageId,
    objects,
    reason,
    guardToken: options.guardToken,
    confirmAbsentAfter: options.confirmAbsentAfter
  }], options.client);
}

/**
 * Keep one pre-copy Ingestion guard authoritative while an S3 request may
 * still publish its deterministic target. The guard is created before the
 * transfer starts; this update therefore changes only its absence-confirmation
 * window and never races by replacing the immutable object list.
 */
export async function setIngestionCandidateGuardConfirmationDeadline(
  imageId: string,
  guardToken: string,
  confirmAbsentAfter: Date | null
) {
  const deadline = confirmAbsentAfter?.toISOString() ?? null;
  const result = await pool.query(
    `UPDATE background_job AS job
        SET payload=CASE
              WHEN $3::text IS NULL
                THEN job.payload - 'confirm_absent_after'
              WHEN NULLIF(job.payload->>'confirm_absent_after', '') IS NOT NULL
               AND (job.payload->>'confirm_absent_after')::timestamptz
                     > $3::timestamptz
                THEN job.payload
              ELSE jsonb_set(
                job.payload,
                '{confirm_absent_after}',
                to_jsonb($3::text),
                true
              )
            END,
            updated_at=now()
      WHERE job.type='move.cleanup'
        AND job.target_id=$1
        AND job.payload->>'reason'='ingestion_commit_candidate_guard'
        AND job.payload->>'guard_token'=$2
        AND job.status IN ('pending', 'running', 'failed')`,
    [imageId, guardToken, deadline]
  );
  if (result.rowCount !== 1) {
    throw new Error("Ingestion candidate cleanup guard is no longer unresolved");
  }
}

/** Re-read mutable guard timing after its handler acquires the image lock. */
export async function readRunningMoveCleanupJobPayload(
  jobId: string,
  executionToken: string
): Promise<Record<string, unknown> | null> {
  const row = (await pool.query(
    `SELECT payload
       FROM background_job
      WHERE id=$1
        AND type='move.cleanup'
        AND status='running'
        AND execution_token=$2`,
    [jobId, executionToken]
  )).rows[0] as { payload: Record<string, unknown> } | undefined;
  return row?.payload ?? null;
}

type MoveCleanupJobInput = Readonly<{
  imageId: string;
  objects: readonly CapturedMoveCleanupObject[];
  reason: string;
  guardToken?: string;
  confirmAbsentAfter?: Date;
}>;

async function enqueueMoveCleanupJobs(
  jobs: readonly MoveCleanupJobInput[],
  client?: PoolClient
) {
  const normalized = jobs.flatMap((job) => {
    const objects = normalizedCleanupObjects(job.objects);
    if (!objects.length) return [];
    const payload: MoveCleanupJobPayload = {
      objects,
      reason: job.reason,
      ...(job.guardToken ? { guard_token: job.guardToken } : {}),
      ...(job.confirmAbsentAfter
        ? { confirm_absent_after: job.confirmAbsentAfter.toISOString() }
        : {}),
      retain_exhausted: true
    };
    return [{
      type: "move.cleanup" as const,
      targetId: job.imageId,
      payload,
      idempotencyKey: cleanupIdempotencyKey(
        job.imageId,
        objects,
        job.guardToken
      )
    }];
  });
  await enqueueRerunnableJobs(normalized, client);
}

export type MoveCleanupJobCount = {
  storage_slug: string;
  cleanup_job_count: number;
  failed_cleanup_job_count: number;
  exhausted_cleanup_job_count: number;
};

async function unresolvedMoveCleanupJobCounts(
  storageSlug: string | null
): Promise<MoveCleanupJobCount[]> {
  const rows = (await pool.query(
    `WITH unresolved AS (
       SELECT id, payload, status, next_retry_at
         FROM background_job
        WHERE type='move.cleanup'
          AND status IN ('pending', 'running', 'failed')
     ), cleanup_references AS (
       SELECT unresolved.id,
              unresolved.status,
              unresolved.next_retry_at,
              reference.backend
         FROM unresolved
         CROSS JOIN LATERAL (
           SELECT NULLIF(object->>'backend', '') AS backend
             FROM jsonb_array_elements(
               CASE
                 WHEN jsonb_typeof(unresolved.payload->'objects')='array'
                   THEN unresolved.payload->'objects'
                 ELSE '[]'::jsonb
               END
             ) AS object
         ) AS reference
        WHERE reference.backend IS NOT NULL
          AND ($1::text IS NULL OR reference.backend=$1)
     )
     SELECT backend AS storage_slug,
            count(DISTINCT id)::int AS cleanup_job_count,
            count(DISTINCT id) FILTER (
              WHERE status='failed'
            )::int AS failed_cleanup_job_count,
            count(DISTINCT id) FILTER (
              WHERE status='failed' AND next_retry_at IS NULL
            )::int AS exhausted_cleanup_job_count
       FROM cleanup_references
      GROUP BY backend`,
    [storageSlug]
  )).rows;
  return rows.map((row) => ({
    storage_slug: String(row.storage_slug),
    cleanup_job_count: Number(row.cleanup_job_count ?? 0),
    failed_cleanup_job_count: Number(row.failed_cleanup_job_count ?? 0),
    exhausted_cleanup_job_count: Number(
      row.exhausted_cleanup_job_count ?? 0
    )
  }));
}

/** Pending, running and every failed cleanup remain physical references. */
export function listUnresolvedMoveCleanupJobCounts() {
  return unresolvedMoveCleanupJobCounts(null);
}

export async function countUnresolvedMoveCleanupJobs(storageSlug: string) {
  return (await unresolvedMoveCleanupJobCounts(storageSlug))[0]
    ?.cleanup_job_count ?? 0;
}

export type UnresolvedMoveCleanupReference = {
  backend: string;
  namespace_identity: string;
  target_id: string;
  reason: string;
  guard_token: string;
};

/** Unresolved rows are deletion leases for the exact physical object. */
export async function listUnresolvedMoveCleanupReferences(
  prefix: "media" | "thumbs",
  key: string
): Promise<UnresolvedMoveCleanupReference[]> {
  const rows = (await pool.query(
    `WITH unresolved AS (
       SELECT target_id,
              NULLIF(payload->>'reason', '') AS reason,
              NULLIF(payload->>'guard_token', '') AS guard_token,
              CASE
                WHEN jsonb_typeof(payload->'objects')='array'
                  THEN payload->'objects'
                ELSE '[]'::jsonb
              END AS objects
         FROM background_job
        WHERE type='move.cleanup'
          AND status IN ('pending', 'running', 'failed')
     ), cleanup_references AS (
        SELECT unresolved.target_id,
              unresolved.reason,
              unresolved.guard_token,
              NULLIF(object->>'backend', '') AS backend,
              object->>'prefix' AS prefix,
              object->>'key' AS key,
              NULLIF(object->>'namespace_identity', '') AS namespace_identity
         FROM unresolved
         CROSS JOIN LATERAL jsonb_array_elements(objects) AS object
     )
      SELECT DISTINCT backend, namespace_identity, target_id, reason,
                      guard_token
       FROM cleanup_references
      WHERE backend IS NOT NULL
        AND namespace_identity IS NOT NULL
        AND prefix=$1
        AND key=$2`,
    [prefix, key]
  )).rows;
  return rows.map((row) => ({
    backend: String(row.backend),
    namespace_identity: String(row.namespace_identity),
    target_id: String(row.target_id),
    reason: String(row.reason ?? ""),
    guard_token: String(row.guard_token ?? "")
  }));
}

/** Reset only permanently exhausted cleanup work that references one backend. */
export async function retryExhaustedMoveCleanupJobs(storageSlug: string) {
  await pool.query(
    `UPDATE background_job AS job
     SET status='pending',
         payload=job.payload - 'rerun_requested',
         error='',
         retry_count=0,
         next_retry_at=NULL,
         execution_token=NULL,
         created_at=now(),
         updated_at=now()
     WHERE job.type='move.cleanup'
       AND job.status='failed'
       AND job.next_retry_at IS NULL
       AND EXISTS (
         SELECT 1
           FROM (
             SELECT NULLIF(object->>'backend', '') AS backend
               FROM jsonb_array_elements(
                 CASE
                   WHEN jsonb_typeof(job.payload->'objects')='array'
                     THEN job.payload->'objects'
                   ELSE '[]'::jsonb
                 END
               ) AS object
              WHERE NULLIF(object->>'namespace_identity', '') IS NOT NULL
           ) AS reference
          WHERE reference.backend=$1
       )`,
    [storageSlug]
  );
}
