import type { PublicImageListResponseDto } from "@imageshow/shared/browser";
import {
  galleryDataWindowFullItemBudget,
  galleryMaxMountedTiles
} from "../../lib/constants.js";
import type {
  EditableImageSnapshot,
  GalleryImageCard
} from "../../lib/types.js";
import { hasDistinctOriginalUrl } from "../../lib/image-url.js";
import {
  CompactMasonryLayout,
  galleryImageNumericRatio,
  type CompactMasonryPosition,
  type GalleryCompactGeometry
} from "./compact-masonry-layout.js";

type GalleryWindowPage = {
  cursor: string;
  nextCursor: string;
  ids: string[];
  items: GalleryImageCard[] | null;
  fullBytes: number;
  startIndex: number;
  top: number;
  bottom: number;
};

export type GalleryDataWindowViewport = {
  start: number;
  end: number;
  visibleStart: number;
  visibleEnd: number;
  preloadEnd: number;
};

export type GalleryPageIntent = {
  cursor: string;
  kind: "initial" | "hydrate" | "append";
};

export type GalleryPageRequest = GalleryPageIntent & {
  token: number;
};

type GalleryPageFailure = {
  error: Error;
  kind: GalleryPageIntent["kind"];
};

export type GalleryWindowPosition = CompactMasonryPosition & {
  id: string;
  item: GalleryImageCard | null;
  pageIndex: number;
};

export type GalleryDataWindowSnapshot = {
  revision: number;
  fetchedPages: number;
  retainedPages: number;
  compactItems: number;
  fullItems: number;
  pendingQueryPages: number;
  pendingAppendPages: number;
  failedQueryPages: number;
  totalHeight: number;
  columnWidth: number;
  hasNextPage: boolean;
  compactLayoutBytes: number;
  estimatedCompactBytes: number;
  estimatedFullDtoBytes: number;
  error: Error | null;
  errorRequest: (GalleryPageIntent & {
    top: number | null;
    bottom: number | null;
  }) | null;
};

export type GalleryDataWindowDebugSnapshot = GalleryDataWindowSnapshot & {
  materializedPositions: number;
};

function estimateCardBytes(item: GalleryImageCard) {
  const stringCharacters = item.id.length
    + item.title.length
    + item.theme.length
    + item.author.length
    + item.thumb_url.length
    + item.image_time.length
    + item.tags.reduce((total, tag) => total + tag.length, 0);
  return stringCharacters * 2 + item.tags.length * 8 + 96;
}

function pageFullBytes(items: readonly GalleryImageCard[]) {
  return items.reduce((total, item) => total + estimateCardBytes(item), 0);
}

function itemsInStoredOrder(
  ids: readonly string[],
  items: readonly GalleryImageCard[],
  retainedItems?: readonly GalleryImageCard[] | null
) {
  if (ids.length !== items.length) return null;
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length) return null;
  const retainedById = new Map(
    (retainedItems ?? []).map((item) => [item.id, item])
  );
  const ordered = ids.map((id) => {
    const item = byId.get(id);
    if (!item) return undefined;
    const retained = retainedById.get(id);
    return retained && galleryCardsEqual(retained, item) ? retained : item;
  });
  return ordered.every((item) => item !== undefined)
    ? ordered as GalleryImageCard[]
    : null;
}

function galleryCardsEqual(
  left: GalleryImageCard,
  right: GalleryImageCard
) {
  return left.id === right.id
    && left.title === right.title
    && left.device === right.device
    && left.brightness === right.brightness
    && left.theme === right.theme
    && left.author === right.author
    && left.thumb_url === right.thumb_url
    && left.width === right.width
    && left.height === right.height
    && left.diff_original === right.diff_original
    && left.image_time === right.image_time
    && left.tags.length === right.tags.length
    && left.tags.every((tag, index) => tag === right.tags[index]);
}

function galleryCardFromSnapshot(
  current: GalleryImageCard,
  snapshot: EditableImageSnapshot
): GalleryImageCard {
  const next = {
    id: current.id,
    title: snapshot.title,
    device: snapshot.device,
    brightness: snapshot.brightness,
    theme: snapshot.theme,
    author: snapshot.author,
    thumb_url: snapshot.thumb_url,
    width: snapshot.width,
    height: snapshot.height,
    tags: [...snapshot.tags],
    diff_original: hasDistinctOriginalUrl(
      snapshot.original,
      snapshot.object_url
    ),
    image_time: current.image_time
  } satisfies GalleryImageCard;
  return galleryCardsEqual(current, next) ? current : next;
}

