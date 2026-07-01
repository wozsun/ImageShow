// Durable background worker. Jobs live in the operation_log table and are
// claimed one at a time with SELECT ... FOR UPDATE SKIP LOCKED, retried with
// exponential backoff, and recovered if a previous process crashed mid-run.
import { v7 as uuidv7 } from "uuid";
import { appConfig } from "@imageshow/shared";
import { pool } from "../core/db.js";
import { errorMessage } from "../core/http.js";
import { logger } from "../core/logger.js";
import { createThumbnail, makeThumb, md5Buffer } from "../images/processing.js";
import { thumbnailObjectKey } from "../storage/image-paths.js";
import { exists, readStorageBuffer, removeObject, writeStorageBuffer } from "../storage/storage.js";
import { rebuildFolderMap } from "../core/redis.js";
import { getRuntimeConfig } from "../config/env.js";
import { getStorageBackend } from "../config/settings.js";

let timer: NodeJS.Timeout | undefined;
let tickPromise: Promise<void> | null = null;
// Stale-task recovery and upload expiry are housekeeping, not per-tick work, so
// they run on their own slow cadence instead of on every 5s tick. Both start at 0
// so they fire on the first tick after startup, then throttle to their interval.
let lastStaleRecovery = 0;
let lastExpireUploads = 0;

