import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/db.ts";
import { getMd5Cache, setMd5Cache } from "../image-cache.ts";
import {
  adminImageView,
  publicImages,
  type ImageRecord,
  type PublicImage
} from "../presenter.ts";

export async function getImageDuplicateInfoByMd5(md5: string) {
  const cached = await getMd5Cache(md5) as PublicImage[] | null;
  if (cached) {
    return { md5, exists: cached.length > 0, items: cached.map(adminImageView) };
  }

  return coalesce(`md5:${md5}`, async () => {
    const raced = await getMd5Cache(md5) as PublicImage[] | null;
    if (raced) {
      return { md5, exists: raced.length > 0, items: raced.map(adminImageView) };
    }

    const rows = await publicImages((await pool.query(
      "SELECT * FROM metadata WHERE md5=$1 ORDER BY status ASC, created_at DESC LIMIT 20",
      [md5]
    )).rows as ImageRecord[]);
    await setMd5Cache(md5, rows);
    return { md5, exists: rows.length > 0, items: rows.map(adminImageView) };
  });
}
