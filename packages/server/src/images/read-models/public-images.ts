import type { z } from "zod";
import type {
  PublicImageDetailDto,
  PublicImageListResponseDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { ApiError } from "../../core/api-error.ts";
import { coalesce } from "../../core/coalesce.ts";
import { pool } from "../../core/db.ts";
import { listQuery } from "../../core/validation.ts";
import {
  resolveReadyImageListFilterPlan
} from "../ready-cache/filters.ts";
import {
  readReadyImageById,
  readReadyImagePage
} from "../ready-cache/query.ts";
import {
  publicImageCardsWithTags,
  publicImageDetail,
  type PublicImageDetailRecord
} from "../presenter.ts";
import { buildImageListFilters } from "./list-filters.ts";
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

export async function listPublicImages(
  query: PublicListQuery
): Promise<PublicImageListResponseDto> {
  const limit = query.limit ?? getRuntimeConfig().site.gallery.default_limit;
  const plan = await resolveReadyImageListFilterPlan(query);
  const cached = await readReadyImagePage(plan, limit, query.cursor);
  if (cached.cached) {
    return withShuffle(query, {
      items: await publicImageCardsWithTags(cached.value.items.map((item) => ({
        ...item,
        status: "ready"
      }))),
      next_cursor: cached.value.nextCursor
    });
  }

  const fallbackKey = JSON.stringify({ ...query, limit });
  const payload = await coalesce(`public-images:postgres:${fallbackKey}`, async () => {
    const { params, where } = await buildImageListFilters(query);
    const page = await fetchPublicImageCardPage(
      where,
      params,
      limit,
      query.cursor
    );
    return {
      items: page.items,
      next_cursor: page.nextCursor
    } satisfies PublicImageListResponseDto;
  });
  return withShuffle(query, payload);
}

export async function getPublicImage(id: string): Promise<PublicImageDetailDto> {
  const cached = await readReadyImageById(id);
  if (cached.cached) {
    if (!cached.value) throw new ApiError(404, "not_found", "Image not found");
    return publicImageDetail({ ...cached.value, status: "ready" });
  }

  return coalesce(`public-image:postgres:${id}`, async () => {
    const result = await pool.query(
      `SELECT id,
              device,
              brightness,
              theme,
              ext,
              object_key,
              storage_slug,
              description,
              source,
              original,
              status
         FROM metadata
        WHERE id=$1 AND status='ready'
        LIMIT 1`,
      [id]
    );
    if (!result.rows[0]) throw new ApiError(404, "not_found", "Image not found");
    return publicImageDetail(result.rows[0] as PublicImageDetailRecord);
  });
}
