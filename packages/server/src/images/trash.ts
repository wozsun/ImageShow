import { cleanupEmptyCategories, pool } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { restoreImageFromTrash } from "../jobs/restore.js";
import { removeObject } from "../storage/storage.js";
import { thumbnailRef } from "../storage/image-paths.js";
import { invalidateImageReadCaches, invalidateMd5Cache, invalidateMd5Caches } from "../core/redis.js";

export async function restoreDeletedImage(id: string, missingIsError = true) {
  const result = await restoreImageFromTrash(id);
  if (result.status === "not_deleted") {
    if (missingIsError) throw new ApiError(404, "not_found", "Deleted image not found");
    return false;
  }
  await invalidateMd5Cache(result.image.md5 ?? "");
  await invalidateImageReadCaches();
  return true;
}

export async function batchRestoreImages(ids: string[]) {
  let restored = 0;
  let ignored = 0;
  const failedIds: string[] = [];
  for (const id of ids) {
    try {
      if (await restoreDeletedImage(id, false)) restored += 1;
      else ignored += 1;
    } catch {
      failedIds.push(id);
    }
  }
  return { requested: ids.length, restored, ignored, failed: failedIds.length, failed_ids: failedIds };
}

export async function purgeDeletedImages(ids?: string[]) {
  const rows = (await pool.query(
    ids?.length
      ? "SELECT id, object_key, md5, storage_slug, is_link, device, brightness, theme FROM metadata WHERE status='deleted' AND id = ANY($1::uuid[]) ORDER BY deleted_at ASC"
      : "SELECT id, object_key, md5, storage_slug, is_link, device, brightness, theme FROM metadata WHERE status='deleted' ORDER BY deleted_at ASC",
    ids?.length ? [ids] : []
  )).rows as Array<{ id: string; object_key: string; md5: string; storage_slug: string; is_link: boolean; device: string; brightness: string; theme: string }>;
  const deletedRows: typeof rows = [];
  let failed = 0;
  for (let offset = 0; offset < rows.length; offset += 10) {
    await Promise.all(rows.slice(offset, offset + 10).map(async (row) => {
      try {
        const thumb = thumbnailRef(row);
        await Promise.all([
          removeObject("objects", row.object_key, row.storage_slug),
          removeObject(thumb.prefix, thumb.key, thumb.slug)
        ]);
        deletedRows.push(row);
      } catch {
        failed += 1;
      }
    }));
  }
  const deletedIds = deletedRows.map((row) => row.id);
  if (deletedIds.length) {
    await pool.query("DELETE FROM metadata WHERE id = ANY($1::uuid[]) AND status='deleted'", [deletedIds]);
    await invalidateMd5Caches(deletedRows.map((row) => row.md5));
    await cleanupEmptyCategories();
    await invalidateImageReadCaches();
  }
  return { requested: rows.length, deleted: deletedIds.length, failed };
}

export async function purgeDeletedImage(id: string) {
  const result = await purgeDeletedImages([id]);
  if (!result.requested) throw new ApiError(404, "not_found", "Deleted image not found");
  if (result.failed) throw new ApiError(502, "storage_delete_failed", "Failed to permanently delete the stored image");
  return result;
}
