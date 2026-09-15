import { readableFilterSearch } from "@imageshow/shared/browser";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicImageListResponseDto, ShowOrder } from "@imageshow/shared/browser";
import { api, ApiClientError, isApiClientError } from "../../lib/api/client.js";
import { readEditableImageSnapshots } from "../../lib/api/image-edit.js";
import { imageBrowseApiSearchParams, galleryFiltersFromSearchParams, type GalleryFilters } from "../../lib/gallery/gallery-query.js";
import { imageMatchesFilters, shuffledImageBatch } from "../../lib/gallery/image-browse.js";
import type { EditableImageSnapshot } from "../../lib/types.js";
import type { ShowImage } from "./show-layout.js";
import { showContinuationLimit as continuationLimit, type ShowCandidateUsage } from "./show-data-pool.js";
import { updatedShowImage } from "./show-image-update.js";

const maximumRetainedDtos = 800;
const recentLimit = 2_000;

/** Owns HTTP batches, cursor commits, candidate retirement and edit authority. */
export function useShowData(
  filters: GalleryFilters,
  sourceKey: string,
  order: ShowOrder,
  initialLimit = 200,
  enabled = true
) {
  const [images, setImages] = useState<ShowImage[]>([]);
  const [committed, setCommitted] = useState({ sourceKey, order, dataKey: sourceKey });
  const [hasMore, setHasMore] = useState(true);
  const [failure, setFailure] = useState<{ sourceKey: string; value: unknown; replace: boolean } | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const requestRef = useRef<{ controller: AbortController; replace: boolean; resume?: () => void } | null>(null);
  const continuationTimerRef = useRef<number | null>(null);
  const targetedRequestsRef = useRef(new Map<string, AbortController>());
  const requestGenerationRef = useRef(0);
  const consumptionRoundRef = useRef(0);
  const imagesRef = useRef<ShowImage[]>([]);
  const committedRef = useRef(committed);
  const cursorRef = useRef("");
  const cursorExhaustedRef = useRef(false);
  const hasRetiredCandidatesRef = useRef(false);
  const requestPausedAfterErrorRef = useRef(false);
  const recentImageIdsRef = useRef(new Set<string>());
  const removedImageIdsRef = useRef(new Set<string>());
  const confirmedImageEditsRef = useRef(new Map<string, ShowImage>());
  const latestUsageRef = useRef<ShowCandidateUsage | null>(null);
  const initialLimitRef = useRef(initialLimit);
  initialLimitRef.current = initialLimit;
  const requestIdentity = readableFilterSearch(imageBrowseApiSearchParams(filters, order, {
    view: "show", userAgent: window.navigator.userAgent
  }));
  const requestFilters = useMemo(() => galleryFiltersFromSearchParams(new URLSearchParams(requestIdentity)), [requestIdentity]);

  const publishImages = useCallback((next: ShowImage[]) => {
    imagesRef.current = next;
    setImages(next);
    const ids = new Set(next.map((image) => image.id));
    // Confirmed base fields only need to outlive their resident card.
    for (const id of confirmedImageEditsRef.current.keys()) if (!ids.has(id)) confirmedImageEditsRef.current.delete(id);
  }, []);

  const request = useCallback(async (replace: boolean, validate = false) => {
    if (!enabled || requestRef.current || requestPausedAfterErrorRef.current) return;
    if (!replace && cursorExhaustedRef.current && !hasRetiredCandidatesRef.current) return;
    const limit = replace ? initialLimitRef.current : continuationLimit;
    if (!replace && imagesRef.current.length + limit > maximumRetainedDtos) return;
    if (continuationTimerRef.current !== null) {
      window.clearTimeout(continuationTimerRef.current);
      continuationTimerRef.current = null;
    }
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    requestRef.current = { controller, replace };
    setFailure(null);
    if (replace) setInitialLoading(true);
    try {
      let cursor = replace ? "" : cursorRef.current;
      if (!replace && cursorExhaustedRef.current) {
        cursor = "";
        recentImageIdsRef.current = new Set([...recentImageIdsRef.current].slice(-continuationLimit));
      }
      // Repeated batches still advance their scan boundary. Yield after four
      // empty admissions; candidate usage (or remaining empty-scene demand)
      // resumes from the cursor without making success a playback failure.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const params = imageBrowseApiSearchParams(requestFilters, order, {
          view: "show", limit, cursor, userAgent: window.navigator.userAgent
        });
        const path = `/api/images?${readableFilterSearch(params)}`;
        const response = await api<PublicImageListResponseDto<"show">>(path, {
          signal: controller.signal, ...(validate ? { cache: "no-cache" as const } : {})
        });
        if (requestGenerationRef.current !== generation || controller.signal.aborted) return;
        if (response.next_cursor && response.next_cursor === cursor) {
          throw new ApiClientError("图片分页未能继续，请重试", 503, "browse_cursor_stalled");
        }
        const previous = replace ? [] : imagesRef.current;
        const ids = new Set(previous.map((image) => image.id));
        const eligible: ShowImage[] = [];
        for (const item of response.items) {
          if (!item.id || ids.has(item.id) || removedImageIdsRef.current.has(item.id)) continue;
          ids.add(item.id);
          eligible.push(confirmedImageEditsRef.current.get(item.id) ?? item);
        }
        const incoming = eligible.filter((item) => replace || !recentImageIdsRef.current.has(item.id));
        // At EOF an empty scene cannot emit another consumption revision.
        // Reuse this valid page only when recent history rejected every item;
        // empty or locally removed pages still end the scan without polling.
        if (!previous.length && !incoming.length && response.next_cursor === null) {
          incoming.push(...eligible);
        }
        if (previous.length + incoming.length > maximumRetainedDtos) {
          throw new ApiClientError("图片候选容量不足，请重试", 503, "browse_capacity_exceeded");
        }
        const accepted = order === "random" ? shuffledImageBatch(incoming) : incoming;
        for (const item of accepted) {
          recentImageIdsRef.current.delete(item.id);
          recentImageIdsRef.current.add(item.id);
        }
        while (recentImageIdsRef.current.size > recentLimit) {
          recentImageIdsRef.current.delete(recentImageIdsRef.current.values().next().value!);
        }
        // Admission and scan advancement are one synchronous commit. No
        // candidate is truncated to make an already-advanced cursor fit.
        cursorRef.current = response.next_cursor ?? "";
        cursorExhaustedRef.current = response.next_cursor === null;
        setHasMore(!cursorExhaustedRef.current || hasRetiredCandidatesRef.current);
        if (replace || accepted.length) publishImages([...previous, ...accepted]);
        // An empty pool starts a new consumption round when refilled. React
        // can batch retirement and admission into one render, so neither a
        // queued usage snapshot nor the scene may reuse the old consumed IDs.
        if (replace || (!previous.length && accepted.length > 0)) {
          const value = { sourceKey, order, dataKey: `${sourceKey}#${++consumptionRoundRef.current}` };
          committedRef.current = value;
          setCommitted(value);
        }
        if (replace || accepted.length || cursorExhaustedRef.current) return;
        cursor = cursorRef.current;
      }
    } catch (error) {
      if (!controller.signal.aborted && requestGenerationRef.current === generation) {
        requestPausedAfterErrorRef.current = true;
        setFailure({ sourceKey, value: error, replace });
      }
    } finally {
      const completed = requestRef.current?.controller === controller ? requestRef.current : null;
      if (completed) requestRef.current = null;
      if (requestGenerationRef.current === generation) setInitialLoading(false);
      if (completed && requestGenerationRef.current === generation && !requestPausedAfterErrorRef.current) {
        completed.resume?.();
        // An empty scene has no more leases to release, so it cannot emit
        // another consumption revision. Keep that demand across scan rounds,
        // yielding between them; EOF and real failures still stop this scan.
        if (!requestRef.current && !imagesRef.current.length && !cursorExhaustedRef.current
          && latestUsageRef.current?.dataKey === committedRef.current.dataKey) {
          continuationTimerRef.current = window.setTimeout(() => {
            continuationTimerRef.current = null;
            if (requestGenerationRef.current === generation && !imagesRef.current.length) void request(false);
          }, 0);
        }
      }
    }
  }, [enabled, order, publishImages, requestFilters, sourceKey]);

  const invalidateImageRequests = useCallback((imageId?: string) => {
    const replacing = requestRef.current?.replace === true;
    requestGenerationRef.current += 1;
    if (continuationTimerRef.current !== null) {
      window.clearTimeout(continuationTimerRef.current);
      continuationTimerRef.current = null;
    }
    requestRef.current?.controller.abort();
    requestRef.current = null;
    for (const [id, controller] of targetedRequestsRef.current) {
      if (imageId !== undefined && id !== imageId) continue;
      controller.abort();
      targetedRequestsRef.current.delete(id);
    }
    return replacing;
  }, []);

  useEffect(() => {
    invalidateImageRequests();
    cursorRef.current = "";
    cursorExhaustedRef.current = false;
    hasRetiredCandidatesRef.current = false;
    requestPausedAfterErrorRef.current = false;
    latestUsageRef.current = null;
    recentImageIdsRef.current.clear();
    removedImageIdsRef.current.clear();
    confirmedImageEditsRef.current.clear();
    setFailure(null);
    setHasMore(enabled);
    setInitialLoading(enabled);
    if (!enabled) publishImages([]);
    void request(true);
    return () => { invalidateImageRequests(); };
  }, [enabled, invalidateImageRequests, publishImages, request]);

  const loadMore = useCallback((usage?: ShowCandidateUsage) => {
    if (!enabled) return;
    if (usage) {
      if (usage.dataKey !== committedRef.current.dataKey || committedRef.current.sourceKey !== sourceKey) return;
      latestUsageRef.current = usage;
      if (usage.available >= continuationLimit) return;
      const needsRotation = !cursorExhaustedRef.current || hasRetiredCandidatesRef.current || imagesRef.current.length > usage.capacity;
      if (!needsRotation) return;
      const active = new Set(usage.activeIds);
      const consumed = new Set(usage.consumedIds);
      let unconsumed = 0;
      const next = imagesRef.current.filter((image) => {
        if (!consumed.has(image.id)) {
          unconsumed += 1;
          return true;
        }
        return active.has(image.id);
      });
      if (next.length !== imagesRef.current.length) {
        hasRetiredCandidatesRef.current = true;
        publishImages(next);
        setHasMore(true);
      }
      if (unconsumed >= continuationLimit) return;
    }
    // Coalesce demand that arrives during a scan. An empty window may have
    // no further consumption revision after that scan reaches EOF.
    if (requestRef.current) requestRef.current.resume = () => loadMore(usage);
    else void request(false);
  }, [enabled, publishImages, request, sourceKey]);

  const removeImage = useCallback((imageId: string, replenish = false) => {
    removedImageIdsRef.current.add(imageId);
    const next = imagesRef.current.filter((image) => image.id !== imageId);
    if (next.length === imagesRef.current.length) return false;
    const replacing = invalidateImageRequests(imageId);
    publishImages(next);
    if (replacing) void request(true);
    else if (replenish) loadMore(latestUsageRef.current ?? undefined);
    return true;
  }, [invalidateImageRequests, loadMore, publishImages, request]);

  const updateImage = useCallback((snapshot: EditableImageSnapshot) => {
    const current = imagesRef.current.find((image) => image.id === snapshot.id);
    if (!current) return "missing" as const;
    if (!imageMatchesFilters(snapshot, requestFilters, window.navigator.userAgent)) {
      removeImage(snapshot.id, true);
      return "removed" as const;
    }
    const replacing = invalidateImageRequests(snapshot.id);
    const updated = updatedShowImage(current, snapshot);
    confirmedImageEditsRef.current.set(snapshot.id, updated);
    publishImages(imagesRef.current.map((image) => image.id === snapshot.id ? updated : image));
    if (replacing) void request(true);
    return "updated" as const;
  }, [invalidateImageRequests, publishImages, removeImage, request, requestFilters]);

  const refreshImage = useCallback((imageId: string) => {
    if (!imagesRef.current.some((image) => image.id === imageId)) return;
    if (invalidateImageRequests(imageId)) {
      void request(true, true);
      return;
    }
    const controller = new AbortController();
    targetedRequestsRef.current.set(imageId, controller);
    // This recovery follows an admin edit whose authoritative snapshot failed.
    // Page membership can change independently of the image's current validity.
    void readEditableImageSnapshots([imageId], controller.signal)
      .then((response) => {
        if (targetedRequestsRef.current.get(imageId) !== controller) return;
        const image = response.items.find((item) => item.id === imageId);
        if (!image) { removeImage(imageId, true); return; }
        updateImage(image);
      })
      .catch(() => {
        // Only a successful ID snapshot can establish absence or filter mismatch.
        // A failed read keeps the last committed candidate available.
      })
      .finally(() => {
        if (targetedRequestsRef.current.get(imageId) === controller) targetedRequestsRef.current.delete(imageId);
      });
  }, [invalidateImageRequests, removeImage, request, updateImage]);

  const transitioning = committed.sourceKey !== sourceKey || committed.order !== order;
  const error = failure?.sourceKey === sourceKey ? failure.value : null;
  return {
    committedKey: committed.dataKey,
    committedOrder: committed.order,
    error, images: enabled ? images : [], hasMore: enabled && hasMore,
    initialLoading: enabled && (initialLoading || (transitioning && error === null)),
    loadMore, removeImage, updateImage, refreshImage,
    retry: () => {
      requestPausedAfterErrorRef.current = false;
      const expired = isApiClientError(error) && error.code === "cursor_expired";
      if (expired) {
        invalidateImageRequests();
        recentImageIdsRef.current.clear();
        hasRetiredCandidatesRef.current = false;
      }
      void request(expired || Boolean(failure?.replace) || imagesRef.current.length === 0 || transitioning);
    }
  };
}
