import { indexKey } from "@imageshow/shared";
import { adjustCategoryCount, pool, upsertCategory } from "../core/db.js";
import { bumpFolder } from "../core/redis.js";
import type { ImageRecord } from "../images/presenter.js";

export type RestoreResult =
  | { status: "restored"; image: ImageRecord }
  | { status: "not_deleted" };

// Restores a recycle-bin image back into its category. Soft-delete never moves or deletes the
// original or thumbnail — they stay in objects/ + thumbs/ — so restore is pure bookkeeping:
// lock the row, re-index it as the new tail of its category, flip it back to 'ready', and bump
// the random pool. No storage I/O, no thumbnail regeneration. Returns 'not_deleted' for a row
// that isn't in the recycle bin.
export async function restoreImageFromTrash(id: string): Promise<RestoreResult> {
  const client = await pool.connect();
  let image: ImageRecord | undefined;
  try {
    await client.query("BEGIN");
    image = (await client.query("SELECT * FROM metadata WHERE id=$1 AND status='deleted' FOR UPDATE", [id])).rows[0];
    if (!image) {
      await client.query("ROLLBACK");
      return { status: "not_deleted" };
    }
    // Serialize per-category index assignment (same lock the delete/move paths take).
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [image.category_key]);
    await upsertCategory(client, image.category_key, image.device, image.brightness, image.theme);
    await client.query("SELECT * FROM category WHERE category_key=$1 FOR UPDATE", [image.category_key]);
    const cat = (await client.query("SELECT count FROM category WHERE category_key=$1", [image.category_key])).rows[0];
    const next = Number(cat.count) + 1;
    await adjustCategoryCount(client, image.category_key, 1);
    await client.query(
      "UPDATE metadata SET status='ready', deleted_at=NULL, category_index=$2, index_key=$3, updated_at=now() WHERE id=$1",
      [id, next, indexKey(image.category_key, next)]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await bumpFolder(image.category_key, 1);
  return { status: "restored", image };
}
