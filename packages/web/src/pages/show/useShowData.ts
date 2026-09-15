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
  const generationRef = useRef(0);
  const roundRef = useRef(0);
  const imagesRef = useRef<ShowImage[]>([]);
  const committedRef = useRef(committed);
  const cursorRef = useRef("");
  const endedRef = useRef(false);
  const discardedRef = useRef(false);
  const pausedRef = useRef(false);
  const recentRef = useRef(new Set<string>());
  const removedRef = useRef(new Set<string>());
  const confirmedRef = useRef(new Map<string, ShowImage>());
  const usageRef = useRef<ShowCandidateUsage | null>(null);
  const initialLimitRef = useRef(initialLimit);
  initialLimitRef.current = initialLimit;
  const requestIdentity = readableFilterSearch(imageBrowseApiSearchParams(filters, order, {
    view: "show", userAgent: window.navigator.userAgent
  }));
  const requestFilters = useMemo(() => galleryFiltersFromSearchParams(new URLSearchParams(requestIdentity)), [requestIdentity]);

  const publish = useCallback((next: ShowImage[]) => {
    imagesRef.current = next;
    setImages(next);
    const ids = new Set(next.map((image) => image.id));
    // Confirmed base fields only need to outlive their resident card.
    for (const id of confirmedRef.current.keys()) if (!ids.has(id)) confirmedRef.current.delete(id);
  }, []);

  const request = useCallback(async (replace: boolean, validate = false) => {
    if (!enabled || requestRef.current || pausedRef.current) return;
    if (!replace && endedRef.current && !discardedRef.current) return;
    const limit = replace ? initialLimitRef.current : continuationLimit;
    if (!replace && imagesRef.current.length + limit > maximumRetainedDtos) return;
    if (continuationTimerRef.current !== null) {
      window.clearTimeout(continuationTimerRef.current);
      continuationTimerRef.current = null;
    }
    const generation = generationRef.current;
    const controller = new AbortController();
    requestRef.current = { controller, replace };
    setFailure(null);
    if (replace) setInitialLoading(true);
    try {
      let cursor = replace ? "" : cursorRef.current;
      if (!replace && endedRef.current) {
        cursor = "";
        recentRef.current = new Set([...recentRef.current].slice(-continuationLimit));
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
        if (generationRef.current !== generation || controller.signal.aborted) return;
        if (response.next_cursor && response.next_cursor === cursor) {
          throw new ApiClientError("图片分页未能继续，请重试", 503, "browse_cursor_stalled");
        }
        const previous = replace ? [] : imagesRef.current;
        const ids = new Set(previous.map((image) => image.id));
        const eligible: ShowImage[] = [];
        for (const item of response.items) {
          if (!item.id || ids.has(item.id) || removedRef.current.has(item.id)) continue;
          ids.add(item.id);
          eligible.push(confirmedRef.current.get(item.id) ?? item);
        }
        const incoming = eligible.filter((item) => replace || !recentRef.current.has(item.id));
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
          recentRef.current.delete(item.id);
          recentRef.current.add(item.id);
        }
        while (recentRef.current.size > recentLimit) {
          recentRef.current.delete(recentRef.current.values().next().value!);
        }
        // Admission and scan advancement are one synchronous commit. No
        // candidate is truncated to make an already-advanced cursor fit.
        cursorRef.current = response.next_cursor ?? "";
        endedRef.current = response.next_cursor === null;
        setHasMore(!endedRef.current || discardedRef.current);
        if (replace || accepted.length) publish([...previous, ...accepted]);
        if (replace) {
          const value = { sourceKey, order, dataKey: `${sourceKey}#${++roundRef.current}` };
          committedRef.current = value;
          setCommitted(value);
        }
        if (replace || accepted.length || endedRef.current) return;
        cursor = cursorRef.current;
      }
    } catch (error) {
      if (!controller.signal.aborted && generationRef.current === generation) {
        pausedRef.current = true;
        setFailure({ sourceKey, value: error, replace });
      }
    } finally {
      const completed = requestRef.current?.controller === controller ? requestRef.current : null;
      if (completed) requestRef.current = null;
      if (generationRef.current === generation) setInitialLoading(false);
      if (completed && generationRef.current === generation && !pausedRef.current) {
        completed.resume?.();
        // An empty scene has no more leases to release, so it cannot emit
        // another consumption revision. Keep that demand across scan rounds,
        // yielding between them; EOF and real failures still stop this scan.
        if (!requestRef.current && !imagesRef.current.length && !endedRef.current
          && usageRef.current?.dataKey === committedRef.current.dataKey) {
          continuationTimerRef.current = window.setTimeout(() => {
            continuationTimerRef.current = null;
            if (generationRef.current === generation && !imagesRef.current.length) void request(false);
          }, 0);
        }
      }
    }
  }, [enabled, order, publish, requestFilters, sourceKey]);

  const fence = useCallback((imageId?: string) => {
    const replacing = requestRef.current?.replace === true;
    generationRef.current += 1;
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
    fence();
    cursorRef.current = "";
    endedRef.current = false;
    discardedRef.current = false;
    pausedRef.current = false;
    usageRef.current = null;
    recentRef.current.clear();
    removedRef.current.clear();
    confirmedRef.current.clear();
    setFailure(null);
    setHasMore(enabled);
    setInitialLoading(enabled);
    if (!enabled) publish([]);
    void request(true);
    return () => { fence(); };
  }, [enabled, fence, publish, request]);

  const loadMore = useCallback((usage?: ShowCandidateUsage) => {
    if (!enabled) return;
    if (usage) {
      if (usage.dataKey !== committedRef.current.dataKey || committedRef.current.sourceKey !== sourceKey) return;
      usageRef.current = usage;
      if (usage.available >= continuationLimit) return;
      const needsRotation = !endedRef.current || discardedRef.current || imagesRef.current.length > usage.capacity;
      if (!needsRotation) return;
      const active = new Set(usage.activeIds);
      const consumed = new Set(usage.consumedIds);
      const next = imagesRef.current.filter((image) => active.has(image.id) || !consumed.has(image.id));
      if (next.length !== imagesRef.current.length) {
        discardedRef.current = true;
        publish(next);
        setHasMore(true);
      }
      const unconsumed = imagesRef.current.filter((image) => !consumed.has(image.id)).length;
      if (unconsumed >= continuationLimit) return;
    }
    // Coalesce demand that arrives during a scan. An empty window may have
    // no further consumption revision after that scan reaches EOF.
    if (requestRef.current) requestRef.current.resume = () => loadMore(usage);
    else void request(false);
  }, [enabled, publish, request, sourceKey]);

  const removeImage = useCallback((imageId: string, replenish = false) => {
    removedRef.current.add(imageId);
    const next = imagesRef.current.filter((image) => image.id !== imageId);
    if (next.length === imagesRef.current.length) return false;
    const replacing = fence(imageId);
    publish(next);
    if (replacing) void request(true);
    else if (replenish) loadMore(usageRef.current ?? undefined);
    return true;
  }, [fence, loadMore, publish, request]);

  const updateImage = useCallback((snapshot: EditableImageSnapshot) => {
    const current = imagesRef.current.find((image) => image.id === snapshot.id);
    if (!current) return "missing" as const;
    if (!imageMatchesFilters(snapshot, requestFilters, window.navigator.userAgent)) {
      removeImage(snapshot.id, true);
      return "removed" as const;
    }
    const replacing = fence(snapshot.id);
    const updated = updatedShowImage(current, snapshot);
    confirmedRef.current.set(snapshot.id, updated);
    publish(imagesRef.current.map((image) => image.id === snapshot.id ? updated : image));
    if (replacing) void request(true);
    return "updated" as const;
  }, [fence, publish, removeImage, request, requestFilters]);

  const refreshImage = useCallback((imageId: string) => {
    if (!imagesRef.current.some((image) => image.id === imageId)) return;
    if (fence(imageId)) {
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
  }, [fence, removeImage, request, updateImage]);

  const transitioning = committed.sourceKey !== sourceKey || committed.order !== order;
  const error = failure?.sourceKey === sourceKey ? failure.value : null;
  return {
    committedKey: committed.dataKey,
    committedOrder: committed.order,
    error, images: enabled ? images : [], hasMore: enabled && hasMore,
    initialLoading: enabled && (initialLoading || (transitioning && error === null)),
    loadMore, removeImage, updateImage, refreshImage,
    retry: () => {
      pausedRef.current = false;
      const expired = isApiClientError(error) && error.code === "cursor_expired";
      if (expired) {
        fence();
        recentRef.current.clear();
        discardedRef.current = false;
      }
      void request(expired || Boolean(failure?.replace) || imagesRef.current.length === 0 || transitioning);
    }
  };
}
