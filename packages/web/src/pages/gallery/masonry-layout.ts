import {
  galleryMaxMountedTiles
} from "../../lib/constants.js";
import type { Device, GalleryImageCard } from "../../lib/types.js";

export type MasonryItemPosition = {
  item: GalleryImageCard;
  index: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  bottom: number;
};

export type MasonryLayout = {
  positions: MasonryItemPosition[];
  columns: MasonryItemPosition[][];
  positionById: Map<string, MasonryItemPosition>;
  totalHeight: number;
  columnWidth: number;
};

export type GalleryGeometry = {
  contentWidth: number;
  gap: number;
};

type NormalizedGalleryGeometry = GalleryGeometry & {
  columnCount: number;
};

export type MasonryLayoutSession = MasonryLayout & {
  sessionKey: string;
  geometry: NormalizedGalleryGeometry;
};

function numericGalleryImageRatio(
  device: Device,
  width = 0,
  height = 0
) {
  if (width > 0 && height > 0) return height / width;
  if (device === "mb") return 16 / 9;
  if (device === "pc") return 9 / 16;
  return 1;
}

function normalizedGeometry(
  geometry: GalleryGeometry & { columnCount: number }
): NormalizedGalleryGeometry {
  return {
    columnCount: Math.max(1, Math.floor(geometry.columnCount)),
    contentWidth: Math.max(0, geometry.contentWidth),
    gap: Math.max(0, geometry.gap)
  };
}

function galleryColumnWidth(geometry: NormalizedGalleryGeometry) {
  return Math.max(
    0,
    (
      geometry.contentWidth
      - geometry.gap * (geometry.columnCount - 1)
    ) / geometry.columnCount
  );
}

function galleryItemHeight(
  item: GalleryImageCard,
  columnWidth: number
) {
  const tileBorder = 1;
  return Math.max(
    tileBorder * 2,
    Math.max(0, columnWidth - tileBorder * 2)
    * numericGalleryImageRatio(
      item.device,
      item.width,
      item.height
    )
    + tileBorder * 2
  );
}

function shortestColumn(columnHeights: readonly number[]) {
  let column = 0;
  for (let candidate = 1; candidate < columnHeights.length; candidate += 1) {
    if (columnHeights[candidate]! < columnHeights[column]!) {
      column = candidate;
    }
  }
  return column;
}

function masonryTotalHeight(
  columnHeights: readonly number[],
  gap: number
) {
  return Math.max(
    0,
    ...columnHeights.map((height) => Math.max(0, height - gap))
  );
}

function indexedMasonryLayout(
  positions: MasonryItemPosition[],
  columnCount: number,
  totalHeight: number,
  columnWidth: number
): MasonryLayout {
  const columns = Array.from(
    { length: columnCount },
    () => [] as MasonryItemPosition[]
  );
  const positionById = new Map<string, MasonryItemPosition>();
  for (const position of positions) {
    columns[position.column]!.push(position);
    // Image IDs are unique in gallery data. Keeping the first occurrence also
    // preserves the previous linear `find` behavior for malformed fixtures.
    if (!positionById.has(position.item.id)) {
      positionById.set(position.item.id, position);
    }
  }
  return {
    positions,
    columns,
    positionById,
    totalHeight,
    columnWidth
  };
}

function computeMasonryLayout(
  items: GalleryImageCard[],
  geometry: GalleryGeometry & { columnCount: number }
): MasonryLayout {
  const normalized = normalizedGeometry(geometry);
  const columnWidth = galleryColumnWidth(normalized);
  const columnHeights = Array.from(
    { length: normalized.columnCount },
    () => 0
  );
  const positions = items.map((item, index) => {
    const column = shortestColumn(columnHeights);
    const x = column * (columnWidth + normalized.gap);
    const y = columnHeights[column]!;
    const height = galleryItemHeight(item, columnWidth);
    const bottom = y + height;
    columnHeights[column] = bottom + normalized.gap;
    return {
      item,
      index,
      column,
      x,
      y,
      width: columnWidth,
      height,
      bottom
    };
  });
  return indexedMasonryLayout(
    positions,
    normalized.columnCount,
    masonryTotalHeight(columnHeights, normalized.gap),
    columnWidth
  );
}

function geometryMatches(
  left: NormalizedGalleryGeometry,
  right: NormalizedGalleryGeometry
) {
  return (
    left.columnCount === right.columnCount
    && left.contentWidth === right.contentWidth
    && left.gap === right.gap
  );
}

function layoutMetadataMatches(
  previous: GalleryImageCard,
  current: GalleryImageCard
) {
  return (
    previous.device === current.device
    && previous.width === current.width
    && previous.height === current.height
  );
}

function completeLayoutSession(
  items: GalleryImageCard[],
  geometry: NormalizedGalleryGeometry,
  sessionKey: string
): MasonryLayoutSession {
  return {
    ...computeMasonryLayout(items, geometry),
    sessionKey,
    geometry
  };
}

/**
 * Existing positions are the committed session truth. Removing items compacts
 * only their original columns; newly appended cursor pages continue from the
 * resulting column ends. Any order, geometry, or size change falls back to a
 * complete deterministic layout.
 */
