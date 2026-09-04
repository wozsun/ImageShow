import { appConfig } from "@imageshow/shared";
import type {
  AdminTrashCheckDto,
  AdminTrashCheckIssueDto,
  AdminTrashPurgeJobDto,
  TrashPurgeJobStateDto
} from "@imageshow/shared/browser";
import { pool } from "../core/database/pools.ts";
import {
  withReadOnlyRepeatableReadTransaction
} from "../core/database/transactions.ts";
import { getReadyImageCacheCoordinatorStatus } from "../images/ready-cache/coordinator.ts";
import {
  getPublicPgFallbackAdmissionSnapshot
} from "../core/database/public-admission.ts";
import { readAdminPostgresqlStatus } from "./lightweight-status.ts";

export async function checkDatabase() {
  const status = await readAdminPostgresqlStatus();
  const operations = (await pool.query(
    `SELECT id,type,target_id,status,retry_count,error,updated_at
       FROM background_job
      WHERE status IN ('pending','running','failed')
      ORDER BY updated_at DESC
      LIMIT $1`,
    [appConfig.backgroundJob.sampleLimit]
  )).rows;
  const cache = getReadyImageCacheCoordinatorStatus();
  const cacheCount = cache.meta?.itemCount ?? null;
  return {
    status,
    ready_count: status.ready_images,
    ready_cache_count: cacheCount,
    ready_cache_readable: cache.readable,
    ready_cache_state: cache.meta?.state ?? cache.reason,
    ready_cache_mismatch: cacheCount !== status.ready_images,
    public_pg_fallback: getPublicPgFallbackAdmissionSnapshot(),
    operations
  };
}

