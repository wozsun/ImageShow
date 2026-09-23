import { useLayoutEffect, useRef } from "react";
import type { GalleryStatsDto } from "@imageshow/shared/browser";
import { useGalleryStats } from "../lib/api/site-queries.js";

/** Each mounted filter owns its displayed snapshot; query caching stays with useGalleryStats. */
export function usePublicFilterStats(search: string, enabled = true) {
  const query = useGalleryStats(search, enabled);
  const lastSuccessful = useRef<GalleryStatsDto | undefined>(undefined);
  useLayoutEffect(() => {
    if (query.data && !query.isPlaceholderData && !query.isError) {
      lastSuccessful.current = query.data;
    }
  }, [query.data, query.isPlaceholderData, query.isError]);
  const isUpdating = query.isPending || query.isPlaceholderData || query.isFetching;
  return {
    ...query,
    displayData: query.data ?? lastSuccessful.current,
    isUpdating,
    availabilityUnverified: isUpdating || query.isError
  };
}
