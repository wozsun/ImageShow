import type { PoolClient } from "pg";
import { pool } from "../core/database-pools.ts";
import { enqueueRerunnableJob } from "../jobs/repository.ts";
import type {
  CapturedMoveCleanupObject,
  MoveCleanupJobPayload
} from "./move-cleanup-types.ts";

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
  objects: readonly CapturedMoveCleanupObject[]
) {
  const cleanupKey = objects
    .map((object) => `${object.backend}:${object.prefix}:${object.key}`)
    .join("|");
  return `move.cleanup:${imageId}:${cleanupKey}`;
}

export async function enqueueMoveCleanupJob(
  imageId: string,
  objects: readonly CapturedMoveCleanupObject[],
  reason: string,
  client?: PoolClient
) {
  if (!objects.length) return;
  const normalizedObjects = normalizedCleanupObjects(objects);
  const payload: MoveCleanupJobPayload = {
    objects: normalizedObjects,
    reason,
    retain_exhausted: true
  };
  await enqueueRerunnableJob(
    "move.cleanup",
    imageId,
    payload,
    cleanupIdempotencyKey(imageId, normalizedObjects),
    client
  );
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
  job_id: string;
  target_id: string;
  backend: string;
  prefix: "media" | "thumbs";
  key: string;
  namespace_identity: string;
  thumbnail_repair_sha256: string | null;
  thumbnail_repair_size: number | null;
};

/** Unresolved rows are deletion leases for the exact physical object. */
export async function listUnresolvedMoveCleanupReferences(
  prefix: "media" | "thumbs",
  key: string
): Promise<UnresolvedMoveCleanupReference[]> {
  const rows = (await pool.query(
    `WITH unresolved AS (
       SELECT id AS job_id,
              target_id,
              CASE
                WHEN jsonb_typeof(payload->'objects')='array'
                  THEN payload->'objects'
                ELSE '[]'::jsonb
              END AS objects
         FROM background_job
        WHERE type='move.cleanup'
          AND status IN ('pending', 'running', 'failed')
     ), cleanup_references AS (
        SELECT unresolved.job_id,
               unresolved.target_id,
              NULLIF(object->>'backend', '') AS backend,
              object->>'prefix' AS prefix,
              object->>'key' AS key,
              NULLIF(object->>'namespace_identity', '') AS namespace_identity,
              NULLIF(object->'thumbnail_repair'->>'expected_sha256', '')
                AS thumbnail_repair_sha256,
              CASE
                WHEN object->'thumbnail_repair'->>'expected_size' ~ '^[0-9]+$'
                  THEN (object->'thumbnail_repair'->>'expected_size')::bigint
                ELSE NULL
              END AS thumbnail_repair_size
         FROM unresolved
         CROSS JOIN LATERAL jsonb_array_elements(objects) AS object
     )
      SELECT DISTINCT job_id, target_id, backend, prefix, key, namespace_identity,
            thumbnail_repair_sha256, thumbnail_repair_size
       FROM cleanup_references
      WHERE backend IS NOT NULL
        AND namespace_identity IS NOT NULL
        AND prefix=$1
        AND key=$2`,
    [prefix, key]
  )).rows;
  return rows.map((row) => ({
    job_id: String(row.job_id),
    target_id: String(row.target_id),
    backend: String(row.backend),
    prefix: row.prefix as "media" | "thumbs",
    key: String(row.key),
    namespace_identity: String(row.namespace_identity),
    thumbnail_repair_sha256: row.thumbnail_repair_sha256 == null
      ? null
      : String(row.thumbnail_repair_sha256),
    thumbnail_repair_size: row.thumbnail_repair_size == null
      ? null
      : Number(row.thumbnail_repair_size)
  }));
}

/** Rebuild the single-process serving projection from PostgreSQL truth. */
export async function listUnresolvedThumbnailRepairKeys(): Promise<Array<{
  imageId: string;
  key: string;
}>> {
  const rows = (await pool.query(
    `WITH unresolved AS (
       SELECT target_id,
              CASE
                WHEN jsonb_typeof(payload->'objects')='array'
                  THEN payload->'objects'
                ELSE '[]'::jsonb
              END AS objects
        FROM background_job
       WHERE type='move.cleanup'
          AND status IN ('pending', 'running', 'failed')
     )
     SELECT DISTINCT unresolved.target_id,
            object->>'key' AS key
       FROM unresolved
       CROSS JOIN LATERAL jsonb_array_elements(objects) AS object
      WHERE object->>'prefix'='thumbs'
        AND jsonb_typeof(object->'thumbnail_repair')='object'
        AND NULLIF(object->>'key', '') IS NOT NULL`
  )).rows;
  return rows.map((row) => ({
    imageId: String(row.target_id),
    key: String(row.key)
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
