import {
  unsetThemeFilter,
  defaultAdminImageSort,
  adminImageListReadStartedAtHeader,
  type AdminImageSort,
  type AdminImageListResponseDto
} from "@imageshow/shared/browser";
import type { QueryClient } from "@tanstack/react-query";
import { apiWithEtag } from "../../../lib/api/client.js";
import { adminApiBasePath } from "../../../lib/constants.js";
import { queryKeys } from "../../../lib/api/query-keys.js";
import {
  recordAdminImageListValidation
} from "../../../lib/api/admin-image-list-validation.js";
import type { ImageAdminFilterValues } from "./ImageAdminFilters.js";
import type { ImageAdminView } from "./useImageAdminOperations.js";

const adminImageListStaleTimeMs = 90_000;

type CachedAdminImageListResponse = AdminImageListResponseDto & {
  etag: string;
};

export type ImageAdminPageState = {
  scopeKey: string;
  page: number;
  total: number | null;
  totalUpdatedAt: number;
};

export function resolveImageAdminScopeTotal({
  retainedTotal,
  retainedUpdatedAt,
  queryData,
  queryUpdatedAt,
  fetchedAfterMount,
  isSuccess
}: {
  retainedTotal: number | null;
  retainedUpdatedAt: number;
  queryData: Pick<AdminImageListResponseDto, "total"> | undefined;
  queryUpdatedAt: number;
  fetchedAfterMount: boolean;
  isSuccess: boolean;
}) {
  const currentQueryHasObservedSuccessfulData = queryData !== undefined
    && isSuccess
    && fetchedAfterMount;
  const queryTotal = queryData !== undefined
    && (
      retainedTotal === null
      || queryUpdatedAt > retainedUpdatedAt
      || currentQueryHasObservedSuccessfulData
    )
    ? queryData.total
    : null;
  return {
    currentQueryHasObservedSuccessfulData,
    queryTotal,
    total: queryTotal ?? retainedTotal ?? 0
  };
}

function normalizedScope(
  view: ImageAdminView,
  filters: ImageAdminFilterValues,
  pageSize: number,
  sort: Readonly<AdminImageSort>
) {
  return {
    view,
    device: filters.device || "",
    brightness: filters.brightness || "",
    theme: view === "unset" ? unsetThemeFilter : filters.theme || "",
    tag: filters.tag || "",
    author: filters.author || "",
    sort_by: sort.sort_by,
    order: sort.order,
    pageSize
  };
}

export function imageAdminPaginationScopeKey(
  view: ImageAdminView,
  filters: ImageAdminFilterValues,
  pageSize: number,
  sort: Readonly<AdminImageSort> = defaultAdminImageSort
) {
  return JSON.stringify(normalizedScope(view, filters, pageSize, sort));
}

export function effectiveImageAdminPage(
  state: ImageAdminPageState,
  scopeKey: string
) {
  return state.scopeKey === scopeKey ? state.page : 1;
}

export function resetImageAdminPage(
  state: ImageAdminPageState,
  scopeKey: string
): ImageAdminPageState {
  const currentScope = state.scopeKey === scopeKey;
  if (currentScope && state.page === 1) return state;
  return {
    scopeKey,
    page: 1,
    total: currentScope ? state.total : null,
    totalUpdatedAt: currentScope ? state.totalUpdatedAt : 0
  };
}

export function imageAdminTotalPages(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function adminImageListQuery(
  view: ImageAdminView,
  filters: ImageAdminFilterValues,
  scopeKey: string,
  page: number,
  pageSize: number,
  sort: Readonly<AdminImageSort> = defaultAdminImageSort
) {
  const params = new URLSearchParams({
    status: view === "deleted" ? "deleted" : "ready",
    sort_by: sort.sort_by,
    order: sort.order,
    page: String(page),
    limit: String(pageSize)
  });
  if (view === "unset") params.set("theme", unsetThemeFilter);
  else if (filters.theme) params.set("theme", filters.theme);
  if (filters.device) params.set("device", filters.device);
  if (filters.brightness) params.set("brightness", filters.brightness);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author) params.set("author", filters.author);

  const queryKey = [
    ...queryKeys.adminImages,
    scopeKey,
    page,
    pageSize
  ] as const;
  return {
    queryKey,
    queryFn: async (context: { signal: AbortSignal; client: QueryClient }) => {
      // Strict Mode remounts before the first microtask. Defer consuming the
      // Query signal so that replay keeps the same in-flight Promise; after
      // that boundary, real navigation still cancels the transport normally.
      await Promise.resolve();
      const cached = context.client.getQueryData<CachedAdminImageListResponse>(
        queryKey
      );
      let validationStartedAt: number | undefined;
      const result = await apiWithEtag<AdminImageListResponseDto>(
        `${adminApiBasePath}/images?${params}`,
        { signal: context.signal },
        cached?.etag ? { etag: cached.etag, data: cached } : undefined,
        (response) => {
          const candidate = Number(
            response.headers.get(adminImageListReadStartedAtHeader)
          );
          if (Number.isSafeInteger(candidate) && candidate >= 0) {
            validationStartedAt = candidate;
          }
        }
      );
      if (validationStartedAt !== undefined) {
        recordAdminImageListValidation(
          context.client,
          queryKey,
          validationStartedAt
        );
      }
      if (result.data === cached && result.etag === cached.etag) return cached;
      return { ...result.data, etag: result.etag };
    },
    staleTime: adminImageListStaleTimeMs
  };
}
