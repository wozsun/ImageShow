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
  totalHeight: number;
  columnWidth: number;
};

export type GalleryGeometry = {
  contentWidth: number;
  gap: number;
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

export function computeMasonryLayout(
  items: GalleryImageCard[],
  geometry: GalleryGeometry & { columnCount: number }
): MasonryLayout {
  const columnCount = Math.max(1, Math.floor(geometry.columnCount));
  const gap = Math.max(0, geometry.gap);
  const contentWidth = Math.max(0, geometry.contentWidth);
  const columnWidth = Math.max(
    0,
    (contentWidth - gap * (columnCount - 1)) / columnCount
  );
  const columnHeights = Array.from({ length: columnCount }, () => 0);
  const positions = items.map((item, index) => {
    let column = 0;
    for (let candidate = 1; candidate < columnCount; candidate += 1) {
      if (columnHeights[candidate]! < columnHeights[column]!) {
        column = candidate;
      }
    }
    const x = column * (columnWidth + gap);
    const y = columnHeights[column]!;
    const tileBorder = 1;
    const height = Math.max(
      tileBorder * 2,
      Math.max(0, columnWidth - tileBorder * 2)
      * numericGalleryImageRatio(
        item.device,
        item.width,
        item.height
      )
      + tileBorder * 2
    );
    const bottom = y + height;
    columnHeights[column] = bottom + gap;
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
  return {
    positions,
    totalHeight: Math.max(
      0,
      ...columnHeights.map((height) => Math.max(0, height - gap))
    ),
    columnWidth
  };
}

export function masonryWindow(
  positions: MasonryItemPosition[],
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
  const intersecting = positions.filter(
    (position) => (
      position.bottom >= boundedStart
      && position.y <= boundedEnd
    )
  );
  let mounted = intersecting.length <= itemLimit
    ? intersecting
    : intersecting
        .slice()
        .sort((left, right) => (
          distanceFromPriority(left) - distanceFromPriority(right)
        ))
        .slice(0, itemLimit)
        .sort((left, right) => left.index - right.index);

  const pinned = pinnedItemId
    ? positions.find((position) => position.item.id === pinnedItemId)
    : undefined;
  if (!pinned || mounted.some((position) => position === pinned)) {
    return mounted;
  }

  if (mounted.length >= itemLimit) {
    mounted = mounted
      .slice()
      .sort((left, right) => (
        distanceFromPriority(left) - distanceFromPriority(right)
      ))
      .slice(0, itemLimit - 1);
  }
  return [...mounted, pinned].sort((left, right) => left.index - right.index);
}
