import { appConfig } from "@imageshow/shared";
import { pool } from "../core/db.ts";
import { errorMessage } from "../core/api-error.ts";
import { logger } from "../core/logger.ts";
import { randomUuidV7 } from "../core/uuid.ts";

export type BackgroundJobType =
  | "thumb.generate"
  | "move.cleanup"
  | "import.cleanup"
  | "cache.rebuild";

export type BackgroundJob = {
  id: string;
  type: string;
  target_id: string;
  payload: Record<string, unknown>;
  retry_count: number;
  created_at: Date | string;
};

export async function enqueue(
  type: BackgroundJobType,
  targetId = "",
  payload: unknown = {},
  idempotencyKey?: string
) {
  const id = randomUuidV7();
  await pool.query(
    `INSERT INTO background_job(id, type, target_id, payload, idempotency_key)
     VALUES($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [id, type, targetId, JSON.stringify(payload), idempotencyKey ?? null]
  );
}

export async function claimBackgroundJob(type: string) {
  const result = await pool.query(
    `UPDATE background_job
     SET status = 'running', updated_at = now()
     WHERE id = (
       SELECT id FROM background_job
       WHERE (status = 'pending' OR (status = 'failed' AND next_retry_at <= now()))
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

export async function markBackgroundJobSucceeded(id: string, result: unknown = {}) {
  await pool.query(
    "UPDATE background_job SET status='succeeded', result=$2::jsonb, updated_at=now() WHERE id=$1",
    [id, JSON.stringify(result)]
  );
}

export async function markBackgroundJobIgnored(id: string, reason: string) {
  await pool.query(
    "UPDATE background_job SET status='ignored', error=$2, updated_at=now() WHERE id=$1",
    [id, reason]
  );
}

export async function markBackgroundJobFailed(job: BackgroundJob, error: unknown) {
  const retry = job.retry_count + 1;
  const maxRetries = appConfig.backgroundJob.maxRetries;
  const backoff = appConfig.backgroundJob.retryBackoffSeconds;
  const seconds = backoff[Math.min(retry - 1, backoff.length - 1)];
  const exhausted = retry >= maxRetries;

  logger[exhausted ? "error" : "warn"](
    `task ${job.type} ${exhausted ? "gave up" : `will retry (${retry}/${maxRetries})`} id=${job.id.slice(0, 8)}: ${errorMessage(error)}`
  );
  await pool.query(
    "UPDATE background_job SET status='failed', retry_count=$2, next_retry_at=$3, error=$4, updated_at=now() WHERE id=$1",
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
            floor(extract(epoch FROM (now() - min(created_at))) * 1000)::bigint AS oldest_wait_ms
       FROM background_job
     WHERE status='pending' OR (status='failed' AND next_retry_at <= now())
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
         next_retry_at=CASE WHEN retry_count + 1 >= $2 THEN NULL ELSE now() END,
         error='Recovered stale running task',
         updated_at=now()
     WHERE status='running'
       AND updated_at < now() - ($1 || ' seconds')::interval`,
    [appConfig.backgroundJob.taskTimeoutSeconds, appConfig.backgroundJob.maxRetries]
  );
}

export async function scheduleImportCleanup() {
  await pool.query(
    `INSERT INTO background_job(id, type, status)
     SELECT $1, 'import.cleanup', 'pending'
     WHERE EXISTS (SELECT 1 FROM import_session WHERE expires_at < now())
       AND NOT EXISTS (
         SELECT 1 FROM background_job
         WHERE type='import.cleanup' AND status IN ('pending', 'running')
       )`,
    [randomUuidV7()]
  ).catch(() => undefined);
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
