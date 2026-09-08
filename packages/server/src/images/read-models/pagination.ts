import { pool, type DatabaseReader } from "../../core/database/pools.ts";
import type { PublicImageView } from "@imageshow/shared/browser";
import {
  encodeImageCursor,
  type ImageBrowseContext,
  type ImageBrowsePosition
} from "../cursor.ts";
import {
  adminImageListPresentationColumns,
  adminImageListPresentationColumnsWithTags,
  imageTagsPresentationColumn,
  publicImageCardsWithTags,
  publicShowImageCards,
  type ImageRecordWithTags,
  type PublicImageCardRecord,
  type PublicShowImageRecord
} from "../presenter.ts";
import type { PageWindow } from "../page-window.ts";

export async function fetchAdminImageOffsetRows(
  where: string[],
  params: unknown[],
  window: PageWindow,
  reader: DatabaseReader = pool
) {
  const result = await reader.query(
    `SELECT ${adminImageListPresentationColumnsWithTags}
       FROM (
         SELECT ${adminImageListPresentationColumns}
           FROM metadata
          WHERE ${where.join(" AND ")}
          ORDER BY image_time DESC, id DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
       ) metadata
      ORDER BY image_time DESC, id DESC`,
    [...params, window.limit, window.start]
  );
  return result.rows as ImageRecordWithTags[];
}

/** Selection and tag hydration share one PostgreSQL statement snapshot. */
export async function fetchPublicImageCardPage(
  where: string[],
  filterParams: unknown[],
  limit: number,
  context: ImageBrowseContext,
  view: PublicImageView,
  position: ImageBrowsePosition | undefined,
  reader: DatabaseReader = pool
) {
  const params = [...filterParams];
  const parameter = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const count = parameter(limit + 1);
  const columns = [
    "id", "title", "width", "height", "object_key", "storage_slug",
    "image_time::text AS cursor_image_time",
    ...(view === "gallery" ? [
      "device", "brightness", "theme", "author", "image_time"
    ] : [])
  ].join(", ");
  let selection: string;
  let ordering: string;
  if (context.order === "random") {
    const start = parameter(context.start.toString(16).padStart(12, "0"));
    const boundary = position
      ? `(right(id::text, 12), id) > (${parameter(position.id.slice(-12))}, ${parameter(position.id)}::uuid)`
      : null;
    const phases = position?.phase === 1 ? [1] : [0, 1];
    selection = phases.map((phase) => {
      const clauses = [
        ...where,
        `right(id::text, 12) ${phase === 0 ? ">=" : "<"} ${start}`,
        ...(boundary && phase === position?.phase ? [boundary] : [])
      ];
      return `(SELECT ${columns}, right(id::text, 12) AS suffix, ${phase} AS phase
                 FROM metadata
                WHERE ${clauses.join(" AND ")}
                ORDER BY right(id::text, 12), id
                LIMIT ${count})`;
    }).join(" UNION ALL ");
    ordering = "phase, suffix, id";
  } else {
    const direction = context.order === "oldest" ? "ASC" : "DESC";
    const comparison = context.order === "oldest" ? ">" : "<";
    const clauses = [...where];
    if (position) clauses.push(
      `(image_time, id) ${comparison} (${parameter(position.imageTime)}::timestamptz, ${parameter(position.id)}::uuid)`
    );
    selection = `SELECT ${columns}, image_time AS sort_time
                   FROM metadata WHERE ${clauses.join(" AND ")}
                  ORDER BY image_time ${direction}, id ${direction} LIMIT ${count}`;
    ordering = `sort_time ${direction}, id ${direction}`;
  }
  const sql = `SELECT metadata.*${view === "gallery" ? `, ${imageTagsPresentationColumn}` : ""}
                 FROM (${selection}) metadata
                ORDER BY ${ordering} LIMIT ${count}`;
  type PositionRow = { id: string; cursor_image_time: string };
  const present = async <Row extends PublicShowImageRecord & PositionRow, Item>(
    format: (rows: Row[]) => Promise<Item[]>
  ) => {
    const result = await reader.query(sql, params);
    const rows = result.rows.slice(0, limit) as Row[];
    const last = rows.at(-1);
    const nextCursor = result.rows.length > limit && last
      ? encodeImageCursor(last, context)
      : null;
    return { rows, nextCursor, items: await format(rows) };
  };
  return view === "show"
    ? present((rows: Array<PublicShowImageRecord & PositionRow>) => (
        publicShowImageCards(rows, { reader })
      ))
    : present((rows: Array<PublicImageCardRecord & PositionRow & { tags: string[] }>) => (
        publicImageCardsWithTags(rows, { reader })
      ));
}
