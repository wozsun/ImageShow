import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/database-pools.ts";
import {
  adminImages,
  adminImageView,
  imagePresentationColumns,
  type ImageRecord
} from "../presenter.ts";

export function getDuplicateImagesByMd5(md5: string) {
  return coalesce(`md5:${md5}`, async () => {
    const rows = await adminImages((await pool.query(
      `SELECT ${imagePresentationColumns}
         FROM metadata
        WHERE md5=$1
        ORDER BY status ASC, created_at DESC
        LIMIT 20`,
      [md5]
    )).rows as ImageRecord[]);
    return rows.map(adminImageView);
  });
}
