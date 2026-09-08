import {
  isCancelledError,
  useQueryClient
} from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject
} from "react";
import { queryKeys } from "../../lib/api/query-keys.js";
import { imageDataRevision } from "../../lib/api/image-data-revision.js";
import { galleryDataWindowMaxConcurrentPageLoads } from "../../lib/constants.js";
import {
  isPageScrollLocked,
  pageScrollRestoredEvent
} from "../../hooks/usePageScrollLock.js";
import type { GalleryCompactGeometry } from "./compact-masonry-layout.js";
import {
  GalleryDataWindow,
  type GalleryDataWindowViewport,
  type GalleryIntrinsicSize,
  type GalleryPageIntent,
  type GalleryPageRequest
} from "./gallery-data-window.js";
import {
  activateGalleryRestorationSession,
  retainGalleryRestorationSession,
  reusableGalleryRestorationSession,
  type GalleryScrollAnchor
} from "./gallery-restoration.js";
import { galleryImagePageQueryOptions, galleryInitialBatchLimit } from "./gallery-images-query.js";
import { isApiClientError } from "../../lib/api/client.js";
import { imageMatchesFilters } from "../../lib/gallery/image-browse.js";
import { galleryFiltersFromSearchParams } from "../../lib/gallery/gallery-query.js";
import type { GalleryDataWindowMetrics } from "./gallery-debug-stats.js";
import type { EditableImageSnapshot } from "../../lib/types.js";
import {
  createGalleryRenderViewport,
  shouldRefreshGalleryRenderViewport
} from "./gallery-render-viewport.js";

function viewportForAnchor(
  controller: GalleryDataWindow,
  anchor: GalleryScrollAnchor | null
): GalleryDataWindowViewport {
  const position = anchor ? controller.positionForId(anchor.id) : null;
  const visibleStart = position && anchor
    ? Math.max(0, position.y - anchor.offset)
    : 0;
  return createGalleryRenderViewport(visibleStart, window.innerHeight);
}

function normalizedError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

