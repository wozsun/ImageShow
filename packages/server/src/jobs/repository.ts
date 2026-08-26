import { appConfig } from "@imageshow/shared";
import type { PoolClient } from "pg";
import { errorMessage } from "../core/api-error.ts";
import { pool } from "../core/database-pools.ts";
import { logger } from "../core/logger.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import {
  parseBackgroundJobType,
  type BackgroundJob,
  type BackgroundJobType
} from "./types.ts";

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
         error='',
         retry_count=0,
         next_retry_at=NULL,
         execution_token=NULL,
         created_at=now(),
         updated_at=now()
     WHERE background_job.status='succeeded'
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
export type RerunnableJobInput = Readonly<{
  type: BackgroundJobType;
  targetId: string;
  payload: unknown;
  idempotencyKey: string;
}>;

export async function enqueueRerunnableJobs(
  jobs: readonly RerunnableJobInput[],
  client?: PoolClient
) {
  if (!jobs.length) return;
  const uniqueJobs = [...new Map(jobs.map((job) => [
    job.idempotencyKey,
    {
      id: randomUuidV7(),
      type: job.type,
      target_id: job.targetId,
      payload: job.payload,
      idempotency_key: job.idempotencyKey
    }
  ])).values()];
  const query = `INSERT INTO background_job(
                   id, type, target_id, payload, idempotency_key
                 )
                 SELECT input.id,
                        input.type,
                        input.target_id,
                        input.payload,
                        input.idempotency_key
                   FROM jsonb_to_recordset($1::jsonb) AS input(
                     id uuid,
                     type text,
                     target_id text,
                     payload jsonb,
                     idempotency_key text
                   )
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
                     execution_token=CASE
                       WHEN background_job.status='running'
                         THEN background_job.execution_token
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
                    OR background_job.status='succeeded'
                     OR (
                       background_job.status='failed'
                       AND background_job.next_retry_at IS NULL
                     )`;
  const values = [JSON.stringify(uniqueJobs)];
  if (client) await client.query(query, values);
  else await pool.query(query, values);
}

export function enqueueRerunnableJob(
  type: BackgroundJobType,
  targetId: string,
  payload: unknown,
  idempotencyKey: string,
  client?: PoolClient
) {
  return enqueueRerunnableJobs([{
    type,
    targetId,
    payload,
    idempotencyKey
  }], client);
}

type BackgroundJobRow = Omit<BackgroundJob, "type"> & { type: unknown };

function backgroundJobFromRow(row: BackgroundJobRow): BackgroundJob {
  return {
    ...row,
    type: parseBackgroundJobType(row.type)
  };
}

export async function claimBackgroundJob(type: BackgroundJobType) {
  const executionToken = randomUuidV7();
  const result = await pool.query(
    `UPDATE background_job
     SET status='running', execution_token=$2, updated_at=now()
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
     RETURNING id, type, target_id, payload, execution_token,
               retry_count, created_at`,
    [type, executionToken]
  );
  const row = result.rows[0] as BackgroundJobRow | undefined;
  return row ? backgroundJobFromRow(row) : undefined;
}

export async function renewBackgroundJobLease(job: BackgroundJob) {
  const result = await pool.query(
    `UPDATE background_job
     SET updated_at=now()
     WHERE id=$1 AND status='running' AND execution_token=$2`,
    [job.id, job.execution_token]
  );
  return result.rowCount === 1;
}

export async function markBackgroundJobSucceeded(job: BackgroundJob) {
  const updated = await pool.query(
    `UPDATE background_job
     SET status=CASE
           WHEN payload->>'rerun_requested'='true' THEN 'pending'
           ELSE 'succeeded'
         END,
         payload=payload - 'rerun_requested',
         error='',
         retry_count=CASE
           WHEN payload->>'rerun_requested'='true' THEN 0
           ELSE retry_count
         END,
         next_retry_at=NULL,
         execution_token=NULL,
         created_at=CASE
           WHEN payload->>'rerun_requested'='true' THEN now()
           ELSE created_at
         END,
         updated_at=now()
     WHERE id=$1 AND status='running' AND execution_token=$2`,
    [job.id, job.execution_token]
  );
  return updated.rowCount === 1;
}

export async function rescheduleBackgroundJob(
  job: BackgroundJob,
  delayMs: number
) {
  const updated = await pool.query(
    `UPDATE background_job
     SET status='pending',
         error='',
         next_retry_at=$3,
         execution_token=NULL,
         updated_at=now()
     WHERE id=$1 AND status='running' AND execution_token=$2`,
    [
      job.id,
      job.execution_token,
      new Date(Date.now() + Math.max(0, delayMs))
    ]
  );
  return updated.rowCount === 1;
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

  const updated = await pool.query(
    `UPDATE background_job
     SET status='failed',
         payload=payload - 'rerun_requested',
         retry_count=$2,
         next_retry_at=$3,
         error=$4,
         execution_token=NULL,
         updated_at=now()
     WHERE id=$1 AND status='running' AND execution_token=$5`,
    [
      job.id,
      retry,
      exhausted ? null : new Date(Date.now() + seconds * 1000),
      errorMessage(error),
      job.execution_token
    ]
  );
  if (updated.rowCount === 1) {
    logger[exhausted ? "error" : "warn"](
      `task ${job.type} ${
        exhausted ? "gave up" : `will retry (${retry}/${maxRetries})`
      } id=${job.id.slice(0, 8)}: ${errorMessage(error)}`
    );
    return true;
  }
  return false;
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
    type: parseBackgroundJobType(row.type),
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
         execution_token=NULL,
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
             status='succeeded'
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
