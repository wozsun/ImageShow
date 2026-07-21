import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/db.ts";
import { getMd5Cache, imageCacheRevision, setMd5Cache } from "../image-cache.ts";
import {
  adminImageView,
  imagePresentationColumns,
  publicImages,
  type ImageRecord,
  type PublicImage
} from "../presenter.ts";

export async function getDuplicateImagesByMd5(md5: string) {
  const revision = await imageCacheRevision();
  const cached = await getMd5Cache(md5, revision) as PublicImage[] | null;
  if (cached) {
    return cached.map(adminImageView);
  }

  return coalesce(`md5:${revision}:${md5}`, async () => {
    const raced = await getMd5Cache(md5, revision) as PublicImage[] | null;
    if (raced) {
      return raced.map(adminImageView);
    }

    const rows = await publicImages((await pool.query(
      `SELECT ${imagePresentationColumns}
         FROM metadata
        WHERE md5=$1
        ORDER BY status ASC, created_at DESC
        LIMIT 20`,
      [md5]
    )).rows as ImageRecord[]);
    await setMd5Cache(md5, rows, revision);
    return rows.map(adminImageView);
  });
}
