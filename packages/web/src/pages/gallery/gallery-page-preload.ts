import type { MasonryItemPosition } from "./masonry-layout.js";

export type GalleryPagePreloadRange = {
  top: number;
  height: number;
};

export function galleryPagePreloadRequestKey(
  imageQuery: string,
  nextPageCursor: string
) {
  return nextPageCursor ? `${imageQuery}\n${nextPageCursor}` : "";
}

export class GalleryPagePreloadGate {
  #sessionKey = "";
  #requestedKey = "";
  #claimSequence = 0;

  beginSession(sessionKey: string) {
    if (this.#sessionKey === sessionKey) return;
    this.#sessionKey = sessionKey;
    this.#requestedKey = "";
  }

  claim(requestKey: string, retry = false) {
    if (!requestKey || (!retry && this.#requestedKey === requestKey)) {
      return null;
    }
    this.#requestedKey = requestKey;
    this.#claimSequence += 1;
    return this.#claimSequence;
  }

  rearmIfUnfulfilled(
    requestKey: string,
    requestedCursor: string,
    loadedPageParams: readonly string[],
    hasNextPageError: boolean,
    claimSequence?: number
  ) {
    if (
      !requestKey
      || !requestedCursor
      || hasNextPageError
      || loadedPageParams.includes(requestedCursor)
      || this.#requestedKey !== requestKey
      || (claimSequence !== undefined && this.#claimSequence !== claimSequence)
    ) {
      return false;
    }
    this.#requestedKey = "";
    return true;
  }
}

function normalizedItemCount(count: number) {
  return Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
}

/**
 * Returns the vertical band occupied by the latest cursor page. Masonry items
 * from adjacent pages may overlap vertically, so both the page item boundaries
 * and every matching position are needed instead of a single boundary item.
 */
export function galleryPagePreloadRange(
  pageItemCounts: readonly number[],
  positions: readonly MasonryItemPosition[],
  totalHeight: number
): GalleryPagePreloadRange | null {
  if (pageItemCounts.length === 0) return null;

  const lastPageIndex = pageItemCounts.length - 1;
  const startIndex = pageItemCounts
    .slice(0, lastPageIndex)
    .reduce((total, count) => total + normalizedItemCount(count), 0);
  const endIndex = startIndex + normalizedItemCount(
    pageItemCounts[lastPageIndex] ?? 0
  );
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  for (const position of positions) {
    if (position.index < startIndex || position.index >= endIndex) continue;
    top = Math.min(top, position.y);
    bottom = Math.max(bottom, position.bottom);
  }

  if (Number.isFinite(top) && Number.isFinite(bottom)) {
    return {
      top: Math.max(0, top),
      height: Math.max(1, bottom - top)
    };
  }

  // A locally emptied last page must not strand a still-valid next cursor.
  return {
    top: Math.max(0, totalHeight - 1),
    height: 1
  };
}
