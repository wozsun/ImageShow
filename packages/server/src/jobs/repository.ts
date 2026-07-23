import { appConfig } from "@imageshow/shared";
import type { PoolClient } from "pg";
import { errorMessage } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { logger } from "../core/logger.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import type { BackgroundJob, BackgroundJobType } from "./types.ts";

export type { BackgroundJob, BackgroundJobType } from "./types.ts";

export async function enqueue(
  type: BackgroundJobType,
  targetId = "",
  payload: unknown = {},
  idempotencyKey?: string
) {
  await pool.query(
    `INSERT INTO background_job(id, type, target_id, payload, idempotency_key)
     VALUES($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO UPDATE
     SET type=EXCLUDED.type,
         target_id=EXCLUDED.target_id,
         payload=EXCLUDED.payload,
         status='pending',
         result='{}'::jsonb,
         error='',
         retry_count=0,
         next_retry_at=NULL,
         created_at=now(),
         updated_at=now()
     WHERE background_job.status IN ('succeeded','ignored')
        OR (
          background_job.status='failed'
          AND background_job.next_retry_at IS NULL
        )`,
    [
      randomUuidV7(),
      type,
      targetId,
      JSON.stringify(payload),
      idempotencyKey ?? null
    ]
  );
}

/**
 * Deterministic work that races with its current handler must survive the
 * running -> succeeded transition. The in-flight payload remains immutable
 * and receives a durable rerun marker. The generic success transition consumes
 * that marker by returning the same row to pending.
 */
export async function enqueueRerunnableJob(
  type: BackgroundJobType,
  targetId: string,
  payload: unknown,
  idempotencyKey: string,
  client?: PoolClient
) {
  const values = [
    randomUuidV7(),
    type,
    targetId,
    JSON.stringify(payload),
    idempotencyKey
  ];
  const query = `INSERT INTO background_job(
                   id, type, target_id, payload, idempotency_key
                 )
                 VALUES($1, $2, $3, $4::jsonb, $5)
                 ON CONFLICT (idempotency_key)
                   WHERE idempotency_key IS NOT NULL
                 DO UPDATE
                 SET type=CASE
                       WHEN background_job.status='running'
                         THEN background_job.type
                       ELSE EXCLUDED.type
                     END,
                     target_id=CASE
                       WHEN background_job.status='running'
                         THEN background_job.target_id
                       ELSE EXCLUDED.target_id
                     END,
                     payload=CASE
                       WHEN background_job.status='running'
                         THEN jsonb_set(
                           background_job.payload,
                           '{rerun_requested}',
                           'true'::jsonb,
                           true
                         )
                       ELSE EXCLUDED.payload
                     END,
                     status=CASE
                       WHEN background_job.status='running'
                         THEN background_job.status
                       ELSE 'pending'
                     END,
                     result=CASE
                       WHEN background_job.status='running'
                         THEN background_job.result
                       ELSE '{}'::jsonb
                     END,
                     error=CASE
                       WHEN background_job.status='running'
                         THEN background_job.error
                       ELSE ''
                     END,
                     retry_count=CASE
                       WHEN background_job.status='running'
                         THEN background_job.retry_count
                       ELSE 0
                     END,
                     next_retry_at=CASE
                       WHEN background_job.status='running'
                         THEN background_job.next_retry_at
                       ELSE NULL
                     END,
                     created_at=CASE
                       WHEN background_job.status='running'
                         THEN background_job.created_at
                       ELSE now()
                     END,
                     updated_at=CASE
                       WHEN background_job.status='running'
                         THEN background_job.updated_at
                       ELSE now()
                     END
                 WHERE background_job.status='running'
                    OR background_job.status IN ('succeeded', 'ignored')
                    OR (
                      background_job.status='failed'
                      AND background_job.next_retry_at IS NULL
                    )`;
  if (client) await client.query(query, values);
  else await pool.query(query, values);
}

export async function claimBackgroundJob(type: string) {
  const result = await pool.query(
    `UPDATE background_job
     SET status = 'running', updated_at = now()
     WHERE id = (
       SELECT id FROM background_job
       WHERE (
         (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= now()))
         OR (status = 'failed' AND next_retry_at <= now())
       )
         AND type = $1
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, type, target_id, payload, retry_count, created_at`,
    [type]
  );
  return result.rows[0] as BackgroundJob | undefined;
}