export async function checkTrash() {
  return withReadOnlyRepeatableReadTransaction(async (client) => {
    const counts = (await client.query(
      `SELECT count(*)::int AS deleted_count,
              count(*) FILTER (
                WHERE purge_job_id IS NULL
              )::int AS unqueued_count,
              count(*) FILTER (
                WHERE purge_job_id IS NOT NULL
              )::int AS purge_pending_count
         FROM metadata
        WHERE status='deleted'`
    )).rows[0] as Record<string, unknown>;

    const jobCounts = (await client.query(
      `SELECT CASE
                WHEN background_job.status='pending' THEN 'pending'
                WHEN background_job.status='running' THEN 'running'
                WHEN background_job.next_retry_at IS NOT NULL THEN 'retrying'
                ELSE 'exhausted'
              END AS state,
              count(DISTINCT background_job.id)::int AS count
         FROM background_job
         JOIN metadata
           ON metadata.purge_job_id=background_job.id
          AND metadata.status='deleted'
        WHERE background_job.type='trash.purge'
          AND background_job.status IN ('pending', 'running', 'failed')
        GROUP BY state`
    )).rows as Array<{ state: TrashPurgeJobStateDto; count: number }>;

    const jobs = (await client.query(
      `SELECT background_job.id,
              CASE
                WHEN background_job.status='pending' THEN 'pending'
                WHEN background_job.status='running' THEN 'running'
                WHEN background_job.next_retry_at IS NOT NULL THEN 'retrying'
                ELSE 'exhausted'
              END AS state,
              count(metadata.id)::int AS image_count,
              background_job.retry_count,
              background_job.next_retry_at::text AS next_retry_at,
              background_job.updated_at::text AS updated_at,
              left(background_job.error, 2000) AS error
         FROM background_job
         JOIN metadata
           ON metadata.purge_job_id=background_job.id
          AND metadata.status='deleted'
        WHERE background_job.type='trash.purge'
          AND background_job.status IN ('pending', 'running', 'failed')
        GROUP BY background_job.id
        ORDER BY background_job.updated_at DESC, background_job.id
        LIMIT $1`,
      [appConfig.backgroundJob.sampleLimit]
    )).rows as AdminTrashPurgeJobDto[];

    const anomalies = (await client.query(
      `SELECT
         (SELECT count(*)::int
            FROM metadata
           WHERE status='deleted'
             AND purge_job_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM background_job
                WHERE background_job.id=metadata.purge_job_id
             )) AS missing_count,
         ARRAY(SELECT id::text
                 FROM metadata
                WHERE status='deleted'
                  AND purge_job_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM background_job
                     WHERE background_job.id=metadata.purge_job_id
                  )
                ORDER BY deleted_at, id
                LIMIT $1)::text[] AS missing_samples,
         (SELECT count(*)::int
            FROM metadata
            JOIN background_job ON background_job.id=metadata.purge_job_id
           WHERE metadata.status='deleted'
             AND background_job.type<>'trash.purge') AS wrong_type_count,
         ARRAY(SELECT metadata.id::text
                 FROM metadata
                 JOIN background_job
                   ON background_job.id=metadata.purge_job_id
                WHERE metadata.status='deleted'
                  AND background_job.type<>'trash.purge'
                ORDER BY metadata.deleted_at, metadata.id
                LIMIT $1)::text[] AS wrong_type_samples,
         (SELECT count(*)::int
            FROM metadata
            JOIN background_job ON background_job.id=metadata.purge_job_id
           WHERE metadata.status='deleted'
             AND background_job.type='trash.purge'
             AND background_job.status='succeeded') AS succeeded_count,
         ARRAY(SELECT metadata.id::text
                 FROM metadata
                JOIN background_job
                   ON background_job.id=metadata.purge_job_id
                WHERE metadata.status='deleted'
                  AND background_job.type='trash.purge'
                  AND background_job.status='succeeded'
                ORDER BY metadata.deleted_at, metadata.id
                LIMIT $1)::text[] AS succeeded_samples,
         (SELECT count(DISTINCT background_job.id)::int
            FROM background_job
            JOIN metadata ON metadata.purge_job_id=background_job.id
           WHERE metadata.status='deleted'
             AND background_job.type='trash.purge'
             AND background_job.status='running'
             AND background_job.updated_at
                 < now() - ($2 || ' seconds')::interval) AS stalled_count,
         ARRAY(SELECT DISTINCT background_job.id::text
                 FROM background_job
                 JOIN metadata ON metadata.purge_job_id=background_job.id
                WHERE metadata.status='deleted'
                  AND background_job.type='trash.purge'
                  AND background_job.status='running'
                  AND background_job.updated_at
                      < now() - ($2 || ' seconds')::interval
                ORDER BY background_job.id::text
                LIMIT $1)::text[] AS stalled_samples`,
      [
        appConfig.backgroundJob.sampleLimit,
        appConfig.backgroundJob.taskTimeoutSeconds
      ]
    )).rows[0] as Record<string, unknown>;

    const candidates = (await client.query(
      `SELECT id,
              object_key,
              deleted_at::text AS deleted_at,
              (purge_job_id IS NOT NULL) AS purge_pending
         FROM metadata
        WHERE status='deleted'
        ORDER BY deleted_at ASC, id ASC
        LIMIT $1`,
      [appConfig.trashBatchSize]
    )).rows as AdminTrashCheckDto["candidates"];

    const issues: AdminTrashCheckIssueDto[] = [];
    const addIssue = (
      kind: AdminTrashCheckIssueDto["kind"],
      countValue: unknown,
      sampleValue: unknown
    ) => {
      const count = Number(countValue ?? 0);
      if (!count) return;
      issues.push({
        kind,
        count,
        sample_ids: Array.isArray(sampleValue)
          ? sampleValue.map(String)
          : []
      });
    };
    addIssue(
      "missing_job_reference",
      anomalies.missing_count,
      anomalies.missing_samples
    );
    addIssue(
      "wrong_job_type",
      anomalies.wrong_type_count,
      anomalies.wrong_type_samples
    );
    addIssue(
      "succeeded_job_reference",
      anomalies.succeeded_count,
      anomalies.succeeded_samples
    );
    addIssue(
      "stalled_job",
      anomalies.stalled_count,
      anomalies.stalled_samples
    );
    const normalizedJobCounts: AdminTrashCheckDto["job_counts"] = {
      pending: 0,
      running: 0,
      retrying: 0,
      exhausted: 0
    };
    for (const row of jobCounts) {
      normalizedJobCounts[row.state] = Number(row.count);
    }
    return {
      deleted_count: Number(counts.deleted_count ?? 0),
      unqueued_count: Number(counts.unqueued_count ?? 0),
      purge_pending_count: Number(counts.purge_pending_count ?? 0),
      job_counts: normalizedJobCounts,
      jobs: jobs.map((job) => ({
        ...job,
        image_count: Number(job.image_count),
        retry_count: Number(job.retry_count)
      })),
      issues,
      candidates
    } satisfies AdminTrashCheckDto;
  });
}
