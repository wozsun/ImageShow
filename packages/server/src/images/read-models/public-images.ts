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
  getPublicImageDetailCache,
  getImageLookupById,
  getPublicImagesCache,
  publicImagesCacheGeneration,
  setPublicImageDetailCache,
  setPublicImagesCache,
  warmCompleteImageLookups,
  warmObjectLookups
} from "../image-cache.ts";
import {
  publicImageDetail,
  type PublicImageDetailRecord
} from "../presenter.ts";
import { buildImageListFilters } from "./list-filters.ts";
import { fetchPublicImageCardPage } from "./pagination.ts";

type PublicListQuery = z.infer<typeof listQuery>;
function publicImageListCacheKey(q: {
  status: string;
  d?: string;
  b?: string;
  t?: string;
  tag?: string;
  a?: string;
  cursor?: string;
  limit: number;
}) {
  return [
    `status=${q.status}`,
    `d=${q.d ?? ""}`,
    `b=${q.b ?? ""}`,
    `t=${q.t ?? ""}`,
    `tag=${q.tag ?? ""}`,
    `a=${q.a ?? ""}`,
    `cursor=${q.cursor ?? ""}`,
    `limit=${q.limit}`
  ].map((part) => encodeURIComponent(part)).join("&");
}

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
  const generation = await publicImagesCacheGeneration();
  const cacheKey = publicImageListCacheKey({
    ...query,
    limit
  });
  const cached = await getPublicImagesCache<PublicImageListResponseDto>(
    cacheKey,
    generation
  );
  if (cached) return withShuffle(query, cached);

  const payload = await coalesce(
    `public-images:${generation ?? "uncached"}:${cacheKey}`,
    async () => {
      const raced = await getPublicImagesCache<PublicImageListResponseDto>(
        cacheKey,
        generation
      );
      if (raced) return raced;

      const { params, where } = await buildImageListFilters(query);

      const page = await fetchPublicImageCardPage(where, params, limit, query.cursor);
      const fresh: PublicImageListResponseDto = {
        items: page.items,
        next_cursor: page.nextCursor
      };
      await Promise.all([
        warmObjectLookups(page.rows, generation),
        setPublicImagesCache(cacheKey, fresh, generation)
      ]);
      return fresh;
    }
  );
  return withShuffle(query, payload);
}

export async function getPublicImage(id: string): Promise<PublicImageDetailDto> {
  const generation = await publicImagesCacheGeneration();
  const cacheKey = id;
  const cached = await getPublicImageDetailCache<PublicImageDetailDto>(
    cacheKey,
    generation
  );
  if (cached) return cached;

  return coalesce(
    `public-image:${generation ?? "uncached"}:${cacheKey}`,
    async () => {
      const raced = await getPublicImageDetailCache<PublicImageDetailDto>(
        cacheKey,
        generation
      );
      if (raced) return raced;

      const lookup = await getImageLookupById(id, generation);
      if (lookup?.status === "ready") {
        const image = await publicImageDetail(lookup);
        await setPublicImageDetailCache(cacheKey, image, generation);
        return image;
      }

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
      const row = result.rows[0] as PublicImageDetailRecord;
      const image = await publicImageDetail(row);
      await Promise.all([
        warmCompleteImageLookups([row], generation),
        setPublicImageDetailCache(cacheKey, image, generation)
      ]);
      return image;
    }
  );
}