export async function markBackgroundJobSucceeded(
  id: string,
  result: unknown = {}
) {
  await pool.query(
    `UPDATE background_job
     SET status=CASE
           WHEN payload->>'rerun_requested'='true' THEN 'pending'
           ELSE 'succeeded'
         END,
         payload=payload - 'rerun_requested',
         result=CASE
           WHEN payload->>'rerun_requested'='true' THEN '{}'::jsonb
           ELSE $2::jsonb
         END,
         error='',
         retry_count=CASE
           WHEN payload->>'rerun_requested'='true' THEN 0
           ELSE retry_count
         END,
         next_retry_at=NULL,
         created_at=CASE
           WHEN payload->>'rerun_requested'='true' THEN now()
           ELSE created_at
         END,
         updated_at=now()
     WHERE id=$1`,
    [id, JSON.stringify(result)]
  );
}

export async function markBackgroundJobIgnored(id: string, reason: string) {
  await pool.query(
    "UPDATE background_job SET status='ignored', error=$2, updated_at=now() WHERE id=$1",
    [id, reason]
  );
}

export async function rescheduleBackgroundJob(
  id: string,
  delayMs: number,
  result: unknown = {}
) {
  await pool.query(
    `UPDATE background_job
     SET status='pending',
         result=$2::jsonb,
         error='',
         next_retry_at=$3,
         updated_at=now()
     WHERE id=$1`,
    [id, JSON.stringify(result), new Date(Date.now() + Math.max(0, delayMs))]
  );
}

export async function markBackgroundJobFailed(
  job: BackgroundJob,
  error: unknown
) {
  const retry = job.retry_count + 1;
  const maxRetries = appConfig.backgroundJob.maxRetries;
  const backoff = appConfig.backgroundJob.retryBackoffSeconds;
  const seconds = backoff[Math.min(retry - 1, backoff.length - 1)];
  const exhausted = retry >= maxRetries;

  logger[exhausted ? "error" : "warn"](
    `task ${job.type} ${
      exhausted ? "gave up" : `will retry (${retry}/${maxRetries})`
    } id=${job.id.slice(0, 8)}: ${errorMessage(error)}`
  );
  await pool.query(
    `UPDATE background_job
     SET status='failed',
         payload=payload - 'rerun_requested',
         retry_count=$2,
         next_retry_at=$3,
         error=$4,
         updated_at=now()
     WHERE id=$1`,
    [
      job.id,
      retry,
      exhausted ? null : new Date(Date.now() + seconds * 1000),
      errorMessage(error)
    ]
  );
}

export async function listRunnableBackgroundJobCounts() {
  return (await pool.query(
    `SELECT type,
            count(*)::int AS n,
            floor(
              extract(epoch FROM (now() - min(created_at))) * 1000
            )::bigint AS oldest_wait_ms
       FROM background_job
     WHERE (
       status='pending' AND (next_retry_at IS NULL OR next_retry_at <= now())
     ) OR (status='failed' AND next_retry_at <= now())
     GROUP BY type`
  )).rows.map((row) => ({
    type: String(row.type),
    n: Number(row.n),
    oldest_wait_ms: Number(row.oldest_wait_ms ?? 0)
  }));
}

export async function recoverStaleBackgroundJobs() {
  await pool.query(
    `UPDATE background_job
     SET status='failed',
         retry_count=retry_count+1,
         next_retry_at=CASE
           WHEN retry_count + 1 >= $2 THEN NULL
           ELSE now()
         END,
         error='Recovered stale running task',
         updated_at=now()
     WHERE status='running'
       AND updated_at < now() - ($1 || ' seconds')::interval`,
    [
      appConfig.backgroundJob.taskTimeoutSeconds,
      appConfig.backgroundJob.maxRetries
    ]
  );
}

export async function cleanupBackgroundJobHistory() {
  const result = await pool.query(
    `WITH deleted AS (
       DELETE FROM background_job
       WHERE id IN (
         SELECT id FROM background_job
         WHERE (
             status IN ('succeeded', 'ignored')
             AND updated_at < now() - ($1 || ' seconds')::interval
           )
           OR (
             status = 'failed'
             AND next_retry_at IS NULL
             AND payload->>'retain_exhausted' IS DISTINCT FROM 'true'
             AND updated_at < now() - ($2 || ' seconds')::interval
           )
         ORDER BY updated_at ASC
         LIMIT $3
       )
       RETURNING status
     )
     SELECT status, count(*)::int AS count
     FROM deleted
     GROUP BY status`,
    [
      appConfig.backgroundJob.completedRetentionSeconds,
      appConfig.backgroundJob.failedRetentionSeconds,
      appConfig.backgroundJob.historyCleanupBatchSize
    ]
  );
  const rows = result.rows as Array<{ status: string; count: number }>;
  if (rows.length) {
    logger.debug(
      "cleaned background job history",
      Object.fromEntries(rows.map((row) => [row.status, row.count]))
    );
  }
  return rows;
}
