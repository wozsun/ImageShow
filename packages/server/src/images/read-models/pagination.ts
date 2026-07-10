import { pool } from "../../core/db.ts";
import { decodeImageCursor, encodeImageCursor } from "../cursor.ts";
import {
  publicImageCards,
  publicImages,
  type ImageRecord,
  type PublicImageCardRecord
} from "../presenter.ts";

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
  "is_link",
  "title",
  "image_time",
  "status"
].join(", ");

async function fetchImageRows(
  where: string[],
  params: unknown[],
  limit: number,
  cursor: string | undefined,
  columns: string
) {
  if (cursor) {
    const decoded = decodeImageCursor(cursor);
    params.push(decoded.imageTime, decoded.id);
    where.push(
      `(image_time, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
    );
  }
  params.push(limit + 1);
  const result = await pool.query(
    `SELECT ${columns}, image_time::text AS cursor_image_time
     FROM metadata
     WHERE ${where.join(" AND ")}
     ORDER BY image_time DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  const visibleRows = result.rows.slice(0, limit) as Array<{
    id: string;
    cursor_image_time: string;
  }>;
  const hasNext = result.rows.length > limit;
  const last = visibleRows.at(-1);
  return {
    rows: visibleRows,
    hasNext,
    nextCursor: hasNext && last ? encodeImageCursor(last) : null
  };
}

export async function fetchAdminImagePage(
  where: string[],
  params: unknown[],
  limit: number,
  cursor?: string
) {
  const page = await fetchImageRows(where, params, limit, cursor, "*");
  const rows = page.rows as Array<ImageRecord & { cursor_image_time: string }>;
  const items = await publicImages(rows);
  return { rows, items, hasNext: page.hasNext, nextCursor: page.nextCursor };
}

export async function fetchPublicImageCardPage(
  where: string[],
  params: unknown[],
  limit: number,
  cursor?: string
) {
  const page = await fetchImageRows(
    where,
    params,
    limit,
    cursor,
    publicImageCardColumns
  );
  const rows = page.rows as Array<PublicImageCardRecord & { cursor_image_time: string }>;
  const items = await publicImageCards(rows);
  return { rows, items, hasNext: page.hasNext, nextCursor: page.nextCursor };
}
