import { appConfig } from "@imageshow/shared";
import { pool } from "../core/db.js";
import { getFolderMap, type FolderMap } from "../random/random-cache.js";

function folderTotal(map: FolderMap) {
  let total = 0;
  for (const device of Object.values(map)) {
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
    const folderMap = await getFolderMap();
    const randomPoolCount = folderTotal(folderMap);
    return {
      ready_count: readyCount,
      random_pool_count: randomPoolCount,
      random_pool_mismatch: readyCount !== randomPoolCount,
      folder_map: folderMap,
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
