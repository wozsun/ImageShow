import { pool } from "../core/db.ts";
import { invalidateImageCaches } from "./image-cache.ts";
import { syncRandomImages } from "../random/cache-sync.ts";
import { invalidateEntityCountCaches } from "../vocab/vocab-cache.ts";
import type { ImageRecord } from "./presenter.ts";

export async function batchDeleteImages(ids: string[]) {
  if (!ids.length) return { deleted: 0, ignored: 0 };
  const result = await pool.query(
    `UPDATE metadata
        SET status='deleted',
            deleted_at=now(),
            purge_state='idle',
            purge_started_at=NULL,
            purge_error=NULL,
            updated_at=now()
      WHERE id = ANY($1::uuid[]) AND status='ready'
      RETURNING id, object_key, md5`,
    [ids]
  );
  const deletedTargets = result.rows as ImageRecord[];
  const deletedIds = deletedTargets.map((target) => target.id);
  await syncRandomImages(deletedIds);
  if (deletedTargets.length) {
    await Promise.all([
      invalidateImageCaches({
        lookupEntries: deletedTargets,
        md5s: deletedTargets.map((target) => target.md5 ?? "")
      }),
      invalidateEntityCountCaches(["theme", "author"]),
    ]);
  }
  return { deleted: deletedTargets.length, ignored: ids.length - deletedTargets.length };
}
