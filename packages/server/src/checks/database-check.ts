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
import { imageHasTrashPurgeJobSql } from "../images/trash-purge-state.ts";
import { readAdminPostgresqlStatus } from "./lightweight-status.ts";

const trashInspectionSampleLimit = 100;

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
              count(*) FILTER (WHERE NOT ${imageHasTrashPurgeJobSql})::int AS unqueued_count,
              count(*) FILTER (WHERE ${imageHasTrashPurgeJobSql})::int AS purge_pending_count
         FROM metadata WHERE status='deleted'`
    )).rows[0] as Record<string, unknown>;

    const stateSql = `CASE
      WHEN status='pending' THEN 'pending'
      WHEN status='running' THEN 'running'
      WHEN next_retry_at IS NOT NULL THEN 'retrying'
      ELSE 'exhausted'
    END`;
    const jobCounts = (await client.query(
      `SELECT ${stateSql} AS state, count(*)::int AS count
         FROM background_job
        WHERE type='trash.purge' AND status IN ('pending', 'running', 'failed')
        GROUP BY state`
    )).rows as Array<{ state: TrashPurgeJobStateDto; count: number }>;
    const jobs = (await client.query(
      `SELECT id, target_id, ${stateSql} AS state, retry_count,
              next_retry_at::text AS next_retry_at,
              updated_at::text AS updated_at, left(error, 2000) AS error
         FROM background_job
        WHERE type='trash.purge' AND status IN ('pending', 'running', 'failed')
        ORDER BY updated_at DESC, id
        LIMIT $1`,
      [appConfig.backgroundJob.sampleLimit]
    )).rows as AdminTrashPurgeJobDto[];

    const issues = (await client.query(
      `WITH anomalies AS (
         SELECT 'succeeded_target_remaining'::text AS kind, job.id
           FROM background_job job
           JOIN metadata ON metadata.id::text=job.target_id
          WHERE job.type='trash.purge' AND job.status='succeeded'
            AND metadata.status='deleted'
         UNION ALL
         SELECT 'target_not_deleted', job.id
           FROM background_job job
           JOIN metadata ON metadata.id::text=job.target_id
          WHERE job.type='trash.purge' AND metadata.status<>'deleted'
         UNION ALL
         SELECT 'stalled_job', id FROM background_job
          WHERE type='trash.purge' AND status='running'
            AND updated_at < now() - ($2 || ' seconds')::interval
       ), ranked AS (
         SELECT kind, id, row_number() OVER (PARTITION BY kind ORDER BY id) AS position
           FROM anomalies
       )
       SELECT kind, count(*)::int AS count,
              array_agg(id::text ORDER BY id) FILTER (WHERE position <= $1) AS sample_ids
         FROM ranked GROUP BY kind ORDER BY kind`,
      [appConfig.backgroundJob.sampleLimit, appConfig.backgroundJob.taskTimeoutSeconds]
    )).rows as AdminTrashCheckIssueDto[];
    const candidates = (await client.query(
      `SELECT id, object_key, deleted_at::text AS deleted_at,
              ${imageHasTrashPurgeJobSql} AS purge_pending
         FROM metadata WHERE status='deleted'
        ORDER BY deleted_at, id LIMIT $1`,
      [trashInspectionSampleLimit]
    )).rows as AdminTrashCheckDto["candidates"];
    const normalizedJobCounts: AdminTrashCheckDto["job_counts"] = {
      pending: 0, running: 0, retrying: 0, exhausted: 0
    };
    for (const row of jobCounts) normalizedJobCounts[row.state] = Number(row.count);
    return {
      deleted_count: Number(counts.deleted_count ?? 0),
      unqueued_count: Number(counts.unqueued_count ?? 0),
      purge_pending_count: Number(counts.purge_pending_count ?? 0),
      job_counts: normalizedJobCounts,
      jobs: jobs.map((job) => ({ ...job, retry_count: Number(job.retry_count) })),
      issues,
      candidates
    } satisfies AdminTrashCheckDto;
  });
}
