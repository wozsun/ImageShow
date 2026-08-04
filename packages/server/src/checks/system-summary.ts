import { pool } from "../core/db.ts";
import { errorMessage } from "../core/api-error.ts";
import { getReadyImageCacheCoordinatorStatus } from "../images/ready-cache/coordinator.ts";
import { listStorageKeys } from "../storage/object-access.ts";
import { storageBackends } from "./storage-common.ts";

export async function checkSystemState() {
  const dbCheck = (
    await pool.query("SELECT count(*)::int FROM metadata")
  ).rows[0].count;
  const imageCache = getReadyImageCacheCoordinatorStatus();
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
    image_cache: {
      state: imageCache.meta?.state ?? imageCache.reason,
      readable: imageCache.readable,
      revision: imageCache.meta?.appliedRevision ?? null,
      item_count: imageCache.meta?.itemCount ?? null
    },
    storage
  };
}
