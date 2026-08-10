import type { z } from "zod";
import type {
  PublicImageDetailDto,
  PublicImageListResponseDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { ApiError } from "../../core/api-error.ts";
import { coalesce } from "../../core/coalesce.ts";
import {
  publicReadUsesFallbackAdmission,
  queryForPublicRead
} from "../../core/public-query-gateway.ts";
import { listQuery } from "../../core/validation.ts";
import { resolveImageFilterPlan } from "../filter-plan.ts";
import {
  readReadyImageById,
  readReadyImagePage
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

export async function listPublicImages(
  query: PublicListQuery,
  signal?: AbortSignal
): Promise<PublicImageListResponseDto> {
  const limit = query.limit ?? getRuntimeConfig().site.gallery.default_limit;
  const plan = await resolveImageFilterPlan(query);
  const cached = await readReadyImagePage(plan, limit, query.cursor, signal);
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
  const load = async () => {
    const { params, where } = buildResolvedReadyImageListFilters(plan);
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
  };
  const payload = publicReadUsesFallbackAdmission()
    ? await load()
    : await coalesce(`public-images:postgres:${fallbackKey}`, load);
  return withShuffle(query, payload);
}

export async function getPublicImage(id: string): Promise<PublicImageDetailDto> {
  const cached = await readReadyImageById(id);
  if (cached.cached) {
    if (!cached.value) throw new ApiError(404, "not_found", "Image not found");
    return publicImageDetail({ ...cached.value, status: "ready" });
  }

  const load = async () => {
    const result = await queryForPublicRead(
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
  };
  return publicReadUsesFallbackAdmission()
    ? load()
    : coalesce(`public-image:postgres:${id}`, load);
}
