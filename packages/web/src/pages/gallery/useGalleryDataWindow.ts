import {
  isCancelledError,
  useQueryClient
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject
} from "react";
import { queryKeys } from "../../lib/api/query-keys.js";
import {
  galleryDataWindowMaxConcurrentPageLoads,
  galleryLoadBufferScreens,
  galleryVirtualOverscanScreens
} from "../../lib/constants.js";
import {
  isPageScrollLocked,
  pageScrollRestoredEvent
} from "../../hooks/usePageScrollLock.js";
import type { GalleryCompactGeometry } from "./compact-masonry-layout.js";
import {
  GalleryDataWindow,
  type GalleryDataWindowViewport,
  type GalleryPageIntent,
  type GalleryPageRequest
} from "./gallery-data-window.js";
import { galleryImagePageQueryOptions } from "./gallery-images-query.js";
import type { GalleryDataWindowMetrics } from "./gallery-debug-stats.js";

function initialViewport(): GalleryDataWindowViewport {
  const viewportHeight = Math.max(1, window.innerHeight);
  return {
    start: 0,
    end: viewportHeight * (1 + galleryVirtualOverscanScreens),
    visibleStart: 0,
    visibleEnd: viewportHeight,
    preloadEnd: viewportHeight * (1 + galleryLoadBufferScreens)
  };
}

function sameViewport(
  left: GalleryDataWindowViewport,
  right: GalleryDataWindowViewport
) {
  return Math.abs(left.start - right.start) < 1
    && Math.abs(left.end - right.end) < 1
    && Math.abs(left.visibleStart - right.visibleStart) < 1
    && Math.abs(left.visibleEnd - right.visibleEnd) < 1
    && Math.abs(left.preloadEnd - right.preloadEnd) < 1;
}

function normalizedError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

