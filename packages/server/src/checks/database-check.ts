import { appConfig } from "@imageshow/shared";
import { cleanupEmptyCategories, pool, withTransaction } from "../core/db.js";
import { rebuildFolderMap } from "../core/redis.js";

// Temporary high offset applied to category_index during gap repair, so the old indexes sit in
// a disjoint range while rows are renumbered to a dense 1..N — keeps the unique
// (category_key, category_index) index from being transiently violated. Assumes < 1e6 ready
// rows per category.
const REINDEX_TEMP_OFFSET = 1_000_000;

// Reconciles the category counters and category_index sequences against the actual
// ready rows, and lists any stuck/failed background operations.
export async function checkDatabase() {
  const categories = (await pool.query("SELECT c.category_key, c.count, COALESCE(m.count, 0)::int AS actual FROM category c LEFT JOIN (SELECT category_key, count(*) FROM metadata WHERE status='ready' GROUP BY category_key) m USING(category_key) ORDER BY c.category_key")).rows;
  const gaps = (await pool.query(`
    WITH ready AS (
      SELECT category_key, category_index, row_number() OVER (PARTITION BY category_key ORDER BY category_index) AS expected
      FROM metadata
      WHERE status='ready'
    )
    SELECT category_key, category_index, expected
    FROM ready
    WHERE category_index <> expected
    ORDER BY category_key, category_index
  `)).rows;
  const operations = (await pool.query("SELECT id,type,target_id,status,retry_count,error,updated_at FROM operation_log WHERE status IN ('pending','running','failed') ORDER BY updated_at DESC LIMIT $1", [appConfig.operationLog.sampleLimit])).rows;
  return { categories, mismatches: categories.filter((row) => Number(row.count) !== Number(row.actual)), index_gaps: gaps, operations };
}

// Repairs exactly what checkDatabase reports: re-sequences any category_index gaps
// to a dense 1..N per category and resets each category.count to its real ready-row
// count, then drops emptied categories and rebuilds the Redis random pool from the
// repaired rows. Normal operations keep both invariants on their own (deletes backfill
// the index hole, every write adjusts the count), so this is a recovery tool for drift
// left behind by an interrupted operation, not routine upkeep.
export async function repairDatabase() {
  const repaired = await withTransaction(async (client) => {
    // Only categories that actually have a gap are touched. Within each, shift every
    // ready row's index out into a disjoint high range first, then renumber to a dense
    // 1..N in index order — so the unique (category_key, category_index) index is never
    // transiently violated mid-statement (old values stay >1e6 while new ones are 1..N).
    const gapRows = (await client.query(`
      WITH ready AS (
        SELECT id, category_key, category_index,
               row_number() OVER (PARTITION BY category_key ORDER BY category_index) AS expected
        FROM metadata WHERE status='ready'
      )
      SELECT category_key FROM ready WHERE category_index <> expected
    `)).rows as Array<{ category_key: string }>;
    const gapCategories = [...new Set(gapRows.map((row) => row.category_key))];
    if (gapCategories.length) {
      await client.query(
        `UPDATE metadata SET category_index = category_index + ${REINDEX_TEMP_OFFSET} WHERE status='ready' AND category_key = ANY($1::text[])`,
        [gapCategories]
      );
      await client.query(
        `WITH renum AS (
           SELECT id, category_key,
                  row_number() OVER (PARTITION BY category_key ORDER BY category_index) AS new_index
           FROM metadata WHERE status='ready' AND category_key = ANY($1::text[])
         )
         UPDATE metadata m
         SET category_index = r.new_index,
             index_key = m.category_key || '-' || lpad(r.new_index::text, $2, '0'),
             updated_at = now()
         FROM renum r WHERE m.id = r.id`,
        [gapCategories, appConfig.categoryIndexDigits]
      );
    }
    // Reset every drifted counter to its true ready-row count (0 for categories with
    // none left); rowCount is how many were wrong.
    const counts = await client.query(`
      UPDATE category c
      SET count = sub.actual, updated_at = now()
      FROM (
        SELECT cat.category_key, COALESCE(r.cnt, 0)::int AS actual
        FROM category cat
        LEFT JOIN (SELECT category_key, count(*) AS cnt FROM metadata WHERE status='ready' GROUP BY category_key) r
          ON r.category_key = cat.category_key
      ) sub
      WHERE c.category_key = sub.category_key AND c.count <> sub.actual
    `);
    return { index_gaps_fixed: gapRows.length, counts_fixed: counts.rowCount ?? 0 };
  });
  await cleanupEmptyCategories();
  await rebuildFolderMap();
  return repaired;
}

export async function checkTrash() {
  const rows = (await pool.query("SELECT id, object_key, deleted_at FROM metadata WHERE status='deleted' ORDER BY deleted_at ASC LIMIT $1", [appConfig.trashBatchSize])).rows;
  return { deleted_count: rows.length, candidates: rows };
}
