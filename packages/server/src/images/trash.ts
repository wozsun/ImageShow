import { pool } from "../core/db.ts";
import { ApiError } from "../core/http.ts";
import { restoreImageFromTrash, restoreImagesFromTrash } from "./restore.ts";
import { removeObject } from "../storage/storage.ts";
import { thumbnailRef } from "../storage/image-paths.ts";
import { invalidateImageLookupEntries, invalidateImageReadCaches, invalidateMd5Cache, invalidateMd5Caches } from "./image-cache.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";

export async function restoreDeletedImage(id: string, missingIsError = true) {
  const result = await restoreImageFromTrash(id);
  if (result.status === "not_deleted") {
    if (missingIsError) throw new ApiError(404, "not_found", "Deleted image not found");
    return false;
  }
  await invalidateMd5Cache(result.image.md5 ?? "");
  await invalidateImageLookupEntries([result.image]);
  await Promise.all([
    invalidateImageReadCaches(),
    invalidateEntityCountCaches(["theme", "author"]),
  ]);
  return true;
}

export async function batchRestoreImages(ids: string[]) {
  const restoredImages = await restoreImagesFromTrash(ids);
  await invalidateMd5Caches(restoredImages.map((image) => image.md5 ?? ""));
  if (restoredImages.length) {
    await invalidateImageLookupEntries(restoredImages);
    await Promise.all([
      invalidateImageReadCaches(),
      invalidateEntityCountCaches(["theme", "author"]),
    ]);
  }
  return {
    restored: restoredImages.length,
    ignored: ids.length - restoredImages.length
  };
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
        const removals = [removeObject(thumb.prefix, thumb.key, thumb.slug)];
        if (!row.is_link) {
          removals.push(removeObject("media", row.object_key, row.storage_slug));
        }
        await Promise.all(removals);
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
    await invalidateImageLookupEntries(deletedRows);
    await Promise.all([
      invalidateImageReadCaches(),
      invalidateEntityCountCaches(["tag"]),
    ]);
  }
  return { requested: rows.length, deleted: deletedIds.length, failed };
}

export async function purgeDeletedImage(id: string) {
  const result = await purgeDeletedImages([id]);
  if (!result.requested) throw new ApiError(404, "not_found", "Deleted image not found");
  if (result.failed) throw new ApiError(502, "storage_delete_failed", "Failed to permanently delete the stored image");
}
