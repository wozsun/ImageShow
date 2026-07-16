import { pool } from "../core/db.ts";
import { syncRandomImage, syncRandomImages } from "../random/random-cache.ts";
import type { ImageRecord } from "./presenter.ts";

type RestoredImage = Pick<ImageRecord, "id" | "object_key" | "md5">;

export type RestoreResult =
  | { status: "restored"; image: RestoredImage }
  | { status: "not_deleted" };

export async function restoreImageFromTrash(id: string): Promise<RestoreResult> {
  const result = await pool.query(
    `UPDATE metadata
        SET status='ready', deleted_at=NULL, updated_at=now()
      WHERE id=$1 AND status='deleted'
      RETURNING id, object_key, md5`,
    [id]
  );
  const image = result.rows[0] as RestoredImage | undefined;
  if (!image) return { status: "not_deleted" };
  await syncRandomImage(id);
  return { status: "restored", image };
}

export async function restoreImagesFromTrash(ids: string[]): Promise<RestoredImage[]> {
  if (!ids.length) return [];
  const result = await pool.query(
    `UPDATE metadata
        SET status='ready', deleted_at=NULL, updated_at=now()
      WHERE id = ANY($1::uuid[]) AND status='deleted'
      RETURNING id, object_key, md5`,
    [ids]
  );
  const images = result.rows as RestoredImage[];
  await syncRandomImages(images.map((image) => image.id));
  return images;
}