function requestCursorCharacters(page: GalleryWindowPage) {
  return page.cursor.length + page.nextCursor.length;
}

/**
 * Owns cursor boundaries, compact layout, DTO retention and page hydration.
 * Full page payloads are bounded; every fetched page keeps only its cursor,
 * ordered IDs and typed-array layout metadata after eviction.
 */
export class GalleryDataWindow {
  readonly #listeners = new Set<() => void>();
  readonly #layout: CompactMasonryLayout;
  readonly #fullItemBudget: number;
  readonly #pendingCursors = new Map<
    string,
    Pick<GalleryPageRequest, "kind" | "token">
  >();
  readonly #failedCursors = new Map<string, GalleryPageFailure>();
  #pages: GalleryWindowPage[] = [];
  #activePageIndexes = new Set<number>();
  #itemCount = 0;
  #idCharacters = 0;
  #fullBytes = 0;
  #revision = 0;
  #nextRequestToken = 0;
  #materializedPositions = 0;
  #lastViewport: GalleryDataWindowViewport = {
    start: 0,
    end: 0,
    visibleStart: 0,
    visibleEnd: 0,
    preloadEnd: 0
  };
  #pinnedId: string | null = null;
  #snapshot: GalleryDataWindowSnapshot;

  constructor({
    geometry,
    fullItemBudget = galleryDataWindowFullItemBudget
  }: {
    geometry: GalleryCompactGeometry;
    fullItemBudget?: number;
  }) {
    this.#layout = new CompactMasonryLayout(geometry);
    this.#fullItemBudget = Math.max(1, Math.floor(fullItemBudget));
    this.#snapshot = this.#createSnapshot();
  }

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  snapshot = () => this.#snapshot;

  debugSnapshot = (): GalleryDataWindowDebugSnapshot => ({
    ...this.#snapshot,
    materializedPositions: this.#materializedPositions
  });

  setGeometry(geometry: GalleryCompactGeometry) {
    if (!this.#layout.setGeometry(geometry)) return false;
    this.#recalculatePageBounds();
    this.#applyRetention();
    this.#commit();
    return true;
  }

  claimRequest(intent: GalleryPageIntent): GalleryPageRequest | null {
    if (this.#pendingCursors.has(intent.cursor)) return null;
    const request = {
      ...intent,
      token: this.#nextRequestToken += 1
    };
    this.#pendingCursors.set(intent.cursor, {
      kind: intent.kind,
      token: request.token
    });
    this.#failedCursors.delete(intent.cursor);
    this.#commit();
    return request;
  }

  resolvePage(request: GalleryPageRequest, payload: PublicImageListResponseDto) {
    if (!this.#takePendingRequest(request)) return false;
    const { cursor } = request;
    this.#failedCursors.delete(cursor);
    const pageIndex = this.#pages.findIndex((page) => page.cursor === cursor);
    if (pageIndex >= 0) {
      this.#hydrateOrReplacePage(pageIndex, cursor, payload);
    } else if (
      this.#pages.length === 0
      ? cursor === ""
      : cursor === this.#pages.at(-1)!.nextCursor
    ) {
      this.#appendPage(cursor, payload);
    } else if (cursor === "") {
      this.#resetPages();
      this.#appendPage(cursor, payload);
    } else {
      this.#failedCursors.set(cursor, {
        error: new Error("Gallery page cursor is no longer part of this session"),
        kind: request.kind
      });
    }
    this.#pruneDetachedRequests();
    this.#applyRetention();
    this.#commit();
    return true;
  }

  rejectPage(request: GalleryPageRequest, error: Error) {
    if (!this.#takePendingRequest(request)) return false;
    this.#failedCursors.set(request.cursor, {
      error,
      kind: request.kind
    });
    this.#applyRetention();
    this.#commit();
    return true;
  }

  cancelPage(request: GalleryPageRequest) {
    if (!this.#takePendingRequest(request)) return false;
    this.#commit();
    return true;
  }

  invalidatePendingRequests() {
    if (this.#pendingCursors.size === 0) return false;
    this.#pendingCursors.clear();
    this.#commit();
    return true;
  }

  prepareImageRefresh(
    imageId: string,
    authoritativeItem?: EditableImageSnapshot
  ): GalleryPageIntent | null {
    const itemIndex = this.indexOfId(imageId);
    if (itemIndex < 0) return null;
    const pageIndex = this.#pageIndexAtItem(itemIndex);
    const page = this.#pages[pageIndex];
    if (!page) return null;

    // A successful edit establishes a newer authority boundary than every
    // page request that was already in flight. Fence all of those responses
    // before the Hook awaits network cancellation, then rehydrate the exact
    // cursor page so filter membership and cursor-chain changes are reconciled
    // by the same replacement path as ordinary far-page recovery.
    this.#pendingCursors.clear();
    this.#failedCursors.delete(page.cursor);
    const offset = itemIndex - page.startIndex;
    const currentItem = page.items?.[offset];
    if (currentItem && authoritativeItem?.id === imageId) {
      const nextItem = galleryCardFromSnapshot(
        currentItem,
        authoritativeItem
      );
      if (nextItem !== currentItem) {
        const byteDelta = estimateCardBytes(nextItem)
          - estimateCardBytes(currentItem);
        page.items![offset] = nextItem;
        page.fullBytes += byteDelta;
        this.#fullBytes += byteDelta;
        const geometryChanged = this.#layout.setRatios(itemIndex, [
          galleryImageNumericRatio(
            nextItem.device,
            nextItem.width,
            nextItem.height
          )
        ]);
        if (geometryChanged) this.#recalculatePageBounds();
      }
    }
    this.#activePageIndexes.add(pageIndex);
    this.#commit();
    return { cursor: page.cursor, kind: "hydrate" };
  }

  updateViewport(
    viewport: GalleryDataWindowViewport,
    pinnedId: string | null
  ) {
    this.#lastViewport = viewport;
    this.#pinnedId = pinnedId;
    const retentionChanged = this.#applyRetention();
    if (retentionChanged) this.#commit();
    return this.#requestPlan();
  }

  retryRequest(cursor: string): GalleryPageIntent | null {
    const failure = this.#failedCursors.get(cursor);
    if (!failure || this.#pendingCursors.has(cursor)) {
      return null;
    }
    return {
      cursor,
      kind: failure.kind
    };
  }

  windowPositions({
    start,
    end,
    visibleStart,
    visibleEnd,
    pinnedId
  }: {
    start: number;
    end: number;
    visibleStart: number;
    visibleEnd: number;
    pinnedId: string | null;
  }): GalleryWindowPosition[] {
    const pinnedIndex = pinnedId ? this.indexOfId(pinnedId) : -1;
    const indexes = this.#layout.windowIndexes({
      start,
      end,
      maxItems: galleryMaxMountedTiles,
      priorityStart: visibleStart,
      priorityEnd: visibleEnd,
      pinnedIndex
    });
    const positions = indexes.flatMap((index) => {
      const pageIndex = this.#pageIndexAtItem(index);
      if (pageIndex < 0) return [];
      const page = this.#pages[pageIndex]!;
      const offset = index - page.startIndex;
      const position = this.#layout.position(index);
      const id = page.ids[offset];
      if (!position || !id) return [];
      return [{
        ...position,
        id,
        item: page.items?.[offset] ?? null,
        pageIndex
      }];
    });
    this.#materializedPositions = positions.length;
    return positions;
  }

  indexOfId(imageId: string) {
    for (const page of this.#pages) {
      const offset = page.ids.indexOf(imageId);
      if (offset >= 0) return page.startIndex + offset;
    }
    return -1;
  }

  positionForId(imageId: string) {
    return this.#layout.position(this.indexOfId(imageId));
  }

  removeImage(imageId: string) {
    const index = this.indexOfId(imageId);
    if (index < 0) {
      return { removed: false, index: -1, focusId: null as string | null };
    }
    const focusId = this.#idAt(index + 1) ?? this.#idAt(index - 1);
    const pageIndex = this.#pageIndexAtItem(index);
    const page = this.#pages[pageIndex]!;
    const offset = index - page.startIndex;
    const fullItem = page.items?.[offset];
    page.ids.splice(offset, 1);
    page.items?.splice(offset, 1);
    this.#idCharacters -= imageId.length;
    if (fullItem) {
      const removedBytes = estimateCardBytes(fullItem);
      page.fullBytes = Math.max(0, page.fullBytes - removedBytes);
      this.#fullBytes = Math.max(0, this.#fullBytes - removedBytes);
    }
    this.#layout.remove(index);
    this.#itemCount -= 1;
    for (let next = pageIndex + 1; next < this.#pages.length; next += 1) {
      this.#pages[next]!.startIndex -= 1;
    }
    this.#recalculatePageBounds();
    this.#applyRetention();
    this.#commit();
    return { removed: true, index, focusId };
  }

  #requestPlan(): GalleryPageIntent[] {
    if (this.#pages.length === 0) {
      return this.#requestAvailable("")
        ? [{ cursor: "", kind: "initial" }]
        : [];
    }
    const center = (
      this.#lastViewport.visibleStart + this.#lastViewport.visibleEnd
    ) / 2;
    const hydration = [...this.#activePageIndexes]
      .filter((pageIndex) => {
        const page = this.#pages[pageIndex];
        return page && !page.items && this.#requestAvailable(page.cursor);
      })
      .sort((left, right) => {
        const leftPage = this.#pages[left]!;
        const rightPage = this.#pages[right]!;
        const leftCenter = (leftPage.top + leftPage.bottom) / 2;
        const rightCenter = (rightPage.top + rightPage.bottom) / 2;
        return Math.abs(leftCenter - center) - Math.abs(rightCenter - center);
      })
      .map((pageIndex) => ({
        cursor: this.#pages[pageIndex]!.cursor,
        kind: "hydrate" as const
      }));
    const lastPage = this.#pages.at(-1)!;
    const append = lastPage.nextCursor
      && this.#lastViewport.preloadEnd >= lastPage.top
      && this.#requestAvailable(lastPage.nextCursor)
      ? [{ cursor: lastPage.nextCursor, kind: "append" as const }]
      : [];
    return [...hydration, ...append];
  }

  #requestAvailable(cursor: string) {
    return !this.#pendingCursors.has(cursor)
      && !this.#failedCursors.has(cursor);
  }

  #takePendingRequest(request: GalleryPageRequest) {
    const pending = this.#pendingCursors.get(request.cursor);
    if (!pending || pending.token !== request.token) return false;
    this.#pendingCursors.delete(request.cursor);
    return true;
  }

  #pruneDetachedRequests() {
    const currentCursors = new Set(this.#pages.map((page) => page.cursor));
    const nextCursor = this.#pages.at(-1)?.nextCursor ?? "";
    for (const cursor of this.#pendingCursors.keys()) {
      if (!currentCursors.has(cursor) && cursor !== nextCursor) {
        this.#pendingCursors.delete(cursor);
      }
    }
    for (const cursor of this.#failedCursors.keys()) {
      if (!currentCursors.has(cursor) && cursor !== nextCursor) {
        this.#failedCursors.delete(cursor);
      }
    }
  }

  #hydrateOrReplacePage(
    pageIndex: number,
    cursor: string,
    payload: PublicImageListResponseDto
  ) {
    const page = this.#pages[pageIndex]!;
    // `shuffle=1` deliberately returns the same keyset page in a new order on
    // every request. Preserve this session's original order when the ID set is
    // unchanged; only a real insertion/deletion invalidates later boundaries.
    const orderedItems = itemsInStoredOrder(
      page.ids,
      payload.items,
      page.items
    );
    if (!orderedItems) {
      this.#truncatePages(pageIndex);
      this.#appendPage(cursor, payload);
      return;
    }
    if (page.items) {
      this.#fullBytes -= page.fullBytes;
    }
    page.items = orderedItems;
    page.fullBytes = pageFullBytes(orderedItems);
    this.#fullBytes += page.fullBytes;
    const geometryChanged = this.#layout.setRatios(
      page.startIndex,
      orderedItems.map((item) => galleryImageNumericRatio(
        item.device,
        item.width,
        item.height
      ))
    );
    const nextCursor = payload.next_cursor ?? "";
    if (page.nextCursor !== nextCursor && pageIndex < this.#pages.length - 1) {
      page.nextCursor = nextCursor;
      this.#truncatePages(pageIndex + 1);
    } else {
      page.nextCursor = nextCursor;
    }
    if (geometryChanged) this.#recalculatePageBounds();
  }

  #appendPage(cursor: string, payload: PublicImageListResponseDto) {
    const items = [...payload.items];
    const page: GalleryWindowPage = {
      cursor,
      nextCursor: payload.next_cursor ?? "",
      ids: items.map((item) => item.id),
      items,
      fullBytes: pageFullBytes(items),
      startIndex: this.#itemCount,
      top: this.#layout.totalHeight,
      bottom: this.#layout.totalHeight
    };
    for (const item of items) {
      this.#layout.append(galleryImageNumericRatio(
        item.device,
        item.width,
        item.height
      ));
      this.#idCharacters += item.id.length;
      this.#itemCount += 1;
    }
    const bounds = this.#layout.pageBounds(page.startIndex, page.ids.length);
    page.top = bounds.top;
    page.bottom = bounds.bottom;
    this.#pages.push(page);
    this.#fullBytes += page.fullBytes;
  }

  #truncatePages(startPageIndex: number) {
    const start = Math.max(0, Math.min(this.#pages.length, startPageIndex));
    const firstRemoved = this.#pages[start];
    if (!firstRemoved) return;
    for (const page of this.#pages.slice(start)) {
      this.#idCharacters -= page.ids.reduce(
        (total, id) => total + id.length,
        0
      );
      if (page.items) this.#fullBytes -= page.fullBytes;
    }
    this.#itemCount = firstRemoved.startIndex;
    this.#layout.truncate(this.#itemCount);
    this.#pages.splice(start);
    this.#activePageIndexes = new Set(
      [...this.#activePageIndexes].filter((index) => index < start)
    );
  }

  #resetPages() {
    this.#pages = [];
    this.#activePageIndexes.clear();
    this.#itemCount = 0;
    this.#idCharacters = 0;
    this.#fullBytes = 0;
    this.#layout.truncate(0);
  }

  #applyRetention() {
    if (this.#pages.length === 0) return false;
    const visiblePages: number[] = [];
    for (const [index, page] of this.#pages.entries()) {
      if (
        page.bottom >= this.#lastViewport.start
        && page.top <= this.#lastViewport.end
      ) {
        visiblePages.push(index);
      }
    }
    if (visiblePages.length === 0) {
      let closest = 0;
      let distance = Number.POSITIVE_INFINITY;
      const center = (
        this.#lastViewport.visibleStart + this.#lastViewport.visibleEnd
      ) / 2;
      for (const [index, page] of this.#pages.entries()) {
        const nextDistance = Math.abs((page.top + page.bottom) / 2 - center);
        if (nextDistance < distance) {
          closest = index;
          distance = nextDistance;
        }
      }
      visiblePages.push(closest);
    }

    const viewportCenter = (
      this.#lastViewport.visibleStart + this.#lastViewport.visibleEnd
    ) / 2;
    visiblePages.sort((left, right) => {
      const leftPage = this.#pages[left]!;
      const rightPage = this.#pages[right]!;
      return Math.abs((leftPage.top + leftPage.bottom) / 2 - viewportCenter)
        - Math.abs((rightPage.top + rightPage.bottom) / 2 - viewportCenter);
    });
    const desired = new Set<number>();
    let desiredItems = 0;
    for (const index of visiblePages) {
      const count = this.#pages[index]!.ids.length;
      if (desired.size > 0 && desiredItems + count > this.#fullItemBudget) {
        continue;
      }
      desired.add(index);
      desiredItems += count;
    }
    const centerPage = [...desired].reduce((total, index) => total + index, 0)
      / desired.size;
    const candidates = this.#pages
      .map((_, index) => index)
      .filter((index) => !desired.has(index))
      .sort((left, right) => (
        Math.abs(left - centerPage) - Math.abs(right - centerPage)
    ));
    for (const index of candidates) {
      const count = this.#pages[index]!.ids.length;
      if (count === 0) continue;
      if (desiredItems + count > this.#fullItemBudget) continue;
      desired.add(index);
      desiredItems += count;
    }
    const pinnedIndex = this.#pinnedId ? this.indexOfId(this.#pinnedId) : -1;
    if (pinnedIndex >= 0) desired.add(this.#pageIndexAtItem(pinnedIndex));

    let changed = false;
    const appendCursor = this.#pages.at(-1)?.nextCursor ?? "";
    for (const cursor of this.#failedCursors.keys()) {
      const pageIndex = this.#pages.findIndex((page) => page.cursor === cursor);
      if (
        (pageIndex >= 0 && desired.has(pageIndex))
        || (
          cursor === appendCursor
          && appendCursor !== ""
          && this.#lastViewport.preloadEnd >= this.#pages.at(-1)!.top
        )
      ) {
        continue;
      }
      this.#failedCursors.delete(cursor);
      changed = true;
    }
    for (const [index, page] of this.#pages.entries()) {
      if (desired.has(index) || !page.items) continue;
      this.#fullBytes -= page.fullBytes;
      page.items = null;
      page.fullBytes = 0;
      changed = true;
    }
    this.#activePageIndexes = desired;
    return changed;
  }

  #recalculatePageBounds() {
    for (const page of this.#pages) {
      const bounds = this.#layout.pageBounds(page.startIndex, page.ids.length);
      page.top = bounds.top;
      page.bottom = bounds.bottom;
    }
  }

  #pageIndexAtItem(index: number) {
    if (index < 0 || index >= this.#itemCount) return -1;
    let lower = 0;
    let upper = this.#pages.length;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      if (this.#pages[middle]!.startIndex <= index) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    for (let pageIndex = lower - 1; pageIndex >= 0; pageIndex -= 1) {
      const page = this.#pages[pageIndex]!;
      if (index < page.startIndex + page.ids.length) return pageIndex;
    }
    return -1;
  }

  #idAt(index: number) {
    const pageIndex = this.#pageIndexAtItem(index);
    if (pageIndex < 0) return null;
    const page = this.#pages[pageIndex]!;
    return page.ids[index - page.startIndex] ?? null;
  }

  #createSnapshot(): GalleryDataWindowSnapshot {
    const retainedPages = this.#pages.filter((page) => page.items).length;
    const fullItems = this.#pages.reduce(
      (total, page) => total + (page.items?.length ?? 0),
      0
    );
    const cursorCharacters = this.#pages.reduce(
      (total, page) => total + requestCursorCharacters(page),
      0
    );
    const compactLayoutBytes = this.#layout.itemByteLength;
    const estimatedCompactBytes = compactLayoutBytes
      + this.#idCharacters * 2
      + this.#itemCount * 8
      + cursorCharacters * 2
      + this.#pages.length * 96;
    const failures = [...this.#failedCursors.entries()];
    const firstError = (
      failures.find(([, failure]) => failure.kind === "hydrate")
      ?? failures[0]
    ) as
      | [string, GalleryPageFailure]
      | undefined;
    const errorPage = firstError?.[1].kind === "hydrate"
      ? this.#pages.find((page) => page.cursor === firstError[0])
      : undefined;
    const geometry = this.#layout.geometry;
    const columnWidth = Math.max(
      0,
      (
        geometry.contentWidth - geometry.gap * (geometry.columnCount - 1)
      ) / geometry.columnCount
    );
    return {
      revision: this.#revision,
      fetchedPages: this.#pages.length,
      retainedPages,
      compactItems: this.#itemCount,
      fullItems,
      pendingQueryPages: this.#pendingCursors.size,
      pendingAppendPages: [...this.#pendingCursors.values()].filter(
        ({ kind }) => kind === "append"
      ).length,
      failedQueryPages: this.#failedCursors.size,
      totalHeight: this.#layout.totalHeight,
      columnWidth,
      hasNextPage: Boolean(this.#pages.at(-1)?.nextCursor),
      compactLayoutBytes,
      estimatedCompactBytes,
      estimatedFullDtoBytes: this.#fullBytes,
      error: firstError?.[1].error ?? null,
      errorRequest: firstError
        ? {
            cursor: firstError[0],
            kind: firstError[1].kind,
            top: errorPage?.top ?? null,
            bottom: errorPage?.bottom ?? null
          }
        : null
    };
  }

  #commit() {
    this.#revision += 1;
    this.#snapshot = this.#createSnapshot();
    for (const listener of this.#listeners) listener();
  }
}
