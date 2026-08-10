import { queryOptions } from "@tanstack/react-query";
import type { PublicImageListResponseDto } from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { queryKeys } from "../../lib/api/query-keys.js";

export function galleryImagePageQueryOptions(
  imageQuery: string,
  cursor: string
) {
  return queryOptions({
    queryKey: [
      ...queryKeys.publicImages,
      imageQuery,
      "window-page",
      cursor || "$initial"
    ] as const,
    queryFn: ({ signal }) => {
      const params = new URLSearchParams(imageQuery);
      if (cursor) params.set("cursor", cursor);
      return api<PublicImageListResponseDto>(
        `/api/images?${params}`,
        { signal }
      );
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false
  });
}
