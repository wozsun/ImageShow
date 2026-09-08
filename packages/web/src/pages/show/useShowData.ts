import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PublicImageListResponseDto, ShowOrder } from "@imageshow/shared/browser";
import { api, ApiClientError, isApiClientError } from "../../lib/api/client.js";
import { imageBrowseApiSearchParams, type GalleryFilters } from "../../lib/gallery/gallery-query.js";
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
  initialLimit = 200
) {
  const [images, setImages] = useState<ShowImage[]>([]);
  const [committed, setCommitted] = useState({ sourceKey, order, dataKey: sourceKey });
  const [hasMore, setHasMore] = useState(true);
  const [failure, setFailure] = useState<{ sourceKey: string; value: unknown; replace: boolean } | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const requestRef = useRef<{ controller: AbortController; replace: boolean } | null>(null);
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
  const pathsRef = useRef(new Map<string, string>());
  const confirmedRef = useRef(new Map<string, ShowImage>());
  const usageRef = useRef<ShowCandidateUsage | null>(null);
  const initialLimitRef = useRef(initialLimit);
  initialLimitRef.current = initialLimit;
  const requestFilters = useMemo(() => filters, [
    filters.author, filters.brightness, filters.device, filters.tag, filters.theme
  ]);

  const publish = useCallback((next: ShowImage[]) => {
    imagesRef.current = next;
    setImages(next);
    const ids = new Set(next.map((image) => image.id));
    for (const id of pathsRef.current.keys()) if (!ids.has(id)) pathsRef.current.delete(id);
    // Confirmed base fields only need to outlive their resident card.
    for (const id of confirmedRef.current.keys()) if (!ids.has(id)) confirmedRef.current.delete(id);
  }, []);

  const request = useCallback(async (replace: boolean, validate = false) => {
    if (requestRef.current || pausedRef.current) return;
    if (!replace && endedRef.current && !discardedRef.current) return;
    const limit = replace ? initialLimitRef.current : continuationLimit;
    if (!replace && imagesRef.current.length + limit > maximumRetainedDtos) return;
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
      // Entirely repeated batches still advance their scan boundary. Limit
      // consecutive empty admissions so changing small sets cannot busy-loop.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const params = imageBrowseApiSearchParams(requestFilters, order, {
          view: "show", limit, cursor, userAgent: window.navigator.userAgent
        });
        const path = `/api/images?${params}`;
        const response = await api<PublicImageListResponseDto<"show">>(path, {
          signal: controller.signal, ...(validate ? { cache: "no-cache" as const } : {})
        });
        if (generationRef.current !== generation || controller.signal.aborted) return;
        if (response.next_cursor && response.next_cursor === cursor) {
          throw new ApiClientError("图片分页未能继续，请重试", 503, "browse_cursor_stalled");
        }
        const previous = replace ? [] : imagesRef.current;
        const ids = new Set(previous.map((image) => image.id));
        const incoming: ShowImage[] = [];
        for (const item of response.items) {
          if (!item.id || ids.has(item.id) || removedRef.current.has(item.id)) continue;
          if (!replace && recentRef.current.has(item.id)) continue;
          ids.add(item.id);
          incoming.push(confirmedRef.current.get(item.id) ?? item);
        }
        if (previous.length + incoming.length > maximumRetainedDtos) {
          throw new ApiClientError("图片候选容量不足，请重试", 503, "browse_capacity_exceeded");
        }
        const accepted = order === "random" ? shuffledImageBatch(incoming) : incoming;
        for (const item of accepted) {
          recentRef.current.delete(item.id);
          recentRef.current.add(item.id);
          pathsRef.current.set(item.id, path);
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
      throw new ApiClientError("暂未取得新的图片候选，请重试", 503, "browse_refill_exhausted");
    } catch (error) {
      if (!controller.signal.aborted && generationRef.current === generation) {
        pausedRef.current = true;
        setFailure({ sourceKey, value: error, replace });
      }
    } finally {
      if (requestRef.current?.controller === controller) requestRef.current = null;
      if (generationRef.current === generation) setInitialLoading(false);
    }
  }, [order, publish, requestFilters, sourceKey]);

  const fence = useCallback((imageId?: string) => {
    const replacing = requestRef.current?.replace === true;
    generationRef.current += 1;
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
    pathsRef.current.clear();
    confirmedRef.current.clear();
    setFailure(null);
    setHasMore(true);
    void request(true);
    return () => { fence(); };
  }, [fence, request]);

  const loadMore = useCallback((usage?: ShowCandidateUsage) => {
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
    void request(false);
  }, [publish, request, sourceKey]);

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
    const path = pathsRef.current.get(imageId);
    if (!path) return;
    confirmedRef.current.delete(imageId);
    if (fence(imageId)) {
      void request(true, true);
      return;
    }
    const controller = new AbortController();
    targetedRequestsRef.current.set(imageId, controller);
    void api<PublicImageListResponseDto<"show">>(path, { signal: controller.signal, cache: "no-cache" })
      .then((response) => {
        if (targetedRequestsRef.current.get(imageId) !== controller) return;
        const image = response.items.find((item) => item.id === imageId);
        if (!image) { removeImage(imageId, true); return; }
        publish(imagesRef.current.map((item) => item.id === imageId ? image : item));
      })
      .catch((error: unknown) => {
        if (targetedRequestsRef.current.get(imageId) === controller && isApiClientError(error) && error.status === 404) {
          removeImage(imageId, true);
        }
      })
      .finally(() => {
        if (targetedRequestsRef.current.get(imageId) === controller) targetedRequestsRef.current.delete(imageId);
      });
  }, [fence, publish, removeImage, request]);

  const transitioning = committed.sourceKey !== sourceKey || committed.order !== order;
  const error = failure?.sourceKey === sourceKey ? failure.value : null;
  return {
    committedKey: committed.dataKey,
    committedOrder: committed.order,
    error, images, hasMore,
    initialLoading: initialLoading || (transitioning && error === null),
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
