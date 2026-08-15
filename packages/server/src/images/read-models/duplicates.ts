import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/database-pools.ts";
import {
  adminImageListItems,
  adminImageListPresentationColumns,
  type ImageRecord
} from "../presenter.ts";

type DuplicateSnapshotRow = ImageRecord & {
  duplicate_match_count: string | number;
};

export async function readDuplicateSnapshotByMd5(md5: string) {
  const rows = (await pool.query(
    `SELECT ${adminImageListPresentationColumns},
            count(*) OVER () AS duplicate_match_count
       FROM metadata
      WHERE md5=$1
      ORDER BY status ASC, created_at DESC
      LIMIT 20`,
    [md5]
  )).rows as DuplicateSnapshotRow[];
  return {
    matchCount: Number(rows[0]?.duplicate_match_count ?? 0),
    items: await adminImageListItems(rows)
  };
}

export function getDuplicateSnapshotByMd5(md5: string) {
  return coalesce(`md5:${md5}`, () => readDuplicateSnapshotByMd5(md5));
}