export function useGalleryDataWindow({
  geometry,
  geometryReady,
  imageQuery,
  navigationKey,
  restorePosition,
  pinnedImageId,
  windowRef
}: {
  geometry: GalleryCompactGeometry;
  geometryReady: boolean;
  imageQuery: string;
  navigationKey: string;
  restorePosition: boolean;
  pinnedImageId: string | null;
  windowRef: RefObject<HTMLDivElement | null>;
}) {
  const queryClient = useQueryClient();
  const ownerId = useId();
  // A fresh navigation must not join a previous visit's in-flight page read,
  // even when neither its filters nor its image mutation revision changed.
  const queryScope = `${ownerId}:${navigationKey}`;
  // Retain the old height during measurement so a classic scrollbar does not
  // disappear and change the measured width. Ownership waits for real geometry.
  const session = useMemo(
    () => {
      const retained = restorePosition
        ? reusableGalleryRestorationSession(
            imageQuery,
            navigationKey,
            geometryReady ? geometry : undefined
          )
        : null;
      return retained ?? {
        imageQuery,
        navigationKey,
        imageDataRevision: imageDataRevision(queryClient),
        geometry,
        controller: new GalleryDataWindow({
          geometry,
          initialLimit: galleryInitialBatchLimit(geometry, window.innerHeight, new URLSearchParams(imageQuery).get("device") ?? ""),
          randomOrder: new URLSearchParams(imageQuery).get("order") === "random"
        }),
        anchor: null
      };
    },
    [imageQuery, navigationKey, restorePosition, queryClient, geometryReady]
  );
  const controller = session.controller;
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot
  );
  const [viewport, setViewport] = useState(
    () => viewportForAnchor(controller, session.anchor)
  );
  const [requestSlotRevision, setRequestSlotRevision] = useState(0);
  const viewportControllerRef = useRef<GalleryDataWindow | null>(null);
  const viewportRef = useRef(viewport);
  const anchorFrameRef = useRef<number | null>(null);
  const pendingAnchorRef = useRef<{
    id: string;
    y: number;
    offset: number;
  } | null>(null);
  const measurementFrameRef = useRef<number | null>(null);
  const pendingMeasurementsRef = useRef(new Map<string, GalleryIntrinsicSize>());
  const routeRestorationRef = useRef<{
    controller: GalleryDataWindow;
    anchor: GalleryScrollAnchor;
  } | null>(session.anchor ? { controller, anchor: session.anchor } : null);
  const restorationControllerRef = useRef(controller);
  if (restorationControllerRef.current !== controller) {
    restorationControllerRef.current = controller;
    routeRestorationRef.current = session.anchor
      ? { controller, anchor: session.anchor }
      : null;
  }
  const activeRequestsRef = useRef(
    new WeakMap<GalleryDataWindow, Map<string, Promise<void>>>()
  );
  const requestPauseRef = useRef<{
    controller: GalleryDataWindow;
    token: number;
  } | null>(null);
  const nextRequestPauseTokenRef = useRef(0);
  viewportRef.current = viewport;

  const preserveAnchor = useCallback((mutation: () => void) => {
    const element = windowRef.current;
    const visibleStart = element
      ? Math.max(0, -element.getBoundingClientRect().top)
      : viewportRef.current.visibleStart;
    const existingAnchor = pendingAnchorRef.current;
    const anchor = existingAnchor ?? controller.viewportAnchor(
      visibleStart,
      visibleStart + window.innerHeight
    );
    mutation();
    if (!anchor) return;
    const nextPosition = controller.positionForId(anchor.id);
    if (!nextPosition) {
      pendingAnchorRef.current = null;
      return;
    }
    const delta = nextPosition.y - anchor.y;
    if (Math.abs(delta) < 0.5 && anchorFrameRef.current === null) return;
    pendingAnchorRef.current = existingAnchor ?? {
      id: anchor.id,
      y: anchor.y,
      offset: anchor.y - visibleStart
    };
    if (anchorFrameRef.current !== null) return;
    anchorFrameRef.current = window.requestAnimationFrame(() => {
      anchorFrameRef.current = null;
      const pendingAnchor = pendingAnchorRef.current;
      pendingAnchorRef.current = null;
      const currentElement = windowRef.current;
      if (!pendingAnchor || !currentElement
        || viewportControllerRef.current !== controller) return;
      const settledPosition = controller.positionForId(pendingAnchor.id);
      if (!settledPosition) return;
      const settledDelta = settledPosition.y - pendingAnchor.y;
      if (Math.abs(settledDelta) < 0.5) return;
      // A shorter layout may already have clamped scrollY. Restore the card's
      // absolute viewport offset rather than applying the layout delta twice.
      const documentTop = window.scrollY + currentElement.getBoundingClientRect().top;
      window.scrollTo({
        top: Math.max(0, documentTop + settledPosition.y - pendingAnchor.offset),
        behavior: "instant"
      });
      const next = createGalleryRenderViewport(
        Math.max(0, -currentElement.getBoundingClientRect().top),
        window.innerHeight
      );
      viewportRef.current = next;
      setViewport(next);
    });
  }, [controller, windowRef]);

  useLayoutEffect(() => {
    if (!geometryReady) return;
    if (viewportControllerRef.current === controller) return;
    viewportControllerRef.current = controller;
    const restoration = routeRestorationRef.current;
    const restoring = restoration?.controller === controller;
    if (restoring) {
      if (session.imageDataRevision !== imageDataRevision(queryClient)) {
        controller.invalidateHydratedPages();
      } else {
        controller.invalidatePendingRequests();
      }
    }
    const next = viewportForAnchor(
      controller,
      restoring ? restoration.anchor : null
    );
    viewportRef.current = next;
    setViewport(next);
    const element = windowRef.current;
    if (restoring && element) {
      const documentTop = window.scrollY + element.getBoundingClientRect().top;
      window.scrollTo({ top: Math.max(0, documentTop + next.visibleStart), behavior: "instant" });
    } else if (!restoring) {
      window.scrollTo({ top: 0 });
    }
  }, [controller, geometryReady, queryClient, session.imageDataRevision, windowRef]);

  useLayoutEffect(() => {
    if (!geometryReady) return;
    activateGalleryRestorationSession();
    return () => {
      const element = windowRef.current;
      if (!element) return;
      const visibleStart = Math.max(0, -element.getBoundingClientRect().top);
      const anchor = controller.viewportAnchor(
        visibleStart,
        visibleStart + Math.max(1, window.innerHeight)
      );
      if (!anchor) return;
      retainGalleryRestorationSession({
        imageQuery,
        navigationKey,
        imageDataRevision: imageDataRevision(queryClient),
        geometry: controller.compactGeometry(),
        controller,
        anchor: {
          id: anchor.id,
          offset: anchor.y - visibleStart,
          pageLimit: anchor.pageIndex + 2
        }
      });
    };
  }, [controller, geometryReady, imageQuery, navigationKey, queryClient, windowRef]);

  useLayoutEffect(() => {
    if (!geometryReady) return;
    preserveAnchor(() => {
      controller.setGeometry(geometry);
    });
  }, [
    controller,
    geometryReady,
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
      if (routeRestorationRef.current?.controller === controller) return;
      const element = windowRef.current;
      if (!element) return;
      const viewportHeight = Math.max(1, window.innerHeight);
      const visibleStart = Math.max(0, -element.getBoundingClientRect().top);
      if (!shouldRefreshGalleryRenderViewport(
        viewportRef.current,
        visibleStart,
        viewportHeight
      )) return;
      const next = createGalleryRenderViewport(visibleStart, viewportHeight);
      viewportRef.current = next;
      setViewport(next);
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
  }, [controller, windowRef]);

  const fetchPage = useCallback((intent: GalleryPageIntent, forceValidation = false) => {
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
    const options = galleryImagePageQueryOptions(
      imageQuery, request.cursor, imageDataRevision(queryClient).sequence, queryScope,
      controller.pageLimit(request.cursor), forceValidation || controller.needsValidation(request.cursor)
    );
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
  }, [controller, imageQuery, preserveAnchor, queryClient, queryScope]);

  useEffect(() => {
    if (!geometryReady) return;
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
    geometryReady,
    pinnedImageId,
    requestSlotRevision,
    snapshot.revision,
    viewport
  ]);

  useEffect(() => () => {
    controller.invalidatePendingRequests();
    void queryClient.cancelQueries({
      queryKey: [...queryKeys.publicImages, imageQuery, queryScope],
      exact: false
    });
    if (anchorFrameRef.current !== null) {
      window.cancelAnimationFrame(anchorFrameRef.current);
      anchorFrameRef.current = null;
    }
    if (measurementFrameRef.current !== null) {
      window.cancelAnimationFrame(measurementFrameRef.current);
      measurementFrameRef.current = null;
    }
    pendingAnchorRef.current = null;
    pendingMeasurementsRef.current.clear();
    if (requestPauseRef.current?.controller === controller) {
      requestPauseRef.current = null;
    }
  }, [controller, imageQuery, queryClient, queryScope]);

  const positions = useMemo(() => controller.windowPositions({
    start: viewport.start,
    end: viewport.end,
    visibleStart: viewport.visibleStart,
    visibleEnd: viewport.visibleEnd,
    pinnedId: pinnedImageId
  }), [controller, pinnedImageId, snapshot.revision, viewport]);

  useLayoutEffect(() => {
    if (!geometryReady) return;
    const pending = routeRestorationRef.current;
    const element = windowRef.current;
    if (!pending || pending.controller !== controller || !element) return;
    const position = controller.positionForId(pending.anchor.id);
    if (!position) {
      // Replacing a changed earlier page truncates later local boundaries; it
      // does not establish that the anchor itself was removed. Rebuild through
      // its former page and one successor, then use a bounded nearby fallback.
      if (snapshot.hasNextPage && snapshot.fetchedPages < pending.anchor.pageLimit) return;
    } else if (!controller.hasHydratedItem(pending.anchor.id)) {
      return;
    }
    // A predecessor arriving after the anchor can still change the cursor
    // chain. Finish the restoration only after this viewport is authoritative.
    if ((position && snapshot.pendingQueryPages) || !controller.hasHydratedViewport()) return;
    const visibleStart = position
      ? Math.max(0, position.y - pending.anchor.offset)
      : Math.min(viewportRef.current.visibleStart, Math.max(0, snapshot.totalHeight - window.innerHeight));
    const documentTop = window.scrollY + element.getBoundingClientRect().top;
    const next = createGalleryRenderViewport(visibleStart, window.innerHeight);
    routeRestorationRef.current = null;
    viewportRef.current = next;
    setViewport(next);
    window.scrollTo({
      top: Math.max(0, documentTop + visibleStart),
      behavior: "instant"
    });
    window.dispatchEvent(new Event(pageScrollRestoredEvent));
  }, [controller, geometryReady, snapshot, windowRef]);

  const reportIntrinsicSize = useCallback((
    id: string,
    width: number,
    height: number
  ) => {
    if (!controller.needsIntrinsicMeasurement(id)) return;
    pendingMeasurementsRef.current.set(id, { id, width, height });
    if (measurementFrameRef.current !== null) return;
    measurementFrameRef.current = window.requestAnimationFrame(() => {
      measurementFrameRef.current = null;
      const measurements = [...pendingMeasurementsRef.current.values()];
      pendingMeasurementsRef.current.clear();
      preserveAnchor(() => controller.resolveIntrinsicSizes(measurements));
    });
  }, [controller, preserveAnchor]);

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
    const error = controller.snapshot().error;
    if (isApiClientError(error) && error.code === "cursor_expired") {
      window.scrollTo({ top: 0 });
      fetchPage(controller.restart());
      return;
    }
    const cursor = controller.snapshot().errorRequest?.cursor;
    if (cursor === undefined) return;
    const request = controller.retryRequest(cursor);
    if (request) fetchPage(request);
  }, [controller, fetchPage]);

  const settlePendingPageRequests = useCallback(async () => {
    const active = activeRequestsRef.current.get(controller);
    const pending = active ? [...active.values()] : [];
    await queryClient.cancelQueries({
      queryKey: [...queryKeys.publicImages, imageQuery, queryScope],
      exact: false
    }).catch(() => undefined);
    await Promise.allSettled(pending);
  }, [controller, imageQuery, queryClient, queryScope]);

  const refreshImage = useCallback((
    image: string | EditableImageSnapshot
  ) => {
    const imageId = typeof image === "string" ? image : image.id;
    const pauseToken = nextRequestPauseTokenRef.current += 1;
    requestPauseRef.current = { controller, token: pauseToken };
    let intent: GalleryPageIntent | null = null;
    preserveAnchor(() => {
      if (typeof image !== "string" && !imageMatchesFilters(
        image, galleryFiltersFromSearchParams(new URLSearchParams(imageQuery)), window.navigator.userAgent
      )) {
        controller.invalidatePendingRequests();
        controller.removeImage(imageId);
        return;
      }
      intent = controller.prepareImageRefresh(
        imageId,
        typeof image === "string" ? undefined : image
      );
    });
    const refreshIntent = intent;

    void settlePendingPageRequests().then(() => {
      const pause = requestPauseRef.current;
      if (pause?.controller !== controller || pause.token !== pauseToken) return;
      // Claim the authoritative hydration while the automatic request pump is
      // still paused, then reopen the remaining nearby slots.
      if (refreshIntent) fetchPage(refreshIntent, true);
      requestPauseRef.current = null;
    });
  }, [controller, fetchPage, imageQuery, preserveAnchor, settlePendingPageRequests]);

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
    reportIntrinsicSize,
    debugMetrics
  };
}
