import {
  useCallback,
  useEffect,
  useRef,
  useState
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminImageListResponse } from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import { adminApiBasePath } from "../../lib/constants.js";
import { queryKeys } from "../../lib/api/query-keys.js";
import { reportAdminUiError } from "../../lib/ui/error-reporting.js";
import { AsyncIntentFence } from "../../lib/async-intent-fence.js";
import type { ImageAdminFilterValues } from "./ImageAdminFilters.js";
import type { ImageAdminView } from "./useImageAdminOperations.js";
import {
  adminImagePageBoundaryBuildCount,
  adminImagePageBoundaryBuildLimit,
  adminImagePageNavigationStatus,
  adminImagePageRetreatTarget,
  loadAdminImagePage,
  type AdminImagePageNavigationProgress
} from "./image-page-navigation.js";

function adminImageListQuery(
  view: ImageAdminView,
  filters: ImageAdminFilterValues,
  cursor: string,
  pageSize: number
) {
  const params = new URLSearchParams({
    status: view === "deleted" ? "deleted" : "ready",
    limit: String(pageSize)
  });
  if (view === "unset") params.set("t", "none");
  else if (filters.theme) params.set("t", filters.theme);
  if (filters.device) params.set("d", filters.device);
  if (filters.brightness) params.set("b", filters.brightness);
  if (filters.tag) params.set("tag", filters.tag);
  if (filters.author) params.set("a", filters.author);
  if (cursor) params.set("cursor", cursor);

  return {
    queryKey: [...queryKeys.adminImages, params.toString()] as const,
    queryFn: ({ signal }: { signal: AbortSignal }) => api<AdminImageListResponse>(
      `${adminApiBasePath}/images?${params}`,
      { signal }
    )
  };
}

/** Owns the admin list query and its bounded, cancellable cursor chain. */
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
  const [cursorHistory, setCursorHistory] = useState<string[]>([""]);
  const [direction, setDirection] = useState<"previous" | "next" | null>(null);
  const [progress, setProgress] = useState<
    AdminImagePageNavigationProgress | null
  >(null);
  const fenceRef = useRef(new AsyncIntentFence());
  const controllerRef = useRef<AbortController | null>(null);
  const client = useQueryClient();
  const cursor = cursorHistory.at(-1) ?? "";
  const pageNumber = cursorHistory.length;
  const query = useQuery({
    ...adminImageListQuery(view, filters, cursor, pageSize),
    enabled
  });
  const totalPages = Math.max(
    1,
    Math.ceil((query.data?.total ?? 0) / pageSize)
  );

  const cancel = useCallback(() => {
    fenceRef.current.invalidate();
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.abort();
    setDirection(null);
    setProgress(null);
  }, []);

  const reset = useCallback(() => {
    cancel();
    setCursorHistory([""]);
  }, [cancel]);

  useEffect(() => {
    const fence = fenceRef.current;
    fence.mount();
    return () => {
      fence.unmount();
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const retreatTarget = adminImagePageRetreatTarget({
      isFetching: query.isFetching,
      hasPageData: Boolean(query.data),
      itemCount: query.data?.items.length ?? 0,
      currentPage: pageNumber,
      totalPages
    });
    if (retreatTarget === null) return;
    cancel();
    setCursorHistory((current) => current.slice(0, retreatTarget));
  }, [cancel, pageNumber, query.data, query.isFetching, totalPages]);

  const loadPage = useCallback(async (
    targetPage: number,
    blocked: boolean
  ): Promise<string | null> => {
    if (
      blocked
      || targetPage === pageNumber
      || targetPage < 1
      || targetPage > totalPages
    ) {
      return null;
    }

    cancel();
    const boundaryBuilds = adminImagePageBoundaryBuildCount({
      targetPage,
      currentPage: pageNumber,
      cursorHistory
    });
    if (boundaryBuilds > adminImagePageBoundaryBuildLimit) {
      const firstSegmentPage = Math.min(
        totalPages,
        pageNumber + adminImagePageBoundaryBuildLimit
      );
      return `目标第 ${targetPage} 页尚需建立 ${boundaryBuilds} 个边界；`
        + `单次最多 ${adminImagePageBoundaryBuildLimit} 个，`
        + `请先跳到第 ${firstSegmentPage} 页再继续`;
    }

    const requestDirection = targetPage < pageNumber ? "previous" : "next";
    const fence = fenceRef.current;
    const sequence = fence.begin();
    const controller = new AbortController();
    controllerRef.current = controller;
    setDirection(requestDirection);
    setProgress(null);

    try {
      const target = await loadAdminImagePage({
        targetPage,
        currentPage: pageNumber,
        currentPageData: query.data ?? null,
        cursorHistory,
        signal: controller.signal,
        maxBoundaryBuilds: adminImagePageBoundaryBuildLimit,
        onProgress: (nextProgress) => {
          if (fence.isCurrent(sequence)) setProgress(nextProgress);
        },
        load: async (targetCursor) => {
          const targetQuery = adminImageListQuery(
            view,
            filters,
            targetCursor,
            pageSize
          );
          const cancelQuery = () => {
            void client.cancelQueries({
              queryKey: targetQuery.queryKey,
              exact: true
            }).catch((error) => {
              reportAdminUiError("image_admin.page_navigation_cancel", error);
            });
          };
          controller.signal.addEventListener("abort", cancelQuery, { once: true });
          try {
            controller.signal.throwIfAborted();
            const page = await client.fetchQuery(targetQuery);
            controller.signal.throwIfAborted();
            if (!fence.isCurrent(sequence)) {
              throw new Error("Image page navigation was superseded");
            }
            return page;
          } finally {
            controller.signal.removeEventListener("abort", cancelQuery);
          }
        }
      });
      if (!fence.isCurrent(sequence)) return null;
      setCursorHistory(target.cursorHistory);
      return null;
    } catch (error) {
      if (!fence.isCurrent(sequence)) return null;
      reportAdminUiError("image_admin.page_navigation", error);
      return "页面加载失败，请稍后重试";
    } finally {
      if (fence.isCurrent(sequence)) {
        if (controllerRef.current === controller) controllerRef.current = null;
        setDirection(null);
        setProgress(null);
      }
    }
  }, [
    cancel,
    client,
    cursorHistory,
    filters,
    pageNumber,
    pageSize,
    query.data,
    totalPages,
    view
  ]);

  return {
    data: query.data,
    items: query.data?.items ?? [],
    error: query.error,
    isError: query.isError,
    isFetching: query.isFetching,
    refetch: query.refetch,
    cursor,
    pageNumber,
    totalPages,
    direction,
    status: adminImagePageNavigationStatus(progress),
    cancel,
    reset,
    loadPage
  };
}
