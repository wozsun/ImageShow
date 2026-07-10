import { appConfig } from "@imageshow/shared";
import { pool } from "../core/db.ts";
import {
  getRandomCategoryCounts,
  type RandomCategoryCounts
} from "../random/random-cache.ts";

function categoryTotal(counts: RandomCategoryCounts) {
  let total = 0;
  for (const device of Object.values(counts)) {
    for (const brightness of Object.values(device)) {
      for (const count of Object.values(brightness)) total += Number(count) || 0;
    }
  }
  return total;
}

export async function checkDatabase() {
  const readyCount = Number((await pool.query("SELECT count(*)::int AS total FROM metadata WHERE status='ready'")).rows[0]?.total ?? 0);
  const operations = (await pool.query(
    "SELECT id,type,target_id,status,retry_count,error,updated_at FROM background_job WHERE status IN ('pending','running','failed') ORDER BY updated_at DESC LIMIT $1",
    [appConfig.backgroundJob.sampleLimit]
  )).rows;
  try {
    const categoryCounts = await getRandomCategoryCounts();
    const randomPoolCount = categoryTotal(categoryCounts);
    return {
      ready_count: readyCount,
      random_pool_count: randomPoolCount,
      random_pool_mismatch: readyCount !== randomPoolCount,
      random_category_counts: categoryCounts,
      operations
    };
  } catch (error) {
    return {
      ready_count: readyCount,
      random_pool_count: null,
      random_pool_mismatch: true,
      random_pool_error: (error as Error).message,
      operations
    };
  }
}

export async function checkTrash() {
  const rows = (await pool.query("SELECT id, object_key, deleted_at FROM metadata WHERE status='deleted' ORDER BY deleted_at ASC LIMIT $1", [appConfig.trashBatchSize])).rows;
  return { deleted_count: rows.length, candidates: rows };
}
