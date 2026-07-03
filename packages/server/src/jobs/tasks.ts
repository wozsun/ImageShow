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
import { cleanupOrphanRawImports, removeRawImport } from "../images/prepared-import/temp-files.js";

let timer: NodeJS.Timeout | undefined;
let tickPromise: Promise<void> | null = null;

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

async function claim(type?: string) {
  // SKIP LOCKED 允许同类任务多 lane 并发领取；每个任务只会被一个 worker 实例抢到。
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

  // 失败任务按固定退避表重试；耗尽后仍保留 failed 状态，检查页可以看到最后错误。
  logger[exhausted ? "error" : "warn"](
    `task ${task.type} ${exhausted ? "gave up" : `will retry (${retry}/${maxRetries})`} id=${task.id.slice(0, 8)}: ${errorMessage(error)}`
  );
  await pool.query(
    "UPDATE operation_log SET status='failed', retry_count=$2, next_retry_at=$3, error=$4, updated_at=now() WHERE id=$1",
    [task.id, retry, exhausted ? null : new Date(Date.now() + seconds * 1000), errorMessage(error)]
  );
}

type Task = NonNullable<Awaited<ReturnType<typeof claim>>>;

const taskHandlers: Record<string, (task: Task) => Promise<unknown>> = {
  "thumb.generate": async (task) => {
    const result = await pool.query("SELECT object_key, status, storage_slug, is_link, md5 FROM metadata WHERE id=$1", [task.target_id]);
    const row = result.rows[0];
    if (!row) return ignore(task.id, "metadata missing");
    if (row.status !== "ready") return ignore(task.id, "image not ready");

    if (row.is_link) return ignore(task.id, "link thumbnail generated at import");
    if (!await exists("objects", row.object_key, row.storage_slug)) return ignore(task.id, "object missing");
    let thumbnailSize: number;
    const config = await getStorageBackend(row.storage_slug);
    if (config.type !== "local") {
      // 远端对象先读回内存再生成缩略图；有记录 md5 时顺便校验，避免给损坏对象生成新的“正常”缩略图。
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

    await pool.query("UPDATE metadata SET thumbnail_size=$2 WHERE id=$1", [task.target_id, thumbnailSize]);
    return succeed(task.id);
  },
  "move.cleanup": async (task) => {
    const objectKey = typeof task.payload.object_key === "string" ? task.payload.object_key : "";

    const backend = typeof task.payload.backend === "string" ? task.payload.backend : undefined;
    if (objectKey) {
      await removeObject("objects", objectKey, backend);
      await removeObject("thumbs", thumbnailObjectKey(objectKey), backend);
    }
    return succeed(task.id);
  },
  "upload.cleanup": async (task) => {
    const rows = (await pool.query(
      `SELECT id, staging_object_key, storage_slug, metadata_payload
       FROM upload_session WHERE status <> 'finalized' AND expires_at < now() LIMIT $1`,
      [appConfig.trashBatchSize]
    )).rows as Array<{ id: string; staging_object_key: string; storage_slug: string; metadata_payload: Record<string, unknown> }>;
    const cleanedIds: string[] = [];
    const failures: string[] = [];
    for (const row of rows) {
      try {
        // prepared import 可能停在 created/receiving/preparing/ready 任一阶段，因此同时清理 _uploads 和 raw 临时目录。
        await Promise.all([
          removeObject("_uploads", row.staging_object_key, row.storage_slug),
          removeObject("_uploads", String(row.metadata_payload.prepared_thumbnail_key ?? `${row.id}.thumb.webp`), row.storage_slug),
          removeRawImport("upload", row.id),
          removeRawImport("import", row.id)
        ]);
        cleanedIds.push(row.id);
      } catch (error) {
        failures.push(`${row.storage_slug}/${row.staging_object_key}: ${errorMessage(error)}`);
      }
    }
    const deleted = await pool.query(
      "DELETE FROM upload_session WHERE id = ANY($1::uuid[]) OR (status = 'finalized' AND expires_at < now())",
      [cleanedIds]
    );
    await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);

    if (failures.length) throw new Error(`upload staging cleanup failed: ${failures.join("; ")}`);
    return succeed(task.id, { cleaned: deleted.rowCount });
  },
  "cache.rebuild": async (task) => {
    await rebuildFolderMap();
    return succeed(task.id);
  }
};

async function runOne(task: Task) {
  const handler = taskHandlers[task.type];
  return handler ? handler(task) : ignore(task.id, "not implemented");
}

function typeConcurrency(type: string): number {
  const config = getRuntimeConfig();
  switch (type) {
    case "thumb.generate": return config.upload.concurrency;
    case "move.cleanup": return config.operation_log.move_cleanup_concurrency;
    default: return 1;
  }
}

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

  if (now - lastStaleRecovery >= appConfig.operationLog.staleRecoveryIntervalMs) {
    lastStaleRecovery = now;
    await recoverStaleTasks();
  }
  if (now - lastExpireUploads >= appConfig.operationLog.expireUploadsIntervalMs) {
    lastExpireUploads = now;
    await expireUploads();
  }

  const pending = (await pool.query(
    `SELECT type, count(*)::int AS n FROM operation_log
     WHERE status='pending' OR (status='failed' AND next_retry_at <= now())
     GROUP BY type`
  )).rows as { type: string; n: number }[];
  await Promise.all(pending.map((row) => drainType(row.type, Math.min(typeConcurrency(row.type), row.n))));
}

function tick() {
  // tick 不重入：上一次扫描未结束时直接复用同一个 Promise，避免重复领取相同类型的任务批次。
  if (tickPromise) return tickPromise;
  tickPromise = runTick().finally(() => { tickPromise = null; });
  return tickPromise;
}

async function recoverStaleTasks() {
  // 进程崩溃可能留下 running 任务；超过超时时间后转 failed 并进入正常重试路径。
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
  // 上传会话过期只入队一个清理任务，避免每次 tick 都插入重复 cleanup。
  await cleanupOrphanRawImports(appConfig.uploadTtlSeconds * 1000);

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

export async function drainWorker(timeoutMs = appConfig.operationLog.drainTimeoutMs) {
  if (!tickPromise) return;
  let deadlineTimer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => { deadlineTimer = setTimeout(resolve, timeoutMs); });
  await Promise.race([tickPromise.catch(() => undefined), deadline]);
  if (deadlineTimer) clearTimeout(deadlineTimer);
}
