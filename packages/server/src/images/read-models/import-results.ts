import type { AdminImageListItemDto } from "@imageshow/shared/browser";
import { pool, type DatabaseReader } from "../../core/database-pools.ts";
import {
  adminImageListItemsWithTags,
  adminImageListPresentationColumnsWithTags,
  type ImageRecordWithTags
} from "../presenter.ts";

export type CommittedImportResult = Readonly<{
  image_id: string;
  image_time: string;
  created_by: string;
  item: AdminImageListItemDto;
}>;

export function committedImportResultForOwner(
  results: ReadonlyMap<string, CommittedImportResult>,
  imageId: string,
  owner: string
) {
  const result = results.get(imageId.toLowerCase());
  return result?.created_by === owner ? result : undefined;
}

export async function readCommittedImportResultsByImageIds(
  imageIds: readonly string[],
  reader: DatabaseReader = pool
) {
  const uniqueIds = [...new Set(imageIds.map((imageId) => imageId.toLowerCase()))];
  if (!uniqueIds.length) return new Map<string, CommittedImportResult>();
  const rows = (await reader.query<ImageRecordWithTags & { created_by: string }>(
    `SELECT ${adminImageListPresentationColumnsWithTags}, created_by
       FROM metadata
      WHERE id = ANY($1::uuid[])`,
    [uniqueIds]
  )).rows;
  const items = await adminImageListItemsWithTags(rows);
  const rowsById = new Map(rows.map((row) => [row.id.toLowerCase(), row]));
  return new Map(items.map((item) => [
    item.id.toLowerCase(),
    {
      image_id: item.id.toLowerCase(),
      image_time: new Date(rowsById.get(item.id.toLowerCase())!.image_time)
        .toISOString(),
      created_by: rowsById.get(item.id.toLowerCase())!.created_by,
      item
    }
  ]));
}
