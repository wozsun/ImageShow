import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import {
  useQueryClient,
  type InfiniteData,
  type QueryKey,
  type UseInfiniteQueryResult
} from "@tanstack/react-query";
import type { PublicImageListResponseDto } from "@imageshow/shared/browser";
import type { MasonryItemPosition } from "./masonry-layout.js";
import {
  GalleryPagePreloadGate,
  galleryPagePreloadRange,
  galleryPagePreloadRequestKey
} from "./gallery-page-preload.js";

type GalleryImagePages = UseInfiniteQueryResult<
  InfiniteData<PublicImageListResponseDto, string>,
  Error
>;

/** Owns forward-page claims, observer rearming, and explicit retries. */
export function useGalleryPagePreload({
  imageQuery,
  imagePages,
  publicImagesQueryKey,
  positions,
  totalHeight
}: {
  imageQuery: string;
  imagePages: GalleryImagePages;
  publicImagesQueryKey: QueryKey;
  positions: readonly MasonryItemPosition[];
  totalHeight: number;
}) {
  const queryClient = useQueryClient();
  const preloadRef = useRef<HTMLSpanElement | null>(null);
  const gateRef = useRef<GalleryPagePreloadGate | null>(null);
  const [revision, setRevision] = useState(0);
  if (!gateRef.current) gateRef.current = new GalleryPagePreloadGate();

  useEffect(() => {
    gateRef.current?.beginSession(imageQuery);
  }, [imageQuery]);

  const range = useMemo(() => galleryPagePreloadRange(
    imagePages.data?.pages.map((page) => page.items.length) ?? [],
    positions,
    totalHeight
  ), [imagePages.data?.pages, positions, totalHeight]);
  const nextCursor = imagePages.data?.pages.at(-1)?.next_cursor ?? "";
  const requestKey = galleryPagePreloadRequestKey(imageQuery, nextCursor);

  const requestNextPage = useCallback((retry = false) => {
    const liveFetchStatus = queryClient.getQueryState(
      publicImagesQueryKey
    )?.fetchStatus;
    if (
      !requestKey
      || !imagePages.hasNextPage
      || imagePages.fetchStatus !== "idle"
      || liveFetchStatus !== "idle"
    ) {
      return;
    }
    const claimSequence = gateRef.current?.claim(requestKey, retry);
    if (claimSequence == null) return;

    void imagePages.fetchNextPage({ cancelRefetch: false }).then((result) => {
      if (gateRef.current?.rearmIfUnfulfilled(
        requestKey,
        nextCursor,
        result.data?.pageParams ?? [],
        result.isFetchNextPageError,
        claimSequence
      )) {
        setRevision((current) => current + 1);
      }
    });
  }, [
    imagePages.fetchNextPage,
    imagePages.fetchStatus,
    imagePages.hasNextPage,
    nextCursor,
    publicImagesQueryKey,
    queryClient,
    requestKey
  ]);

  useEffect(() => {
    if (
      imagePages.fetchStatus !== "idle"
      || !requestKey
      || !gateRef.current?.rearmIfUnfulfilled(
        requestKey,
        nextCursor,
        imagePages.data?.pageParams ?? [],
        imagePages.isFetchNextPageError
      )
    ) {
      return;
    }
    setRevision((current) => current + 1);
  }, [
    imagePages.data?.pageParams,
    imagePages.fetchStatus,
    imagePages.isFetchNextPageError,
    nextCursor,
    requestKey
  ]);

  useEffect(() => {
    const target = preloadRef.current;
    if (!target || !range || !requestKey) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) requestNextPage();
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [range, requestKey, requestNextPage, revision]);

  return {
    pagePreloadRange: range,
    pagePreloadRef: preloadRef,
    nextPageRequestKey: requestKey,
    requestNextPage
  };
}
