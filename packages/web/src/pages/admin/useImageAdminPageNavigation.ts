import {
  useCallback,
  useEffect,
  useState
} from "react";
import { useQuery } from "@tanstack/react-query";
import type { ImageAdminFilterValues } from "./ImageAdminFilters.js";
import type { ImageAdminView } from "./useImageAdminOperations.js";
import {
  adminImageListQuery,
  effectiveImageAdminPage,
  imageAdminPaginationScopeKey,
  imageAdminTotalPages,
  type ImageAdminPageState
} from "./image-admin-list-query.js";

/** Owns exactly one numeric-page query for the current admin image scope. */
export function useImageAdminPageNavigation({
  view,
  filters,
  pageSize,
  enabled
}: {
  view: ImageAdminView;
  filters: ImageAdminFilterValues;
  pageSize: number;
  enabled: boolean;
}) {
  const scopeKey = imageAdminPaginationScopeKey(view, filters, pageSize);
  const [state, setState] = useState<ImageAdminPageState>({
    scopeKey,
    page: 1,
    total: null,
    totalUpdatedAt: 0
  });
  const pageNumber = effectiveImageAdminPage(state, scopeKey);
  const query = useQuery({
    ...adminImageListQuery(
      view,
      filters,
      scopeKey,
      pageNumber,
      pageSize
    ),
    enabled
  });
  // Total belongs to the normalized scope, not to one numeric page. Keep the
  // newest successful scope snapshot while the target page has no data yet.
  // Millisecond timestamp ties only win after this observer sees a success.
  const retainedTotal = state.scopeKey === scopeKey ? state.total : null;
  const retainedTotalUpdatedAt = state.scopeKey === scopeKey
    ? state.totalUpdatedAt
    : 0;
  const currentQueryFetchedSuccessfully = query.isFetchedAfterMount
    && !query.isError;
  const currentQueryHasLatestTotal = query.data !== undefined
    && (
      retainedTotal === null
      || query.dataUpdatedAt > retainedTotalUpdatedAt
      || currentQueryFetchedSuccessfully
    );
  const queryTotal = currentQueryHasLatestTotal ? query.data.total : null;
  const total = queryTotal ?? retainedTotal ?? 0;
  const totalPages = imageAdminTotalPages(total, pageSize);

  useEffect(() => {
    setState((current) => current.scopeKey === scopeKey
      ? current
      : {
          scopeKey,
          page: 1,
          total: null,
          totalUpdatedAt: 0
        });
  }, [scopeKey]);

  useEffect(() => {
    if (queryTotal === null) return;
    const successfulTotalPages = imageAdminTotalPages(queryTotal, pageSize);
    setState((current) => {
      if (
        current.scopeKey !== scopeKey
        || (
          current.total !== null
          && query.dataUpdatedAt <= current.totalUpdatedAt
          && !currentQueryFetchedSuccessfully
        )
      ) return current;
      const nextPage = Math.min(current.page, successfulTotalPages);
      if (
        current.page === nextPage
        && current.total === queryTotal
        && current.totalUpdatedAt === query.dataUpdatedAt
      ) return current;
      return {
        scopeKey,
        page: nextPage,
        total: queryTotal,
        totalUpdatedAt: query.dataUpdatedAt
      };
    });
  }, [
    currentQueryFetchedSuccessfully,
    pageSize,
    query.dataUpdatedAt,
    queryTotal,
    scopeKey
  ]);

  const loadPage = useCallback((targetPage: number, blocked: boolean) => {
    if (
      blocked
      || !Number.isSafeInteger(targetPage)
      || targetPage < 1
      || targetPage > totalPages
      || targetPage === pageNumber
    ) return;
    setState((current) => ({
      scopeKey,
      page: targetPage,
      total: current.scopeKey === scopeKey ? current.total : null,
      totalUpdatedAt: current.scopeKey === scopeKey
        ? current.totalUpdatedAt
        : 0
    }));
  }, [pageNumber, scopeKey, totalPages]);

  return {
    items: query.data?.items ?? [],
    hasCurrentPageData: query.data !== undefined,
    total,
    error: query.error,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: query.refetch,
    scopeKey,
    pageNumber,
    totalPages,
    loadPage
  };
}
