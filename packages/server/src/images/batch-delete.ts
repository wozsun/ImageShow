import { pool } from "../core/db.ts";
import { invalidateImageReadCaches, invalidateMd5Caches } from "./image-cache.ts";
import { syncRandomImages } from "../random/random-cache.ts";
import type { ImageRecord } from "./presenter.ts";

export async function batchDeleteImages(ids: string[]) {
  if (!ids.length) return { deleted: 0, ignored: 0 };
  const result = await pool.query(
    "UPDATE metadata SET status='deleted', deleted_at=now(), updated_at=now() WHERE id = ANY($1::uuid[]) AND status='ready' RETURNING id, md5",
    [ids]
  );
  const deletedTargets = result.rows as ImageRecord[];
  const deletedIds = deletedTargets.map((target) => target.id);
  await syncRandomImages(deletedIds);
  await invalidateMd5Caches(deletedTargets.map((target) => target.md5 ?? ""));
  if (deletedTargets.length) await invalidateImageReadCaches();
  return { deleted: deletedTargets.length, ignored: ids.length - deletedTargets.length };
}
