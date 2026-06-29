// Public surface of the checks module. Each diagnostic/maintenance concern lives in
// its own file (database, storage check/cleanup/migrate); this barrel re-exports
// them so callers import from one place, and holds checkAll — the one overview that
// genuinely spans both the database and every storage backend.
import { pool } from "../core/db.js";
import { errorMessage } from "../core/http.js";
import { getFolderMap } from "../core/redis.js";
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
        objects: (await listStorageKeys("objects", backend)).length,
        thumbs: (await listStorageKeys("thumbs", backend)).length,
        trash: (await listStorageKeys("trash", backend)).length,
        uploads: (await listStorageKeys("_uploads", backend)).length
      };
    } catch (error) {
      storage[backend] = { error: errorMessage(error) };
    }
  }
  return { images: dbCheck, default_backend: defaultBackend, folder_map: folderMap, storage };
}
