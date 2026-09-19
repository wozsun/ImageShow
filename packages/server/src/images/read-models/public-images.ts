import type {
  Brightness,
  Device,
  PublicImageDetailDto,
  PublicImageListResponseDto,
  PublicImageOrder,
  PublicImageView
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { coalesce } from "../../core/coalesce.ts";
import {
  withPublicDatabaseRead,
  type PublicDatabaseReadAccess
} from "../../core/database/public-fallback.ts";
import { pool, type DatabaseReader } from "../../core/database/pools.ts";
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
  signal: AbortSignal | undefined,
  database: PublicDatabaseReadAccess,
  now: number
): Promise<PublicImagePageRows> {
  const limit = query.limit;
  const order = query.order ?? "latest";
  const plan = await resolveImageFilterPlan(query, database);
  const context = createImageBrowseContext(order, now);
  const position = query.cursor === undefined
    ? undefined : decodeImageCursor(query.cursor, context);
  const cached = await readReadyImageCursorPage(
    plan,
    limit,
    context,
    position,
    signal,
    Boolean(database.reader)
  );
  if (cached.status === "hit") {
    return {
      view: query.view,
      rows: cached.value.items,
      nextCursor: cached.value.nextCursor
    };
  }

  const fallbackKey = JSON.stringify({ ...query, limit, context });
  const load = async (reader: DatabaseReader) => {
    const { params, where } = buildResolvedReadyImageListFilters(plan);
    return fetchPublicImageCardPage(
      where,
      params,
      limit,
      context,
      query.view,
      position,
      reader
    );
  };
  const payload = database.reader
    ? await load(database.reader)
    : await coalesce(
        `public-images:postgres:${fallbackKey}`,
        () => load(pool)
      );
  return payload;
}

export async function listPublicImages(
  query: PublicImageListQuery,
  signal?: AbortSignal,
  now = Date.now()
): Promise<PublicImageListResponseDto<PublicImageView>> {
  const page = await (signal
    ? withPublicDatabaseRead(signal, (database, databaseSignal) => (
        listPublicImageRowsWithAccess(query, databaseSignal, database, now)
      ))
    : listPublicImageRowsWithAccess(query, undefined, {}, now));
  // Release the image read scope before the registry acquires its shared scope.
  return {
    items: page.view === "show"
      ? await publicShowImageCards(page.rows, { signal })
      : await publicImageCardsWithTags(page.rows, { signal }),
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

  const load = async (reader: DatabaseReader) => {
    const result = await reader.query(
      `SELECT id,
              ext,
              storage_slug,
              description,
              source,
              original,
              author, device, brightness, theme, image_time,
              ${imageTagsPresentationColumn}
         FROM metadata
        WHERE id=$1 AND status='ready'
        LIMIT 1`,
      [id]
    );
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Image not found");
    return result.rows[0] as PublicImageDetailRecord;
  };
  return database.reader
    ? await load(database.reader)
    : await coalesce(`public-image:postgres:${id}`, () => load(pool));
}

export async function getPublicImage(
  id: string,
  signal?: AbortSignal,
  includeOriginal = false
): Promise<PublicImageDetailDto> {
  const row = await (signal
    ? withPublicDatabaseRead(signal, (database) => (
        getPublicImageRecordWithAccess(id, database)
      ))
    : getPublicImageRecordWithAccess(id, {}));
  return publicImageDetail(row, { signal }, includeOriginal);
}
