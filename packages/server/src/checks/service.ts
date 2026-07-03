import { pool } from "../core/db.js";
import { errorMessage } from "../core/http.js";
import { getFolderMap } from "../random/random-cache.js";
import { listStorageKeys } from "../storage/storage.js";
import { storageBackends } from "./storage-common.js";

export * from "./storage-common.js";
export * from "./database-check.js";
export * from "./storage-check.js";
export * from "./storage-cleanup.js";
export * from "./storage-migrate.js";

export async function checkAll() {
  const dbCheck = (await pool.query("SELECT count(*)::int FROM metadata")).rows[0].count;
  const folderMap = await getFolderMap();
  const { defaultBackend, backends } = await storageBackends();
  const storage: Record<string, unknown> = {};
  for (const backend of backends) {
    try {
      storage[backend] = {
        media: (await listStorageKeys("media", backend)).length,
        thumbs: (await listStorageKeys("thumbs", backend)).length,
        uploads: (await listStorageKeys("_uploads", backend)).length
      };
    } catch (error) {
      storage[backend] = { error: errorMessage(error) };
    }
  }
  return { images: dbCheck, default_backend: defaultBackend, folder_map: folderMap, storage };
}
