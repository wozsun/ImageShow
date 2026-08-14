import type { AdminImageListResponseDto } from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import type { ImageAdminFilterValues } from "./ImageAdminFilters.js";
import type { ImageAdminView } from "./useImageAdminOperations.js";

const adminImageListStaleTimeMs = 90_000;

export type ImageAdminPageState = {
  scopeKey: string;
  page: number;
};

function normalizedScope(
  view: ImageAdminView,
  filters: ImageAdminFilterValues,
  pageSize: number
) {
  return {
    view,
    device: filters.device || "",
    brightness: filters.brightness || "",
    theme: view === "unset" ? "none" : filters.theme || "",
    tag: filters.tag || "",
    author: filters.author || "",
    pageSize
  };
}

export function imageAdminPaginationScopeKey(
  view: ImageAdminView,
  filters: ImageAdminFilterValues,
  pageSize: number
) {
  return JSON.stringify(normalizedScope(view, filters, pageSize));
}

export function effectiveImageAdminPage(
  state: ImageAdminPageState,
  scopeKey: string
) {
  return state.scopeKey === scopeKey ? state.page : 1;
}

export function imageAdminTotalPages(total: number, pageSize: number) {
  return Math.max(1, Math.ceil(total / pageSize));
}

export function adminImageListQuery(
  view: ImageAdminView,
  filters: ImageAdminFilterValues,
  scopeKey: string,
  page: number,
  pageSize: number
) {
  const params = new URLSearchParams({
    status: view === "deleted" ? "deleted" : "ready",
    page: String(page),
    limit: String(pageSize)
  });
  if (view === "unset") params.set("t", "none");
  else if (filters.theme) params.set("t", filters.theme);
  if (filters.device) params.set("d", filters.device);
  if (filters.brightness) params.set("b", filters.brightness);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author) params.set("a", filters.author);

  return {
    queryKey: [
      ...queryKeys.adminImages,
      scopeKey,
      page,
      pageSize
    ] as const,
    queryFn: async (context: { signal: AbortSignal }) => {
      // Strict Mode remounts before the first microtask. Defer consuming the
      // Query signal so that replay keeps the same in-flight Promise; after
      // that boundary, real navigation still cancels the transport normally.
      await Promise.resolve();
      return api<AdminImageListResponseDto>(
        `${adminApiBasePath}/images?${params}`,
        { signal: context.signal }
      );
    },
    staleTime: adminImageListStaleTimeMs
  };
}
