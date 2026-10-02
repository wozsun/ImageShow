import type {
  Brightness,
  Device,
  PublicImageDetailDto,
  PublicImageListResponseDto,
  PublicImageOrder,
  PublicImageView
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import {
  withPublicDatabaseRead,
  type PublicDatabaseReadAccess
} from "../../core/database/public-fallback.ts";
import { resolveImageFilterPlan } from "../filter-plan.ts";
import { createImageBrowseContext, decodeImageCursor } from "../cursor.ts";
import {
  readReadyImageById,
  readReadyImageCursorPage
} from "../ready-cache/query.ts";
import {
  publicImageCardsWithTags,
  publicShowImageCards,
  publicImageDetail,
  imageTagsPresentationColumn,
  type PublicImageDetailRecord
} from "../presenter.ts";
import { buildResolvedReadyImageListFilters } from "./list-filters.ts";
import { fetchPublicImageCardPage, type PublicImagePageRows } from "./pagination.ts";

export type PublicImageListQuery = {
  status: "ready";
  device?: Device;
  brightness?: Brightness;
  theme?: string;
  tag?: string | string[];
  author?: string;
  cursor?: string;
  limit: number;
  view: PublicImageView;
  order?: PublicImageOrder;
};

async function listPublicImageRowsWithAccess(
  query: PublicImageListQuery,
  signal: AbortSignal,
  database: PublicDatabaseReadAccess,
  now: number
): Promise<PublicImagePageRows> {
  const limit = query.limit;
  const order = query.order ?? "latest";
  const plan = await resolveImageFilterPlan(query, database);
  const context = createImageBrowseContext(order, now);
  const position =
    query.cursor === undefined
      ? undefined
      : decodeImageCursor(query.cursor, context);
  const cached = await readReadyImageCursorPage(
    plan,
    limit,
    context,
    position,
    signal
  );
  if (cached.status === "hit") {
    return {
      view: query.view,
      rows: cached.value.items,
      nextCursor: cached.value.nextCursor
    };
  }

  const { params, where } = buildResolvedReadyImageListFilters(plan);
  return fetchPublicImageCardPage(
    where,
    params,
    limit,
    context,
    query.view,
    position,
    database.reader
  );
}

export async function listPublicImages(
  query: PublicImageListQuery,
  signal: AbortSignal,
  now = Date.now()
): Promise<PublicImageListResponseDto<PublicImageView>> {
  const page = await withPublicDatabaseRead(signal, (database, databaseSignal) =>
    listPublicImageRowsWithAccess(query, databaseSignal, database, now)
  );
  // Release the image read scope before the registry acquires its shared scope.
  return {
    items:
      page.view === "show"
        ? await publicShowImageCards(page.rows, { mode: "public", signal })
        : await publicImageCardsWithTags(page.rows, { mode: "public", signal }),
    next_cursor: page.nextCursor
  };
}

async function getPublicImageRecordWithAccess(
  id: string,
  database: PublicDatabaseReadAccess
): Promise<PublicImageDetailRecord> {
  const cached = await readReadyImageById(id);
  if (cached.cached) {
    if (!cached.value) throw new ApiError(404, "not_found", "Image not found");
    return cached.value;
  }

  const result = await database.reader.query(
    `SELECT id,
            storage_slug,
            description,
            source,
            original,
            device, author, brightness, theme, image_time,
            ${imageTagsPresentationColumn}
       FROM metadata
      WHERE id=$1 AND status='ready'
      LIMIT 1`,
    [id]
  );
  if (!result.rows[0]) throw new ApiError(404, "not_found", "Image not found");
  return result.rows[0] as PublicImageDetailRecord;
}

export async function getPublicImage(
  id: string,
  view: PublicImageView,
  signal: AbortSignal,
  includeOriginal = false
): Promise<PublicImageDetailDto<PublicImageView>> {
  const row = await withPublicDatabaseRead(signal, (database) =>
    getPublicImageRecordWithAccess(id, database)
  );
  return publicImageDetail(row, view, { mode: "public", signal }, includeOriginal);
}
