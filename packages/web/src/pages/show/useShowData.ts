import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PublicImageListResponseDto,
  RandomImageJsonResponseDto,
  ShowOrder
} from "@imageshow/shared/browser";
import { api } from "../../lib/api/client.js";
import type { GalleryFilters } from "../../lib/gallery/gallery-query.js";
import {
  galleryRandomRequestDevice,
  showOrderedApiSearchParams
} from "../../lib/gallery/gallery-query.js";
import { buildRandomUrl } from "../../lib/gallery/random-url.js";
import type { ShowImage } from "./show-layout.js";

const showBatchSize = 200;
const showMaximumRetainedDtos = 800;

function randomBatchPath(filters: GalleryFilters) {
  const value = buildRandomUrl({
    origin: "",
    device: galleryRandomRequestDevice(filters.device),
    brightness: filters.brightness || "random",
    theme: filters.theme,
    tag: filters.tag,
    author: filters.author,
    mode: "json"
  });
  const url = new URL(value, window.location.origin);
  url.searchParams.set("limit", String(showBatchSize));
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function orderedBatchPath(
  filters: GalleryFilters,
  order: Exclude<ShowOrder, "random">,
  cursor: string
) {
  const params = showOrderedApiSearchParams(filters, order, {
    cursor,
    userAgent: window.navigator.userAgent
  });
  params.set("limit", String(showBatchSize));
  return `/api/images?${params.toString()}`;
}

function appendUnique(
  current: ShowImage[],
  incoming: readonly ShowImage[]
) {
  const byId = new Map(current.map((image) => [image.id, image]));
  const originalSize = byId.size;
  for (const image of incoming) {
    if (!image.id || byId.has(image.id)) continue;
    byId.set(image.id, image);
    if (byId.size >= showMaximumRetainedDtos) break;
  }
  return {
    added: byId.size - originalSize,
    images: byId.size === originalSize ? current : [...byId.values()]
  };
}

/**
 * Owns the single bounded Show request stream. A filter/order transition keeps
 * the previous committed plane frozen until the replacement batch succeeds,
 * then swaps its data key and DTO set in one React commit.
 */
export function useShowData(
  filters: GalleryFilters,
  sourceKey: string,
  order: ShowOrder
) {
  const [images, setImages] = useState<ShowImage[]>([]);
  const [committedKey, setCommittedKey] = useState(sourceKey);
  const [committedOrder, setCommittedOrder] = useState(order);
  const [failure, setFailure] = useState<{
    sourceKey: string;
    value: unknown;
    replace: boolean;
  } | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const requestRef = useRef<{ controller: AbortController; replace: boolean } | null>(null);
  const generationRef = useRef(0);
  const imagesRef = useRef<ShowImage[]>([]);
  const committedKeyRef = useRef(sourceKey);
  const cursorRef = useRef("");
  const canLoadMoreRef = useRef(true);
  const requestFilters = useMemo(() => filters, [
    filters.author,
    filters.brightness,
    filters.device,
    filters.tag,
    filters.theme
  ]);
  const randomPath = useMemo(
    () => randomBatchPath(requestFilters),
    [requestFilters]
  );
  imagesRef.current = images;

  const request = useCallback(async (replace: boolean) => {
    if (requestRef.current || (!replace && !canLoadMoreRef.current)) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    const cursor = replace ? "" : cursorRef.current;
    requestRef.current = { controller, replace };
    setFailure(null);
    if (replace) setInitialLoading(true);
    try {
      let responseItems: ShowImage[];
      let nextCursor = "";
      if (order === "random") {
        const response = await api<RandomImageJsonResponseDto>(randomPath, {
          signal: controller.signal
        });
        responseItems = response.items;
      } else {
        const response = await api<PublicImageListResponseDto>(orderedBatchPath(
          requestFilters,
          order,
          cursor
        ), { signal: controller.signal });
        responseItems = response.items;
        nextCursor = response.next_cursor ?? "";
      }
      if (generationRef.current !== generation) return;
      const previous = replace ? [] : imagesRef.current;
      const next = appendUnique(previous, responseItems);
      cursorRef.current = nextCursor;
      canLoadMoreRef.current = (
        next.images.length < showMaximumRetainedDtos
        && next.added > 0
        && responseItems.length > 0
        && (order === "random" || nextCursor.length > 0)
      );
      imagesRef.current = next.images;
      if (replace || next.images !== previous) setImages(next.images);
      if (replace) {
        committedKeyRef.current = sourceKey;
        setCommittedKey(sourceKey);
        setCommittedOrder(order);
      }
    } catch (requestError) {
      if (!controller.signal.aborted && generationRef.current === generation) {
        // Scene reconciliation may ask again every frame. A failed stream
        // resumes only through Retry or a new filter/order generation.
        canLoadMoreRef.current = false;
        setFailure({ sourceKey, value: requestError, replace });
      }
    } finally {
      if (requestRef.current?.controller === controller) requestRef.current = null;
      if (generationRef.current === generation) {
        setInitialLoading(false);
      }
    }
  }, [order, randomPath, requestFilters, sourceKey]);

  useEffect(() => {
    generationRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
    cursorRef.current = "";
    canLoadMoreRef.current = true;
    setFailure(null);
    setInitialLoading(true);
    void request(true);
    return () => {
      generationRef.current += 1;
      requestRef.current?.controller.abort();
      requestRef.current = null;
    };
  }, [request, sourceKey]);

  const removeImage = useCallback((imageId: string) => {
    const interrupted = requestRef.current;
    generationRef.current += 1;
    interrupted?.controller.abort();
    requestRef.current = null;
    const next = imagesRef.current.filter((image) => image.id !== imageId);
    imagesRef.current = next;
    setImages(next);
    // Restart an interrupted read only after the deletion has committed. Its
    // old response cannot resurrect the removed ID, even if abort arrives late.
    if (interrupted) void request(interrupted.replace);
  }, [request]);

  const refreshImages = useCallback(() => {
    generationRef.current += 1;
    requestRef.current?.controller.abort();
    requestRef.current = null;
    canLoadMoreRef.current = true;
    // Membership is decided by the same Server query as the stream, including
    // include/exclude selectors and device=auto. Keep the old plane until ready.
    void request(true);
  }, [request]);

  const transitioning = committedKey !== sourceKey || committedOrder !== order;
  const error = failure?.sourceKey === sourceKey ? failure.value : null;

  return {
    committedKey,
    committedOrder,
    error,
    images,
    initialLoading: initialLoading || (transitioning && error === null),
    loadMore: () => void request(false),
    removeImage,
    retry: () => {
      canLoadMoreRef.current = true;
      void request(
        (failure?.sourceKey === sourceKey && failure.replace)
        || imagesRef.current.length === 0
        || committedKeyRef.current !== sourceKey
      );
    },
    refreshImages
  };
}
