// Durable background worker. Jobs live in the operation_log table and are
// claimed one at a time with SELECT ... FOR UPDATE SKIP LOCKED, retried with
// exponential backoff, and recovered if a previous process crashed mid-run.
import { v7 as uuidv7 } from "uuid";
import { appConfig } from "@imageshow/shared";
import { cleanupEmptyCategories, pool } from "../core/db.js";
import { contentType, makeThumb } from "../images/processing.js";
import { thumbnailObjectKey } from "../storage/image-paths.js";
import { moveObject, removeObject, exists } from "../storage/storage.js";
import { rebuildFolderMap } from "../core/redis.js";
import { restoreImageFromTrash } from "./restore.js";
import { getRuntimeConfig } from "../config/env.js";

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

export async function enqueueMany(type: string, targetIds: string[]) {
  if (!targetIds.length) return [];
  const ids = targetIds.map(() => uuidv7());
  await pool.query(
    `INSERT INTO operation_log(id, type, target_id, payload)
     SELECT task_id, $3, target_id, '{}'::jsonb
     FROM unnest($1::uuid[], $2::text[]) AS queued(task_id, target_id)`,
    [ids, targetIds, type]
  );
  return ids;
}

async function claim() {
  const result = await pool.query(
    `UPDATE operation_log
     SET status = 'running', updated_at = now()
     WHERE id = (
       SELECT id FROM operation_log
       WHERE status = 'pending' OR (status = 'failed' AND next_retry_at <= now())
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`
  );
  return result.rows[0] as { id: string; type: string; target_id: string; payload: Record<string, unknown>; retry_count: number } | undefined;
}

async function succeed(id: string, result: unknown = {}) {
  await pool.query("UPDATE operation_log SET status='succeeded', result=$2::jsonb, updated_at=now() WHERE id=$1", [id, JSON.stringify(result)]);
}

async function ignore(id: string, reason: string) {
  await pool.query("UPDATE operation_log SET status='ignored', error=$2, updated_at=now() WHERE id=$1", [id, reason]);
}

async function fail(id: string, retryCount: number, error: unknown) {
  const retry = retryCount + 1;
  const maxRetries = appConfig.operationLog.maxRetries;
  const seconds = appConfig.operationLog.retryBackoffSeconds[Math.max(0, retry - 1)] ?? appConfig.operationLog.retryBackoffSeconds.at(-1) ?? 21600;
  await pool.query(
    "UPDATE operation_log SET status='failed', retry_count=$2, next_retry_at=$3, error=$4, updated_at=now() WHERE id=$1",
    [id, retry, retry >= maxRetries ? null : new Date(Date.now() + seconds * 1000), error instanceof Error ? error.message : String(error)]
  );
}

