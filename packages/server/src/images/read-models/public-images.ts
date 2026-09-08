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
import { fetchPublicImageCardPage } from "./pagination.ts";

export type PublicImageListQuery = {
  status: "ready";
  device?: Device;
  brightness?: Brightness;
  theme?: string;
  tag?: string;
  author?: string;
  cursor?: string;
  limit: number;
  view: PublicImageView;
  order?: PublicImageOrder;
};

async function listPublicImagesWithAccess(
  query: PublicImageListQuery,
  signal: AbortSignal | undefined,
  database: PublicDatabaseReadAccess,
  now: number
): Promise<PublicImageListResponseDto<PublicImageView>> {
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
      items: query.view === "show"
        ? await publicShowImageCards(cached.value.items, database)
        : await publicImageCardsWithTags(cached.value.items, database),
      next_cursor: cached.value.nextCursor
    };
  }

  const fallbackKey = JSON.stringify({ ...query, limit, context });
  const load = async (reader: DatabaseReader) => {
    const { params, where } = buildResolvedReadyImageListFilters(plan);
    const page = await fetchPublicImageCardPage(
      where,
      params,
      limit,
      context,
      query.view,
      position,
      reader
    );
    return {
      items: page.items,
      next_cursor: page.nextCursor
    } satisfies PublicImageListResponseDto<PublicImageView>;
  };
  const payload = database.reader
    ? await load(database.reader)
    : await coalesce(
        `public-images:postgres:${fallbackKey}`,
        () => load(pool)
      );
  return payload;
}

export function listPublicImages(
  query: PublicImageListQuery,
  signal?: AbortSignal,
  now = Date.now()
): Promise<PublicImageListResponseDto<PublicImageView>> {
  return signal
    ? withPublicDatabaseRead(signal, (database, databaseSignal) => (
        listPublicImagesWithAccess(query, databaseSignal, database, now)
      ))
    : listPublicImagesWithAccess(query, undefined, {}, now);
}

async function getPublicImageWithAccess(
  id: string,
  database: PublicDatabaseReadAccess
): Promise<PublicImageDetailDto> {
  const cached = await readReadyImageById(id);
  if (cached.cached) {
    if (!cached.value) throw new ApiError(404, "not_found", "Image not found");
    return publicImageDetail(cached.value, database);
  }

  const load = async (reader: DatabaseReader) => {
    const result = await reader.query(
      `SELECT id,
              object_key,
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
    return publicImageDetail(
      result.rows[0] as PublicImageDetailRecord,
      { reader }
    );
  };
  return database.reader
    ? load(database.reader)
    : coalesce(`public-image:postgres:${id}`, () => load(pool));
}

export function getPublicImage(
  id: string,
  signal?: AbortSignal
): Promise<PublicImageDetailDto> {
  return signal
    ? withPublicDatabaseRead(signal, (database) => (
        getPublicImageWithAccess(id, database)
      ))
    : getPublicImageWithAccess(id, {});
}
