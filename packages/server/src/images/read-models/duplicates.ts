import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/database-pools.ts";
import {
  adminImageListItemsWithTags,
  adminImageListPresentationColumns,
  adminImageListPresentationColumnsWithTags,
  type ImageRecordWithTags
} from "../presenter.ts";

type DuplicateSnapshotRow = ImageRecordWithTags & {
  duplicate_match_count: string | number;
};

export async function readDuplicateSnapshotsByMd5(md5s: readonly string[]) {
  if (!md5s.length) return new Map<string, {
    matchCount: number;
    items: Awaited<ReturnType<typeof adminImageListItemsWithTags>>;
  }>();
  const rows = (await pool.query(
    `WITH ranked AS (
       SELECT ${adminImageListPresentationColumnsWithTags},
              count(*) OVER (PARTITION BY md5) AS duplicate_match_count,
              row_number() OVER (
                PARTITION BY md5
                ORDER BY status ASC, created_at DESC
              ) AS duplicate_rank
         FROM metadata
        WHERE md5 = ANY($1::text[])
          AND status = 'ready'
     )
     SELECT ${adminImageListPresentationColumns}, tags, duplicate_match_count
       FROM ranked
      WHERE duplicate_rank <= 20
      ORDER BY md5 ASC, duplicate_rank ASC`,
    [md5s]
  )).rows as DuplicateSnapshotRow[];
  const presented = await adminImageListItemsWithTags(rows);
  const result = new Map(md5s.map((md5) => [md5, {
    matchCount: 0,
    items: [] as typeof presented
  }]));
  presented.forEach((item, index) => {
    const snapshot = result.get(item.md5);
    const row = rows[index];
    if (!snapshot || !row) return;
    snapshot.matchCount = Number(row.duplicate_match_count);
    snapshot.items.push(item);
  });
  return result;
}

export async function readDuplicateMatchCountsByMd5(
  md5s: readonly string[]
) {
  const result = new Map(md5s.map((md5) => [md5, 0]));
  if (!md5s.length) return result;
  const rows = (await pool.query(
    `SELECT md5, count(*)::bigint AS duplicate_match_count
       FROM metadata
      WHERE md5 = ANY($1::text[])
        AND status = 'ready'
      GROUP BY md5`,
    [md5s]
  )).rows as Array<{
    md5: string;
    duplicate_match_count: string | number;
  }>;
  for (const row of rows) {
    result.set(row.md5, Number(row.duplicate_match_count));
  }
  return result;
}

export async function readDuplicateSnapshotByMd5(md5: string) {
  return (await readDuplicateSnapshotsByMd5([md5])).get(md5)!;
}

export function getDuplicateSnapshotByMd5(md5: string) {
  return coalesce(`md5:${md5}`, () => readDuplicateSnapshotByMd5(md5));
}
