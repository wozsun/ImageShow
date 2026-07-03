import { pool } from "../core/db.js";
import { syncRandomImage } from "../random/random-cache.js";
import type { ImageRecord } from "../images/presenter.js";

export type RestoreResult =
  | { status: "restored"; image: ImageRecord }
  | { status: "not_deleted" };

export async function restoreImageFromTrash(id: string): Promise<RestoreResult> {
  const result = await pool.query(
    "UPDATE metadata SET status='ready', deleted_at=NULL, updated_at=now() WHERE id=$1 AND status='deleted' RETURNING *",
    [id]
  );
  const image = result.rows[0] as ImageRecord | undefined;
  if (!image) return { status: "not_deleted" };
  await syncRandomImage(id);
  return { status: "restored", image };
}
