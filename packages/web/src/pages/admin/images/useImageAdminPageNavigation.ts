import {
  useCallback,
  useState
} from "react";
import { useQuery } from "@tanstack/react-query";
import { defaultAdminImageSort, type AdminImageSort } from "@imageshow/shared/browser";
import type { ImageAdminFilterValues } from "./ImageAdminFilters.js";
import type { ImageAdminView } from "./useImageAdminOperations.js";
import {
  adminImageListQuery,
  effectiveImageAdminPage,
  imageAdminPaginationScopeKey,
  imageAdminTotalPages,
  resolveImageAdminScopeTotal,
  type ImageAdminGroupScope,
  type ImageAdminPageState
} from "./image-admin-list-query.js";

/** Owns exactly one numeric-page query for the current admin image scope. */
export function useImageAdminPageNavigation({
  view,
  filters,
  pageSize,
  sort = defaultAdminImageSort,
  group,
  enabled = true
}: {
  view: ImageAdminView;
  filters: ImageAdminFilterValues;
  pageSize: number;
  sort?: Readonly<AdminImageSort>;
  group?: ImageAdminGroupScope;
  enabled?: boolean;
}) {
  const scopeKey = imageAdminPaginationScopeKey(view, filters, pageSize, sort, group);
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
      pageSize,
      sort,
      group
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
  const { queryTotal, total } = resolveImageAdminScopeTotal({
    retainedTotal,
    retainedUpdatedAt: retainedTotalUpdatedAt,
    queryData: query.data,
    queryUpdatedAt: query.dataUpdatedAt,
    fetchedAfterMount: query.isFetchedAfterMount,
    isSuccess: query.isSuccess
  });
  const totalPages = imageAdminTotalPages(total, pageSize);

  // Adjust the owner before committing this render, so an out-of-range response
  // cannot briefly render an empty gallery before the valid page is requested.
  if (state.scopeKey !== scopeKey) {
    setState({
      scopeKey,
      page: 1,
      total: queryTotal,
      totalUpdatedAt: queryTotal === null ? 0 : query.dataUpdatedAt
    });
  } else if (queryTotal !== null) {
    const nextPage = Math.min(state.page, totalPages);
    if (state.page !== nextPage
      || state.total !== queryTotal
      || state.totalUpdatedAt !== query.dataUpdatedAt) {
      setState({
        scopeKey,
        page: nextPage,
        total: queryTotal,
        totalUpdatedAt: query.dataUpdatedAt
      });
    }
  }

  const loadPage = useCallback(
    (targetPage: number, blocked: boolean) => {
      if (
        blocked ||
        !Number.isSafeInteger(targetPage) ||
        targetPage < 1 ||
        targetPage > totalPages ||
        targetPage === pageNumber
      )
        return;
      setState((current) => ({
        scopeKey,
        page: targetPage,
        total: current.scopeKey === scopeKey ? current.total : null,
        totalUpdatedAt: current.scopeKey === scopeKey
          ? current.totalUpdatedAt
          : 0
      }));
    },
    [pageNumber, scopeKey, totalPages]
  );

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
