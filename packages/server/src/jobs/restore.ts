import { indexKey } from "@imageshow/shared";
import { adjustCategoryCount, pool, upsertCategory } from "../core/db.js";
import { bumpFolder } from "../core/redis.js";
import { contentType } from "../images/processing.js";
import { exists, moveObject } from "../storage/storage.js";
import { enqueue } from "./tasks.js";
import type { ImageRecord } from "../images/presenter.js";

export type RestoreResult =
  | { status: "restored"; image: ImageRecord }
  | { status: "not_deleted" }
  | { status: "object_missing" };

// Shared transactional restore of a deleted image back into its category, reused
// by the admin restore endpoints and the restore.finalize background task. It
// locks the row, recovers the object from trash if needed, re-indexes the
// category, and on success re-enqueues thumbnail generation and bumps the random
// pool. Callers map the discriminated result onto their own response/cache logic.
export async function restoreImageFromTrash(id: string): Promise<RestoreResult> {
  const client = await pool.connect();
  let image: ImageRecord | undefined;
  let movedFromTrash = false;
  let committed = false;
  try {
    await client.query("BEGIN");
    image = (await client.query("SELECT * FROM metadata WHERE id=$1 AND status='deleted' FOR UPDATE", [id])).rows[0];
    if (!image) {
      await client.query("ROLLBACK");
      return { status: "not_deleted" };
    }
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [image.category_key]);
    // Link images keep their external URL as the object key and their thumbnail through
    // soft-delete — there's no stored original to trash and recover, so restore just
    // re-indexes the row. Only stored-object images need the trash round-trip.
    if (!image.is_link && !(await exists("objects", image.object_key, image.storage_slug))) {
      if (await exists("trash", image.object_key, image.storage_slug)) {
        await moveObject("trash", image.object_key, "objects", image.object_key, contentType(image.ext), image.storage_slug);
        movedFromTrash = true;
      } else {
        await client.query("ROLLBACK");
        return { status: "object_missing" };
      }
    }
    await upsertCategory(client, image.category_key, image.device, image.brightness, image.theme);
    await client.query("SELECT * FROM category WHERE category_key=$1 FOR UPDATE", [image.category_key]);
    const cat = (await client.query("SELECT count FROM category WHERE category_key=$1", [image.category_key])).rows[0];
    const next = Number(cat.count) + 1;
    await adjustCategoryCount(client, image.category_key, 1);
    await client.query("UPDATE metadata SET status='ready', deleted_at=NULL, category_index=$2, index_key=$3, updated_at=now() WHERE id=$1", [id, next, indexKey(image.category_key, next)]);
    await client.query("UPDATE operation_log SET status='ignored', updated_at=now() WHERE target_id=$1 AND type='delete.finalize' AND status IN ('pending','failed')", [id]);
    await client.query("COMMIT");
    committed = true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // If the object was recovered from trash but the transaction failed, put it
    // back so a failed restore doesn't leave a ready row with no trash backup.
    if (movedFromTrash && !committed && image) {
      await moveObject("objects", image.object_key, "trash", image.object_key, contentType(image.ext), image.storage_slug).catch(() => {
        void enqueue("delete.finalize", id, {}, `delete.finalize:restore-rollback:${id}`).catch(() => undefined);
      });
    }
    throw error;
  } finally {
    client.release();
  }
  // Link thumbnails persist through soft-delete (no stored object to trash and back),
  // so there's nothing to regenerate; others rebuild the thumb from the restored object.
  if (!image.is_link) await enqueue("thumb.generate", id);
  await bumpFolder(image.category_key, 1);
  return { status: "restored", image };
}