export function useGalleryDataWindow({
  geometry,
  imageQuery,
  pinnedImageId,
  windowRef
}: {
  geometry: GalleryCompactGeometry;
  imageQuery: string;
  pinnedImageId: string | null;
  windowRef: RefObject<HTMLDivElement | null>;
}) {
  const queryClient = useQueryClient();
  const controller = useMemo(
    () => new GalleryDataWindow({ geometry }),
    [imageQuery]
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  const [viewport, setViewport] = useState(initialViewport);
  const [requestSlotRevision, setRequestSlotRevision] = useState(0);
  const viewportRef = useRef(viewport);
  const pinnedImageIdRef = useRef(pinnedImageId);
  const anchorFrameRef = useRef<number | null>(null);
  const pendingAnchorRef = useRef<{ id: string; y: number } | null>(null);
  const activeRequestsRef = useRef(
    new WeakMap<GalleryDataWindow, Map<string, Promise<void>>>()
  );
  const requestPauseRef = useRef<{
    controller: GalleryDataWindow;
    token: number;
  } | null>(null);
  const nextRequestPauseTokenRef = useRef(0);
  viewportRef.current = viewport;
  pinnedImageIdRef.current = pinnedImageId;

  const preserveAnchor = useCallback((mutation: () => void) => {
    const currentViewport = viewportRef.current;
    const existingAnchor = pendingAnchorRef.current;
    const anchor = existingAnchor ?? controller.windowPositions({
      start: currentViewport.visibleStart,
      end: currentViewport.visibleEnd,
      visibleStart: currentViewport.visibleStart,
      visibleEnd: currentViewport.visibleEnd,
      pinnedId: null
    }).find((position) => (
      position.bottom >= currentViewport.visibleStart
      && position.y <= currentViewport.visibleEnd
    ));
    mutation();
    if (!anchor) return;
    const nextPosition = controller.positionForId(anchor.id);
    if (!nextPosition) {
      pendingAnchorRef.current = null;
      return;
    }
    const delta = nextPosition.y - anchor.y;
    if (Math.abs(delta) < 0.5 && anchorFrameRef.current === null) return;
    pendingAnchorRef.current = { id: anchor.id, y: anchor.y };
    if (anchorFrameRef.current !== null) return;
    anchorFrameRef.current = window.requestAnimationFrame(() => {
      anchorFrameRef.current = null;
      const pendingAnchor = pendingAnchorRef.current;
      pendingAnchorRef.current = null;
      if (!pendingAnchor) return;
      const settledPosition = controller.positionForId(pendingAnchor.id);
      if (!settledPosition) return;
      const settledDelta = settledPosition.y - pendingAnchor.y;
      if (Math.abs(settledDelta) < 0.5) return;
      window.scrollBy({ top: settledDelta, behavior: "instant" });
    });
  }, [controller]);

  useLayoutEffect(() => {
    preserveAnchor(() => {
      controller.setGeometry(geometry);
    });
  }, [
    controller,
    geometry.columnCount,
    geometry.contentWidth,
    geometry.gap,
    preserveAnchor
  ]);

  useLayoutEffect(() => {
    let frame: number | undefined;
    const update = () => {
      frame = undefined;
      if (isPageScrollLocked()) return;
      const element = windowRef.current;
      if (!element) return;
      const viewportHeight = Math.max(1, window.innerHeight);
      const visibleStart = Math.max(0, -element.getBoundingClientRect().top);
      const overscan = viewportHeight * galleryVirtualOverscanScreens;
      const next = {
        start: Math.max(0, visibleStart - overscan),
        end: Math.min(
          snapshot.totalHeight,
          visibleStart + viewportHeight + overscan
        ),
        visibleStart,
        visibleEnd: visibleStart + viewportHeight,
        preloadEnd: visibleStart
          + viewportHeight * (1 + galleryLoadBufferScreens)
      };
      setViewport((current) => sameViewport(current, next) ? current : next);
    };
    const schedule = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener(pageScrollRestoredEvent, schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener(pageScrollRestoredEvent, schedule);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [snapshot.totalHeight, windowRef]);

  const fetchPage = useCallback((intent: GalleryPageIntent) => {
    let active = activeRequestsRef.current.get(controller);
    if (!active) {
      active = new Map();
      activeRequestsRef.current.set(controller, active);
    }
    if (
      active.has(intent.cursor)
      || active.size >= galleryDataWindowMaxConcurrentPageLoads
    ) {
      return;
    }
    const request: GalleryPageRequest | null = controller.claimRequest(intent);
    if (!request) return;
    const options = galleryImagePageQueryOptions(imageQuery, request.cursor);
    const pending = queryClient.fetchQuery(options)
      .then((payload) => {
        preserveAnchor(() => controller.resolvePage(request, payload));
      })
      .catch((error: unknown) => {
        if (isCancelledError(error) || (error as Error)?.name === "AbortError") {
          controller.cancelPage(request);
          return;
        }
        controller.rejectPage(request, normalizedError(error));
      })
      .finally(() => {
        active?.delete(request.cursor);
        queryClient.removeQueries({
          queryKey: options.queryKey,
          exact: true
        });
        // Completing one ephemeral query opens a slot for the next nearby
        // hydration. TanStack's cache removal does not render this owner, so
        // explicitly repump instead of letting a long scroll stall at one page.
        setRequestSlotRevision((current) => current + 1);
      });
    active.set(request.cursor, pending);
  }, [controller, imageQuery, preserveAnchor, queryClient]);

  useEffect(() => {
    const requests = controller.updateViewport(viewport, pinnedImageId);
    if (requestPauseRef.current?.controller === controller) return;
    const active = activeRequestsRef.current.get(controller);
    const available = Math.max(
      0,
      galleryDataWindowMaxConcurrentPageLoads - (active?.size ?? 0)
    );
    for (const request of requests.slice(0, available)) fetchPage(request);
  }, [
    controller,
    fetchPage,
    pinnedImageId,
    requestSlotRevision,
    snapshot.revision,
    viewport
  ]);

  useEffect(() => () => {
    if (anchorFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorFrameRef.current);
      anchorFrameRef.current = null;
    }
    pendingAnchorRef.current = null;
    if (requestPauseRef.current?.controller === controller) {
      requestPauseRef.current = null;
    }
  }, [controller]);

  const positions = useMemo(() => controller.windowPositions({
    start: viewport.start,
    end: viewport.end,
    visibleStart: viewport.visibleStart,
    visibleEnd: viewport.visibleEnd,
    pinnedId: pinnedImageId
  }), [controller, pinnedImageId, snapshot.revision, viewport]);

  const debugMetrics = useMemo<GalleryDataWindowMetrics | null>(() => {
    if (import.meta.env?.DEV !== true) return null;
    const debug = controller.debugSnapshot();
    return {
      fetchedPages: debug.fetchedPages,
      retainedPages: debug.retainedPages,
      queryCachePages: queryClient.getQueryCache().findAll({
        queryKey: [...queryKeys.publicImages, imageQuery],
        exact: false
      }).length,
      compactItems: debug.compactItems,
      fullItems: debug.fullItems,
      materializedPositions: debug.materializedPositions,
      compactLayoutBytes: debug.compactLayoutBytes,
      estimatedCompactBytes: debug.estimatedCompactBytes,
      estimatedFullDtoBytes: debug.estimatedFullDtoBytes
    };
  }, [
    controller,
    imageQuery,
    positions,
    queryClient,
    requestSlotRevision,
    snapshot.revision
  ]);

  const retry = useCallback(() => {
    const cursor = controller.snapshot().errorRequest?.cursor;
    if (cursor === undefined) return;
    const request = controller.retryRequest(cursor);
    if (request) fetchPage(request);
  }, [controller, fetchPage]);

  const settlePendingPageRequests = useCallback(async () => {
    const active = activeRequestsRef.current.get(controller);
    const pending = active ? [...active.values()] : [];
    await queryClient.cancelQueries({
      queryKey: [...queryKeys.publicImages, imageQuery],
      exact: false
    }).catch(() => undefined);
    await Promise.allSettled(pending);
  }, [controller, imageQuery, queryClient]);

  const refreshImage = useCallback((imageId: string) => {
    const pauseToken = nextRequestPauseTokenRef.current += 1;
    requestPauseRef.current = { controller, token: pauseToken };
    const intent = controller.prepareImageRefresh(imageId);
    if (!intent) {
      requestPauseRef.current = null;
      return;
    }

    void settlePendingPageRequests().then(() => {
      const pause = requestPauseRef.current;
      if (pause?.controller !== controller || pause.token !== pauseToken) return;
      // Claim the authoritative hydration while the automatic request pump is
      // still paused, then reopen the remaining nearby slots.
      fetchPage(intent);
      requestPauseRef.current = null;
    });
  }, [controller, fetchPage, settlePendingPageRequests]);

  const removeImage = useCallback(async (imageId: string) => {
    // Fence responses synchronously before awaiting Query cancellation. Even a
    // request that settled on the same turn can no longer restore the deleted
    // card into this controller.
    const pauseToken = nextRequestPauseTokenRef.current += 1;
    requestPauseRef.current = { controller, token: pauseToken };
    controller.invalidatePendingRequests();
    await settlePendingPageRequests();
    let result = {
      removed: false,
      index: -1,
      focusId: null as string | null
    };
    preserveAnchor(() => {
      result = controller.removeImage(imageId);
    });
    const pause = requestPauseRef.current;
    if (pause?.controller === controller && pause.token === pauseToken) {
      requestPauseRef.current = null;
    }
    return result;
  }, [controller, preserveAnchor, settlePendingPageRequests]);

  return {
    snapshot,
    positions,
    initialLoading: snapshot.compactItems === 0
      && snapshot.pendingQueryPages > 0,
    nextPageLoading: snapshot.compactItems > 0
      && snapshot.pendingAppendPages > 0,
    retry,
    refreshImage,
    removeImage,
    debugMetrics
  };
}