export async function enqueue(type: string, targetId = "", payload: unknown = {}, idempotencyKey?: string) {
  const id = uuidv7();
  await pool.query(
    `INSERT INTO operation_log(id, type, target_id, payload, idempotency_key)
     VALUES($1, $2, $3, $4::jsonb, $5)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [id, type, targetId, JSON.stringify(payload), idempotencyKey ?? null]
  );
  return id;
}

// Atomically claims the oldest claimable task — optionally restricted to one type, so a
// per-type lane only pulls its own work. SKIP LOCKED means concurrent lanes (and other
// instances) never grab the same row.
async function claim(type?: string) {
  const result = await pool.query(
    `UPDATE operation_log
     SET status = 'running', updated_at = now()
     WHERE id = (
       SELECT id FROM operation_log
       WHERE (status = 'pending' OR (status = 'failed' AND next_retry_at <= now()))
         ${type ? "AND type = $1" : ""}
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    type ? [type] : []
  );
  return result.rows[0] as { id: string; type: string; target_id: string; payload: Record<string, unknown>; retry_count: number } | undefined;
}

async function succeed(id: string, result: unknown = {}) {
  await pool.query("UPDATE operation_log SET status='succeeded', result=$2::jsonb, updated_at=now() WHERE id=$1", [id, JSON.stringify(result)]);
}

async function ignore(id: string, reason: string) {
  await pool.query("UPDATE operation_log SET status='ignored', error=$2, updated_at=now() WHERE id=$1", [id, reason]);
}

async function fail(task: Task, error: unknown) {
  const retry = task.retry_count + 1;
  const maxRetries = appConfig.operationLog.maxRetries;
  const backoff = appConfig.operationLog.retryBackoffSeconds;
  const seconds = backoff[Math.min(retry - 1, backoff.length - 1)];
  const exhausted = retry >= maxRetries;
  // A retrying task is a warning; one that's out of retries is an error worth attention.
  logger[exhausted ? "error" : "warn"](
    `task ${task.type} ${exhausted ? "gave up" : `will retry (${retry}/${maxRetries})`} id=${task.id.slice(0, 8)}: ${errorMessage(error)}`
  );
  await pool.query(
    "UPDATE operation_log SET status='failed', retry_count=$2, next_retry_at=$3, error=$4, updated_at=now() WHERE id=$1",
    [task.id, retry, exhausted ? null : new Date(Date.now() + seconds * 1000), errorMessage(error)]
  );
}

type Task = NonNullable<Awaited<ReturnType<typeof claim>>>;

// One handler per operation_log task type. Each finishes via succeed() / ignore(), or throws —
// a throw is caught by the draining lane and routed to fail() with backoff. Unknown types fall
// through to the "not implemented" ignore in runOne.
const taskHandlers: Record<string, (task: Task) => Promise<unknown>> = {
  "thumb.generate": async (task) => {
    const result = await pool.query("SELECT object_key, status, storage_slug, is_link, md5 FROM metadata WHERE id=$1", [task.target_id]);
    const row = result.rows[0];
    if (!row) return ignore(task.id, "metadata missing");
    if (row.status !== "ready") return ignore(task.id, "image not ready");
    // Link thumbnails are made at import time from the downloaded bytes (no stored
    // object to read here), so this job doesn't apply to them.
    if (row.is_link) return ignore(task.id, "link thumbnail generated at import");
    if (!await exists("objects", row.object_key, row.storage_slug)) return ignore(task.id, "object missing");
    let thumbnailSize: number;
    const config = await getStorageBackend(row.storage_slug);
    if (config.type !== "local") {
      // thumb.generate is the fallback for a category move whose thumbnail copy failed
      // (updateImageMetadata copies the old thumb to the re-keyed object; only a failed copy
      // enqueues this) — never on upload (thumbnails inline) or restore (pure DB, no file move).
      // We have to download the object to rebuild the thumb anyway, so verify its md5 against the
      // recorded value as a cheap integrity check, then thumbnail from the same buffer. A mismatch
      // fails the task (surfaced in the check page) rather than thumbnailing a corrupt object.
      const buffer = await readStorageBuffer("objects", row.object_key, row.storage_slug);
      if (row.md5 && md5Buffer(buffer) !== row.md5) {
        throw new Error(`integrity check failed: stored object md5 does not match recorded md5 (${row.md5})`);
      }
      const thumbnail = await createThumbnail(buffer);
      await writeStorageBuffer("thumbs", thumbnailObjectKey(row.object_key), thumbnail, "image/webp", row.storage_slug);
      thumbnailSize = thumbnail.byteLength;
    } else {
      thumbnailSize = await makeThumb(row.object_key, row.storage_slug);
    }
    // Record the hosted thumbnail bytes so storage-usage stats stay accurate.
    await pool.query("UPDATE metadata SET thumbnail_size=$2 WHERE id=$1", [task.target_id, thumbnailSize]);
    return succeed(task.id);
  },
  "move.cleanup": async (task) => {
    const objectKey = typeof task.payload.object_key === "string" ? task.payload.object_key : "";
    // payload.backend is the source image's storage_slug (set when the move enqueued
    // this cleanup); undefined falls back to the default backend.
    const backend = typeof task.payload.backend === "string" ? task.payload.backend : undefined;
    if (objectKey) {
      await removeObject("objects", objectKey, backend);
      await removeObject("thumbs", thumbnailObjectKey(objectKey), backend);
    }
    return succeed(task.id);
  },
  "upload.cleanup": async (task) => {
    // Reclaim staging bytes for stale in-flight sessions (created/failed/finalizing past
    // their TTL), then delete every past-TTL session so the table can't grow without bound.
    // 'finalizing' past TTL is a crashed finalize (finalize takes seconds): its staging is
    // already moved to objects/, and any orphan final object is reclaimed by 清理无效存储. A
    // finalized session's lasting record is its image row, so it too is retired once expired.
    const rows = (await pool.query(
      "SELECT id, staging_object_key FROM upload_session WHERE status IN ('created','failed','finalizing') AND expires_at < now() LIMIT $1",
      [appConfig.trashBatchSize]
    )).rows;
    for (const row of rows) {
      await removeObject("_uploads", row.staging_object_key).catch(() => undefined);
      await removeObject("_uploads", `${row.staging_object_key}.part`).catch(() => undefined);
    }
    const deleted = await pool.query(
      "DELETE FROM upload_session WHERE id = ANY($1::uuid[]) OR (status = 'finalized' AND expires_at < now())",
      [rows.map((row) => row.id)]
    );
    return succeed(task.id, { cleaned: deleted.rowCount });
  },
  "cache.rebuild": async (task) => {
    await rebuildFolderMap();
    return succeed(task.id);
  }
};

// Dispatches a claimed task to its type handler; unknown types are ignored as not implemented.
async function runOne(task: Task) {
  const handler = taskHandlers[task.type];
  return handler ? handler(task) : ignore(task.id, "not implemented");
}

// Per-task-type worker concurrency. thumb.generate shares the upload concurrency knob;
// move.cleanup has its own file-only knob. Everything else stays serial (limit 1):
// cache.rebuild / upload.cleanup are idempotency-key singletons that don't want parallel lanes.
function typeConcurrency(type: string): number {
  const config = getRuntimeConfig();
  switch (type) {
    case "thumb.generate": return config.upload.concurrency;
    case "move.cleanup": return config.operation_log.move_cleanup_concurrency;
    default: return 1;
  }
}

// Drains all claimable tasks of one type using `lanes` parallel workers, each pulling
// the next task (SKIP LOCKED) until the type's queue is empty.
async function drainType(type: string, lanes: number) {
  async function lane() {
    for (;;) {
      const task = await claim(type);
      if (!task) return;
      try {
        await runOne(task);
      } catch (error) {
        await fail(task, error);
      }
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane));
}

async function runTick() {
  const now = Date.now();
  // Recovery runs before claiming new work so stale tasks from a crashed process
  // can re-enter the normal retry path without manual intervention — but only on
  // its slow interval to avoid an idle periodic UPDATE every few seconds.
  if (now - lastStaleRecovery >= appConfig.operationLog.staleRecoveryIntervalMs) {
    lastStaleRecovery = now;
    await recoverStaleTasks();
  }
  if (now - lastExpireUploads >= appConfig.operationLog.expireUploadsIntervalMs) {
    lastExpireUploads = now;
    await expireUploads();
  }
  // One cheap aggregate finds which types have claimable work, then each type is drained
  // in parallel with its own bounded concurrency (capped at the count actually waiting, so
  // we never spawn idle lanes). Lanes keep claiming, so tasks enqueued mid-tick are picked
  // up too. The tick ends when every type's queue is empty.
  const pending = (await pool.query(
    `SELECT type, count(*)::int AS n FROM operation_log
     WHERE status='pending' OR (status='failed' AND next_retry_at <= now())
     GROUP BY type`
  )).rows as { type: string; n: number }[];
  await Promise.all(pending.map((row) => drainType(row.type, Math.min(typeConcurrency(row.type), row.n))));
}

function tick() {
  if (tickPromise) return tickPromise;
  tickPromise = runTick().finally(() => { tickPromise = null; });
  return tickPromise;
}

async function recoverStaleTasks() {
  // Re-queue tasks left 'running' by a crashed process. Mirror fail()'s retry cap: once the
  // incremented retry_count reaches maxRetries, stop (next_retry_at=null) instead of looping a
  // task that hangs on every run forever.
  await pool.query(
    `UPDATE operation_log
     SET status='failed',
         retry_count=retry_count+1,
         next_retry_at=CASE WHEN retry_count + 1 >= $2 THEN NULL ELSE now() END,
         error='Recovered stale running task',
         updated_at=now()
     WHERE status='running'
       AND updated_at < now() - ($1 || ' seconds')::interval`,
    [appConfig.operationLog.taskTimeoutSeconds, appConfig.operationLog.maxRetries]
  );
}

async function expireUploads() {
  // Enqueue one cleanup when any session has passed its TTL, but only if none is already
  // pending/running (the same "one active job" guard as the cache.rebuild fallback). A
  // constant idempotency_key can't be used here: succeeded operation_log rows are never
  // pruned, so it would wedge the job permanently after its first run.
  await pool.query(
    `INSERT INTO operation_log(id, type, status)
     SELECT $1, 'upload.cleanup', 'pending'
     WHERE EXISTS (SELECT 1 FROM upload_session WHERE expires_at < now())
       AND NOT EXISTS (
         SELECT 1 FROM operation_log WHERE type='upload.cleanup' AND status IN ('pending', 'running')
       )`,
    [uuidv7()]
  ).catch(() => undefined);
}

export function startWorker() {
  if (timer) return;
  const onTickError = (error: unknown) => logger.error("worker tick failed", error);
  timer = setInterval(() => tick().catch(onTickError), appConfig.operationLog.tickIntervalMs);
  void tick().catch(onTickError);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
}

// Waits for the in-flight tick (if any) to finish before shutdown, bounded by a
// timeout so a tick stuck on slow storage I/O can't block the process from exiting.
// Tasks are durable, so a tick abandoned at the timeout is recovered on next start.
export async function drainWorker(timeoutMs = appConfig.operationLog.drainTimeoutMs) {
  if (!tickPromise) return;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { deadlineTimer = setTimeout(resolve, timeoutMs); });
  await Promise.race([tickPromise.catch(() => undefined), deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
}
