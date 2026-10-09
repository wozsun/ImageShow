import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/database/pools.ts";
import {
  adminImageListItemsWithTags,
  adminImageListPresentationColumns,
  adminImageListPresentationColumnsWithTags,
  type ImageRecordWithTags
} from "../presenter.ts";

type DuplicateSnapshotRow = ImageRecordWithTags & {
  l_md5: string;
  duplicate_match_count: string | number;
};

export async function readDuplicateSnapshotsByMd5(md5s: readonly string[]) {
  if (!md5s.length)
    return new Map<
      string,
      {
        matchCount: number;
        items: Awaited<ReturnType<typeof adminImageListItemsWithTags>>;
      }
    >();
  const rows = (
    await pool.query(
      `WITH ranked AS (
       SELECT ${adminImageListPresentationColumnsWithTags}, l_md5,
              count(*) OVER (PARTITION BY l_md5) AS duplicate_match_count,
              row_number() OVER (
                PARTITION BY l_md5
                ORDER BY status ASC, created_at DESC
              ) AS duplicate_rank
         FROM metadata
        WHERE l_md5 = ANY($1::text[])
          AND status = 'ready'
     )
     SELECT ${adminImageListPresentationColumns}, l_md5, purge_pending, tags, duplicate_match_count
       FROM ranked
      WHERE duplicate_rank <= 20
      ORDER BY l_md5 ASC, duplicate_rank ASC`,
      [md5s]
    )
  ).rows as DuplicateSnapshotRow[];
  const presented = await adminImageListItemsWithTags(rows);
  const result = new Map(
    md5s.map((md5) => [
      md5,
      {
        matchCount: 0,
        items: [] as typeof presented
      }
    ])
  );
  presented.forEach((item, index) => {
    const row = rows[index]!;
    const snapshot = result.get(row.l_md5);
    if (!snapshot) return;
    snapshot.matchCount = Number(row.duplicate_match_count);
    snapshot.items.push(item);
  });
  return result;
}

export async function readDuplicateMatchCountsByMd5(md5s: readonly string[]) {
  const result = new Map(md5s.map((md5) => [md5, 0]));
  if (!md5s.length) return result;
  const rows = (
    await pool.query(
      `SELECT l_md5, count(*)::bigint AS duplicate_match_count
       FROM metadata
      WHERE l_md5 = ANY($1::text[])
        AND status = 'ready'
      GROUP BY l_md5`,
      [md5s]
    )
  ).rows as Array<{
    l_md5: string;
    duplicate_match_count: string | number;
  }>;
  for (const row of rows) {
    result.set(row.l_md5, Number(row.duplicate_match_count));
  }
  return result;
}

export async function readDuplicateSnapshotByMd5(md5: string) {
  return (await readDuplicateSnapshotsByMd5([md5])).get(md5)!;
}

export function getDuplicateMatchCountByMd5(md5: string) {
  return coalesce(`md5-count:${md5}`, async () =>
    (await readDuplicateMatchCountsByMd5([md5])).get(md5)!
  );
}
