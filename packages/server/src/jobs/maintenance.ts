import { appConfig } from "@imageshow/shared";
import { pool } from "../core/db.js";
import { logger } from "../core/logger.js";
import { invalidateMd5Cache } from "../core/redis.js";
import { calculateObjectMd5 } from "../images/processing.js";
import { exists } from "../storage/storage.js";

export async function backfillMissingMd5() {
  let lastId = "00000000-0000-0000-0000-000000000000";
  let processed = 0;
  while (true) {
    const rows = (await pool.query(
      `SELECT id, object_key, storage_slug
       FROM metadata
       WHERE status='ready' AND md5='' AND is_link=false AND id > $1::uuid
       ORDER BY id
       LIMIT $2`,
      [lastId, appConfig.md5BackfillBatchSize]
    )).rows as Array<{ id: string; object_key: string; storage_slug: string }>;
    if (!rows.length) {
      if (processed) logger.info(`backfilled md5 for ${processed} images`);
      return { processed };
    }
    for (const row of rows) {
      lastId = row.id;
      try {

        if (!(await exists("objects", row.object_key, row.storage_slug))) continue;
        const md5 = await calculateObjectMd5("objects", row.object_key, row.storage_slug);
        const result = await pool.query(
          "UPDATE metadata SET md5=$2, updated_at=now() WHERE id=$1 AND md5=''",
          [row.id, md5]
        );
        if (result.rowCount) {
          processed += 1;
          await invalidateMd5Cache(md5);
        }
      } catch (error) {
        logger.warn(`failed to backfill md5 for ${row.id}`, error);
      }
    }
  }
}
