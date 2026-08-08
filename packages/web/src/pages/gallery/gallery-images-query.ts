import {
  infiniteQueryOptions,
  type InfiniteData
} from "@tanstack/react-query";
import type {
  PublicImageListResponseDto
} from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { queryKeys } from "../../lib/api/query-keys.js";

type GalleryImagesQueryKey = readonly [
  ...typeof queryKeys.publicImages,
  string
];

export function galleryImagesQueryOptions(imageQuery: string) {
  return infiniteQueryOptions<
    PublicImageListResponseDto,
    Error,
    InfiniteData<PublicImageListResponseDto, string>,
    GalleryImagesQueryKey,
    string
  >({
    queryKey: [...queryKeys.publicImages, imageQuery] as const,
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams(imageQuery);
      if (pageParam) params.set("cursor", pageParam);
      return api<PublicImageListResponseDto>(
        `/api/images?${params}`,
        { signal }
      );
    },
    getNextPageParam: (lastPage) => lastPage.next_cursor || undefined,
    gcTime: 0,
    // Infinite-query focus refetch replays every retained cursor page. The
    // gallery uses explicit invalidation and forward preloading instead.
    refetchOnWindowFocus: false
  });
}
