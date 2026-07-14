import { pool } from "../core/db.ts";
import { invalidateImageLookupEntries, invalidateImageReadCaches, invalidateMd5Caches } from "./image-cache.ts";
import { syncRandomImages } from "../random/random-cache.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";
import type { ImageRecord } from "./presenter.ts";

export async function batchDeleteImages(ids: string[]) {
  if (!ids.length) return { deleted: 0, ignored: 0 };
  const result = await pool.query(
    "UPDATE metadata SET status='deleted', deleted_at=now(), updated_at=now() WHERE id = ANY($1::uuid[]) AND status='ready' RETURNING id, object_key, md5",
    [ids]
  );
  const deletedTargets = result.rows as ImageRecord[];
  const deletedIds = deletedTargets.map((target) => target.id);
  await syncRandomImages(deletedIds);
  await invalidateMd5Caches(deletedTargets.map((target) => target.md5 ?? ""));
  if (deletedTargets.length) {
    await invalidateImageLookupEntries(deletedTargets);
    await Promise.all([
      invalidateImageReadCaches(),
      invalidateEntityCountCaches(["theme", "author"]),
    ]);
  }
  return { deleted: deletedTargets.length, ignored: ids.length - deletedTargets.length };
}