async function runOne(task: NonNullable<Awaited<ReturnType<typeof claim>>>) {
  if (task.type === "thumb.generate") {
    const result = await pool.query("SELECT object_key, status, storage_backend FROM metadata WHERE id=$1", [task.target_id]);
    const row = result.rows[0];
    if (!row) return ignore(task.id, "metadata missing");
    if (row.status !== "ready") return ignore(task.id, "image not ready");
    if (!await exists("objects", row.object_key, row.storage_backend)) return ignore(task.id, "object missing");
    await makeThumb(row.object_key, row.storage_backend);
    return succeed(task.id);
  }
  if (task.type === "delete.finalize") {
    const result = await pool.query("SELECT id, object_key, ext, status, storage_backend FROM metadata WHERE id=$1", [task.target_id]);
    const row = result.rows[0];
    if (!row || row.status !== "deleted") return ignore(task.id, "image not deleted");
    if (await exists("objects", row.object_key, row.storage_backend)) {
      await moveObject("objects", row.object_key, "trash", row.object_key, contentType(row.ext), row.storage_backend);
    }
    await removeObject("thumbs", thumbnailObjectKey(row.object_key), row.storage_backend);
    return succeed(task.id);
  }
  if (task.type === "restore.finalize") {
    const result = await restoreImageFromTrash(task.target_id);
    if (result.status === "not_deleted") return ignore(task.id, "image not deleted");
    if (result.status === "object_missing") return ignore(task.id, "object missing");
    return succeed(task.id);
  }
  if (task.type === "move.cleanup") {
    const objectKey = typeof task.payload.object_key === "string" ? task.payload.object_key : "";
    const rawBackend = task.payload.backend;
    const backend = rawBackend === "s3" ? ("s3" as const) : rawBackend === "local" ? ("local" as const) : undefined;
    if (objectKey) {
      await removeObject("objects", objectKey, backend);
      await removeObject("thumbs", thumbnailObjectKey(objectKey), backend);
    }
    return succeed(task.id);
  }
  if (task.type === "upload.cleanup") {
    const rows = (await pool.query(
      "SELECT id, staging_object_key FROM upload_session WHERE status IN ('created','failed','expired') AND expires_at < now() LIMIT $1",
      [appConfig.trashBatchSize]
    )).rows;
    for (const row of rows) {
      await removeObject("_uploads", row.staging_object_key).catch(() => undefined);
      await removeObject("_uploads", `${row.staging_object_key}.part`).catch(() => undefined);
    }
    await pool.query("UPDATE upload_session SET status='expired', updated_at=now() WHERE id = ANY($1::uuid[]) AND status IN ('created','failed')", [rows.map((row) => row.id)]);
    return succeed(task.id, { cleaned: rows.length });
  }
  if (task.type === "cache.rebuild") {
    await rebuildFolderMap();
    return succeed(task.id);
  }
  if (task.type === "empty-trash") {
    const ids = Array.isArray(task.payload.ids) ? task.payload.ids : [];
    const rows = ids.length
      ? (await pool.query("SELECT id, object_key, storage_backend FROM metadata WHERE id = ANY($1::uuid[]) AND status='deleted'", [ids])).rows
      : [];
    for (const row of rows) {
      await removeObject("objects", row.object_key, row.storage_backend).catch(() => undefined);
      await removeObject("trash", row.object_key, row.storage_backend).catch(() => undefined);
      await removeObject("thumbs", thumbnailObjectKey(row.object_key), row.storage_backend).catch(() => undefined);
    }
    await pool.query("DELETE FROM metadata WHERE id = ANY($1::uuid[]) AND status='deleted'", [ids]);
    await cleanupEmptyCategories();
    return succeed(task.id, { deleted: rows.length });
  }
  return ignore(task.id, "not implemented");
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
  const maxTasksPerTick = getRuntimeConfig().operation_log.max_tasks_per_tick;
  for (let i = 0; i < maxTasksPerTick; i += 1) {
    const task = await claim();
    if (!task) return;
    try {
      await runOne(task);
    } catch (error) {
      await fail(task.id, task.retry_count, error);
    }
  }
}

function tick() {
  if (tickPromise) return tickPromise;
  tickPromise = runTick().finally(() => { tickPromise = null; });
  return tickPromise;
}

async function recoverStaleTasks() {
  await pool.query(
    `UPDATE operation_log
     SET status='failed',
         retry_count=retry_count+1,
         next_retry_at=now(),
         error='Recovered stale running task',
         updated_at=now()
     WHERE status='running'
       AND updated_at < now() - ($1 || ' seconds')::interval`,
    [appConfig.operationLog.taskTimeoutSeconds]
  );
}

async function expireUploads() {
  const count = Number((await pool.query(
    "SELECT count(*)::int FROM upload_session WHERE status IN ('created','failed') AND expires_at < now()"
  )).rows[0].count);
  // The idempotency key collapses repeated ticks into one active cleanup job.
  if (count) await enqueue("upload.cleanup", "", {}, "upload.cleanup").catch(() => undefined);
}

export function startWorker() {
  if (timer) return;
  timer = setInterval(() => tick().catch(console.error), 5000);
  void tick().catch(console.error);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
