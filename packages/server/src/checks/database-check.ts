import { appConfig } from "@imageshow/shared";
import { pool } from "../core/database/pools.ts";
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
  const rows = (await pool.query(
    `SELECT id, object_key, deleted_at
       FROM metadata
      WHERE status='deleted'
      ORDER BY deleted_at ASC
      LIMIT $1`,
    [appConfig.trashBatchSize]
  )).rows;
  return { deleted_count: rows.length, candidates: rows };
}
