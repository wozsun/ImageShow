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
    page: 1
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
  const successfulTotalPages = query.isSuccess
    ? imageAdminTotalPages(query.data.total, pageSize)
    : null;
  const totalPages = successfulTotalPages ?? Math.max(1, pageNumber);

  useEffect(() => {
    setState((current) => current.scopeKey === scopeKey
      ? current
      : { scopeKey, page: 1 });
  }, [scopeKey]);

  useEffect(() => {
    if (
      successfulTotalPages === null
      || pageNumber <= successfulTotalPages
    ) return;
    setState((current) => current.scopeKey === scopeKey
      && current.page > successfulTotalPages
      ? { scopeKey, page: successfulTotalPages }
      : current);
  }, [pageNumber, scopeKey, successfulTotalPages]);

  const loadPage = useCallback((targetPage: number, blocked: boolean) => {
    if (
      blocked
      || !Number.isSafeInteger(targetPage)
      || targetPage < 1
      || targetPage > totalPages
      || targetPage === pageNumber
    ) return;
    setState({ scopeKey, page: targetPage });
  }, [pageNumber, scopeKey, totalPages]);

  return {
    data: query.data,
    items: query.data?.items ?? [],
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
