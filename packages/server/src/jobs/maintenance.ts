import { pool } from "../core/db.js";
import { invalidateMd5Cache } from "../core/redis.js";
import { calculateObjectMd5 } from "../images/processing.js";
import { exists } from "../storage/storage.js";

// Recomputes md5 for ready images whose md5 column is empty (legacy rows). No
// longer run automatically at startup; invoked on demand from the check page.
export async function backfillMissingMd5() {
  let lastId = "00000000-0000-0000-0000-000000000000";
  let processed = 0;
  while (true) {
    const rows = (await pool.query(
      `SELECT id, object_key
       FROM metadata
       WHERE status='ready' AND md5='' AND id > $1::uuid
       ORDER BY id
       LIMIT 100`,
      [lastId]
    )).rows as Array<{ id: string; object_key: string }>;
    if (!rows.length) {
      if (processed) console.log(`Backfilled md5 for ${processed} images`);
      return { processed };
    }
    for (const row of rows) {
      lastId = row.id;
      try {
        if (!(await exists("objects", row.object_key))) continue;
        const md5 = await calculateObjectMd5("objects", row.object_key);
        const result = await pool.query(
          "UPDATE metadata SET md5=$2, updated_at=now() WHERE id=$1 AND md5=''",
          [row.id, md5]
        );
        if (result.rowCount) {
          processed += 1;
          await invalidateMd5Cache(md5);
        }
      } catch (error) {
        console.warn(`Failed to backfill md5 for ${row.id}`, error);
      }
    }
  }
}
