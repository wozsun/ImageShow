import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient
} from "@tanstack/react-query";
import type {
  AdminOverviewDto,
  ReadyImageCacheAdminStatusDto
} from "@imageshow/shared/browser";
import { adminApiBasePath } from "../constants.js";
import { api } from "./client.js";
import { queryKeys } from "./query-keys.js";
import {
  readyImageCacheRefetchInterval
} from "./ready-image-cache-polling.js";

export const readyImageCachePath = `${adminApiBasePath}/cache/ready-images`;

function reconcileOverviewAfterStatus(
  client: QueryClient,
  status: ReadyImageCacheAdminStatusDto
) {
  if (status.rebuilding) {
    // A rebuild changes the Redis metric without changing the other overview
    // fields. Preserve the cached DTO and only mark it stale for its next owner.
    void client.invalidateQueries({
      queryKey: queryKeys.overview,
      exact: true,
      refetchType: "none"
    });
    return;
  }

  const overviewState = client.getQueryState<AdminOverviewDto>(
    queryKeys.overview
  );
  if (
    overviewState?.isInvalidated
    || overviewState?.data?.redis_cache.rebuilding
  ) {
    // Active overview observers converge once when a rebuild finishes. An
    // inactive query stays invalidated and will refresh when it is next shown.
    void client.invalidateQueries({
      queryKey: queryKeys.overview,
      exact: true,
      refetchType: "active"
    });
  }
}

export function useReadyImageCacheStatus(
  options: { enabled?: boolean; refreshAfter?: number } = {}
) {
  const { enabled = true, refreshAfter = 0 } = options;
  const client = useQueryClient();
  const query = useQuery<ReadyImageCacheAdminStatusDto>({
    queryKey: queryKeys.readyImageCache,
    queryFn: ({ signal }) => api(readyImageCachePath, { signal }),
    retry: false,
    staleTime: 0,
    enabled,
    refetchInterval: (query) => readyImageCacheRefetchInterval(
      query,
      refreshAfter
    )
  });

  useEffect(() => {
    if (query.isSuccess && query.isFetchedAfterMount) {
      reconcileOverviewAfterStatus(client, query.data);
    }
  }, [client, query.data, query.isFetchedAfterMount, query.isSuccess]);

  return query;
}
