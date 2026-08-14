import type { z } from "zod";
import type {
  PublicImageDetailDto,
  PublicImageListResponseDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { ApiError } from "../../core/api-error.ts";
import { coalesce } from "../../core/coalesce.ts";
import {
  withPublicDatabaseRead,
  type PublicDatabaseReadAccess
} from "../../core/public-db-fallback.ts";
import { pool, type DatabaseReader } from "../../core/database-pools.ts";
import { listQuery } from "../../core/validation.ts";
import { resolveImageFilterPlan } from "../filter-plan.ts";
import {
  readReadyImageById,
  readReadyImageCursorPage
} from "../ready-cache/query.ts";
import {
  publicImageCardsWithTags,
  publicImageDetail,
  type PublicImageDetailRecord
} from "../presenter.ts";
import { buildResolvedReadyImageListFilters } from "./list-filters.ts";
import { fetchPublicImageCardPage } from "./pagination.ts";

type PublicListQuery = z.infer<typeof listQuery>;

function withShuffle(
  query: PublicListQuery,
  payload: PublicImageListResponseDto
): PublicImageListResponseDto {
  if (!query.shuffle || payload.items.length < 2) return payload;
  const items = [...payload.items];
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }
  return { ...payload, items };
}

async function listPublicImagesWithAccess(
  query: PublicListQuery,
  signal: AbortSignal | undefined,
  database: PublicDatabaseReadAccess
): Promise<PublicImageListResponseDto> {
  const limit = query.limit ?? getRuntimeConfig().site.gallery.default_limit;
  const plan = await resolveImageFilterPlan(query, database);
  const cached = await readReadyImageCursorPage(
    plan,
    limit,
    query.cursor,
    signal,
    Boolean(database.reader)
  );
  if (cached.status === "hit") {
    return withShuffle(query, {
      items: await publicImageCardsWithTags(cached.value.items.map((item) => ({
        ...item,
        status: "ready"
      })), database),
      next_cursor: cached.value.nextCursor
    });
  }

  const fallbackKey = JSON.stringify({ ...query, limit });
  const load = async (reader: DatabaseReader) => {
    const { params, where } = buildResolvedReadyImageListFilters(plan);
    const page = await fetchPublicImageCardPage(
      where,
      params,
      limit,
      query.cursor,
      reader
    );
    return {
      items: page.items,
      next_cursor: page.nextCursor
    } satisfies PublicImageListResponseDto;
  };
  const payload = database.reader
    ? await load(database.reader)
    : await coalesce(
        `public-images:postgres:${fallbackKey}`,
        () => load(pool)
      );
  return withShuffle(query, payload);
}

export function listPublicImages(
  query: PublicListQuery,
  signal?: AbortSignal
): Promise<PublicImageListResponseDto> {
  return signal
    ? withPublicDatabaseRead(signal, (database, databaseSignal) => (
        listPublicImagesWithAccess(query, databaseSignal, database)
      ))
    : listPublicImagesWithAccess(query, undefined, {});
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
              source
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
