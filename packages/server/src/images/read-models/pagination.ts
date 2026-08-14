import {
  pool,
  type DatabaseReader
} from "../../core/database-pools.ts";
import { decodeImageCursor, encodeImageCursor } from "../cursor.ts";
import {
  adminImageListPresentationColumns,
  adminImageListPresentationColumnsWithTags,
  publicImageCards,
  type ImageRecordWithTags,
  type PublicImageCardRecord
} from "../presenter.ts";
import type { PageWindow } from "../page-window.ts";

const publicImageCardColumns = [
  "id",
  "device",
  "brightness",
  "theme",
  "width",
  "height",
  "ext",
  "object_key",
  "storage_slug",
  "author",
  "title",
  "original",
  "image_time",
  "status"
].join(", ");

type ImageRowPosition =
  | { kind: "cursor"; cursor?: string; limit: number }
  | { kind: "offset"; window: PageWindow };

type DeferredProjection = {
  sourceColumns: string;
};

async function fetchImageRows<Row>(
  where: string[],
  params: unknown[],
  columns: string,
  reader: DatabaseReader,
  position: ImageRowPosition,
  deferredProjection?: DeferredProjection
) {
  if (position.kind === "cursor" && position.cursor !== undefined) {
    const decoded = decodeImageCursor(position.cursor);
    params.push(decoded.imageTime, decoded.id);
    where.push(
      `(image_time, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
    );
  }
  const cursorPosition = position.kind === "cursor";
  if (cursorPosition) {
    params.push(position.limit + 1);
  } else {
    params.push(position.window.limit, position.window.start);
  }
  const limitParameter = cursorPosition ? params.length : params.length - 1;
  const offsetClause = cursorPosition ? "" : ` OFFSET $${params.length}`;
  const orderedWindow = `FROM metadata
     WHERE ${where.join(" AND ")}
     ORDER BY image_time DESC, id DESC
     LIMIT $${limitParameter}${offsetClause}`;
  const sql = deferredProjection && !cursorPosition
    ? `SELECT ${columns}
         FROM (
           SELECT ${deferredProjection.sourceColumns}
             ${orderedWindow}
         ) metadata
        ORDER BY image_time DESC, id DESC`
    : `SELECT ${columns}${cursorPosition ? ", image_time::text AS cursor_image_time" : ""}
       ${orderedWindow}`;
  const result = await reader.query(sql, params);
  const limit = cursorPosition ? position.limit : position.window.limit;
  const visibleRows = result.rows.slice(0, limit) as Row[];
  const hasNext = cursorPosition && result.rows.length > limit;
  const last = visibleRows.at(-1) as (Row & {
    id: string;
    cursor_image_time: string;
  }) | undefined;
  return {
    rows: visibleRows,
    hasNext,
    nextCursor: cursorPosition && hasNext && last
      ? encodeImageCursor(last)
      : null
  };
}

export async function fetchAdminImageOffsetRows(
  where: string[],
  params: unknown[],
  window: PageWindow,
  reader: DatabaseReader = pool
) {
  const page = await fetchImageRows<ImageRecordWithTags>(
    where,
    params,
    adminImageListPresentationColumnsWithTags,
    reader,
    { kind: "offset", window },
    { sourceColumns: adminImageListPresentationColumns }
  );
  return page.rows;
}

export async function fetchPublicImageCardPage(
  where: string[],
  params: unknown[],
  limit: number,
  cursor?: string,
  reader: DatabaseReader = pool
) {
  const page = await fetchImageRows<
    PublicImageCardRecord & { cursor_image_time: string }
  >(
    where,
    params,
    publicImageCardColumns,
    reader,
    { kind: "cursor", cursor, limit }
  );
  const rows = page.rows;
  const items = await publicImageCards(rows, reader);
  return { rows, items, nextCursor: page.nextCursor };
}
