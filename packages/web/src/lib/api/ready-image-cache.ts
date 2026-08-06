import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient
} from "@tanstack/react-query";
import type {
  AdminCheckStatusDto,
  AdminOverviewDto
} from "@imageshow/shared/browser";
import { adminApiBasePath } from "../constants.js";
import { api } from "./client.js";
import { queryKeys } from "./query-keys.js";
import {
  adminCheckStatusRefetchInterval
} from "./ready-image-cache-polling.js";

const adminCheckStatusPath = `${adminApiBasePath}/check/status`;
export const readyImageCacheRebuildPath =
  `${adminApiBasePath}/cache/ready-images/rebuild`;

export function readyImageProjection(status: AdminCheckStatusDto | undefined) {
  return status?.redis.status === "ok"
    ? status.redis.data.image_projection
    : undefined;
}

function reconcileOverviewAfterStatus(
  client: QueryClient,
  status: AdminCheckStatusDto
) {
  const projection = readyImageProjection(status);
  if (!projection) return;
  if (projection.rebuilding) {
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
    void client.invalidateQueries({
      queryKey: queryKeys.overview,
      exact: true,
      refetchType: "active"
    });
  }
}

export function useAdminCheckStatus(
  options: { enabled?: boolean; refreshAfter?: number } = {}
) {
  const { enabled = true, refreshAfter = 0 } = options;
  const client = useQueryClient();
  const query = useQuery<AdminCheckStatusDto>({
    queryKey: queryKeys.adminCheckStatus,
    // Do not consume TanStack Query's AbortSignal here. React Strict Mode
    // briefly unmounts and remounts the owner; keeping this lightweight request
    // alive lets the shared query reuse the same first Promise instead of
    // issuing a duplicate status read.
    queryFn: () => api(adminCheckStatusPath),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled,
    refetchInterval: (query) => adminCheckStatusRefetchInterval(
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
