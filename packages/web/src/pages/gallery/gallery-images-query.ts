import { queryOptions } from "@tanstack/react-query";
import type { PublicImageListResponseDto } from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { imageBatchTier } from "../../lib/gallery/image-browse.js";
import type { GalleryCompactGeometry } from "./compact-masonry-layout.js";

export function galleryInitialBatchLimit(
  geometry: GalleryCompactGeometry,
  height: number,
  device: string
) {
  const width = Math.max(1, (geometry.contentWidth - geometry.gap * (geometry.columnCount - 1)) / geometry.columnCount);
  const ratio = device === "mb" ? 16 / 9 : 9 / 16;
  const required = geometry.columnCount * Math.ceil(height * 2 / (width * ratio + geometry.gap));
  return imageBatchTier(required, [60, 120, 180]);
}

export function galleryImagePageQueryOptions(
  imageQuery: string,
  cursor: string,
  dataRevision: number,
  queryScope: string,
  limit = 60,
  forceValidation = false
) {
  return queryOptions({
    queryKey: [
      ...queryKeys.publicImages,
      imageQuery,
      queryScope,
      dataRevision,
      "window-page",
      limit,
      cursor || "$initial"
    ] as const,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(imageQuery);
      if (cursor) params.set("cursor", cursor);
      params.set("limit", String(limit));
      params.sort();
      return api<PublicImageListResponseDto>(
        `/api/images?${params}`,
        { signal, ...(forceValidation ? { cache: "no-cache" as const } : {}) }
      );
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false
  });
}
