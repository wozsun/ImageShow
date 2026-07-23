import { pool } from "../core/db.ts";
import { errorMessage } from "../core/api-error.ts";
import { getRandomCategoryCounts } from "../random/cache-read.ts";
import { listStorageKeys } from "../storage/object-access.ts";
import { storageBackends } from "./storage-common.ts";

export async function checkSystemState() {
  const dbCheck = (
    await pool.query("SELECT count(*)::int FROM metadata")
  ).rows[0].count;
  const categoryCounts = await getRandomCategoryCounts();
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
  return {
    images: dbCheck,
    default_backend: defaultBackend,
    random_category_counts: categoryCounts,
    storage
  };
}