export function reconcileMasonryLayout(
  previous: MasonryLayoutSession | null,
  items: GalleryImageCard[],
  geometry: GalleryGeometry & { columnCount: number },
  sessionKey: string
): MasonryLayoutSession {
  const normalized = normalizedGeometry(geometry);
  if (
    !previous
    || previous.sessionKey !== sessionKey
    || !geometryMatches(previous.geometry, normalized)
  ) {
    return completeLayoutSession(items, normalized, sessionKey);
  }

  const previousById = previous.positionById;
  const nextIndexById = new Map<string, number>();
  let previousIndex = -1;
  let additionsStarted = false;
  for (const [index, item] of items.entries()) {
    if (nextIndexById.has(item.id)) {
      return completeLayoutSession(items, normalized, sessionKey);
    }
    nextIndexById.set(item.id, index);
    const oldPosition = previousById.get(item.id);
    if (!oldPosition) {
      additionsStarted = true;
      continue;
    }
    if (
      additionsStarted
      || oldPosition.index <= previousIndex
      || !layoutMetadataMatches(oldPosition.item, item)
    ) {
      return completeLayoutSession(items, normalized, sessionKey);
    }
    previousIndex = oldPosition.index;
  }

  const shifts = Array.from(
    { length: normalized.columnCount },
    () => 0
  );
  const retained: MasonryItemPosition[] = [];
  for (const oldPosition of previous.positions) {
    const nextIndex = nextIndexById.get(oldPosition.item.id);
    if (nextIndex === undefined) {
      shifts[oldPosition.column] = (
        shifts[oldPosition.column]!
        + oldPosition.height
        + normalized.gap
      );
      continue;
    }
    const y = oldPosition.y - shifts[oldPosition.column]!;
    const item = items[nextIndex]!;
    const positionUnchanged = (
      oldPosition.item === item
      && oldPosition.index === nextIndex
      && oldPosition.y === y
    );
    retained.push(positionUnchanged ? oldPosition : {
      ...oldPosition,
      item,
      index: nextIndex,
      y,
      bottom: y + oldPosition.height
    });
  }

  const columnHeights = Array.from(
    { length: normalized.columnCount },
    () => 0
  );
  for (const position of retained) {
    columnHeights[position.column] = Math.max(
      columnHeights[position.column]!,
      position.bottom + normalized.gap
    );
  }

  const positions = [...retained];
  for (let index = retained.length; index < items.length; index += 1) {
    const item = items[index]!;
    if (previousById.has(item.id)) {
      return completeLayoutSession(items, normalized, sessionKey);
    }
    const column = shortestColumn(columnHeights);
    const x = column * (previous.columnWidth + normalized.gap);
    const y = columnHeights[column]!;
    const height = galleryItemHeight(item, previous.columnWidth);
    const bottom = y + height;
    columnHeights[column] = bottom + normalized.gap;
    positions.push({
      item,
      index,
      column,
      x,
      y,
      width: previous.columnWidth,
      height,
      bottom
    });
  }

  return {
    ...indexedMasonryLayout(
      positions,
      normalized.columnCount,
      masonryTotalHeight(columnHeights, normalized.gap),
      previous.columnWidth
    ),
    sessionKey,
    geometry: normalized
  };
}

function firstColumnIntersection(
  positions: readonly MasonryItemPosition[],
  start: number
) {
  let lower = 0;
  let upper = positions.length;
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2);
    if (positions[middle]!.bottom < start) {
      lower = middle + 1;
    } else {
      upper = middle;
    }
  }
  return lower;
}

export function masonryWindow(
  layout: MasonryLayout,
  start: number,
  end: number,
  maxItems = galleryMaxMountedTiles,
  priorityStart = start,
  priorityEnd = end,
  pinnedItemId: string | null = null
) {
  const boundedStart = Math.max(0, start);
  const boundedEnd = Math.max(boundedStart, end);
  const itemLimit = Math.max(1, Math.floor(maxItems));
  const center = (
    Math.max(boundedStart, priorityStart)
    + Math.min(boundedEnd, priorityEnd)
  ) / 2;
  const distanceFromPriority = (position: MasonryItemPosition) => (
    Math.abs(position.y + position.height / 2 - center)
  );
  const byDistanceThenIndex = (
    left: MasonryItemPosition,
    right: MasonryItemPosition
  ) => (
    distanceFromPriority(left) - distanceFromPriority(right)
    || left.index - right.index
  );
  const intersecting: MasonryItemPosition[] = [];
  for (const column of layout.columns) {
    let index = firstColumnIntersection(column, boundedStart);
    while (index < column.length) {
      const position = column[index]!;
      if (position.y > boundedEnd) break;
      intersecting.push(position);
      index += 1;
    }
  }
  intersecting.sort((left, right) => left.index - right.index);
  let mounted = intersecting.length <= itemLimit
    ? intersecting
    : intersecting
        .slice()
        .sort(byDistanceThenIndex)
        .slice(0, itemLimit)
        .sort((left, right) => left.index - right.index);

  const pinned = pinnedItemId
    ? layout.positionById.get(pinnedItemId)
    : undefined;
  if (!pinned || mounted.some((position) => position === pinned)) {
    return mounted;
  }

  if (mounted.length >= itemLimit) {
    mounted = mounted
      .slice()
      .sort(byDistanceThenIndex)
      .slice(0, itemLimit - 1);
  }
  return [...mounted, pinned].sort((left, right) => left.index - right.index);
}
