import { galleryMaxMountedTiles } from "../../lib/constants.js";
import type { Device } from "../../lib/types.js";

export type GalleryCompactGeometry = {
  columnCount: number;
  contentWidth: number;
  gap: number;
};

export type CompactMasonryPosition = {
  index: number;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  bottom: number;
};

type CompactPageBounds = {
  top: number;
  bottom: number;
};

class CompactIndexColumn {
  #values = new Uint32Array(0);
  length = 0;

  get byteLength() {
    return this.#values.byteLength;
  }

  at(index: number) {
    return this.#values[index]!;
  }

  clear() {
    this.length = 0;
  }

  push(value: number) {
    if (this.length >= this.#values.length) {
      const capacity = Math.max(16, this.#values.length * 2);
      const next = new Uint32Array(capacity);
      next.set(this.#values.subarray(0, this.length));
      this.#values = next;
    }
    this.#values[this.length] = value;
    this.length += 1;
  }
}

function normalizedGeometry(
  geometry: GalleryCompactGeometry
): GalleryCompactGeometry {
  return {
    columnCount: Math.max(1, Math.floor(geometry.columnCount)),
    contentWidth: Math.max(0, geometry.contentWidth),
    gap: Math.max(0, geometry.gap)
  };
}

function geometryMatches(
  left: GalleryCompactGeometry,
  right: GalleryCompactGeometry
) {
  return left.columnCount === right.columnCount
    && left.contentWidth === right.contentWidth
    && left.gap === right.gap;
}

function columnWidth(geometry: GalleryCompactGeometry) {
  return Math.max(
    0,
    (
      geometry.contentWidth
      - geometry.gap * (geometry.columnCount - 1)
    ) / geometry.columnCount
  );
}

function shortestColumn(heights: Float64Array) {
  let column = 0;
  for (let candidate = 1; candidate < heights.length; candidate += 1) {
    if (heights[candidate]! < heights[column]!) column = candidate;
  }
  return column;
}

export function galleryImageNumericRatio(
  device: Device,
  width = 0,
  height = 0
) {
  if (width > 0 && height > 0) return height / width;
  if (device === "mb") return 16 / 9;
  if (device === "pc") return 9 / 16;
  return 1;
}

/**
 * Compact, append-oriented masonry index. Per-image layout state is kept in
 * typed arrays; position objects are materialized only for the virtual window.
 */
export class CompactMasonryLayout {
  #geometry: GalleryCompactGeometry;
  #columnWidth = 0;
  #count = 0;
  #capacity = 0;
  #ratios = new Float32Array(0);
  #columns = new Uint16Array(0);
  #ys = new Float64Array(0);
  #heights = new Float32Array(0);
  #columnHeights = new Float64Array(0);
  #columnIndexes: CompactIndexColumn[] = [];

  constructor(geometry: GalleryCompactGeometry) {
    this.#geometry = normalizedGeometry(geometry);
    this.#resetColumns();
  }

  get geometry() {
    return this.#geometry;
  }

  get totalHeight() {
    let total = 0;
    for (const height of this.#columnHeights) {
      total = Math.max(total, Math.max(0, height - this.#geometry.gap));
    }
    return total;
  }

  get itemByteLength() {
    return this.#ratios.byteLength
      + this.#columns.byteLength
      + this.#ys.byteLength
      + this.#heights.byteLength
      + this.#columnIndexes.reduce(
        (total, column) => total + column.byteLength,
        0
      );
  }

  append(ratio: number) {
    this.#ensureCapacity(this.#count + 1);
    const normalizedRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
    const index = this.#count;
    const column = shortestColumn(this.#columnHeights);
    const y = this.#columnHeights[column]!;
    const height = this.#itemHeight(normalizedRatio);
    this.#ratios[index] = normalizedRatio;
    this.#columns[index] = column;
    this.#ys[index] = y;
    this.#heights[index] = height;
    this.#columnHeights[column] = y + height + this.#geometry.gap;
    this.#columnIndexes[column]!.push(index);
    this.#count += 1;
    return index;
  }

  setRatios(startIndex: number, ratios: readonly number[]) {
    let changed = false;
    for (const [offset, ratio] of ratios.entries()) {
      const index = startIndex + offset;
      if (index < 0 || index >= this.#count) continue;
      const normalizedRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
      if (Math.abs(this.#ratios[index]! - normalizedRatio) < 0.00001) {
        continue;
      }
      this.#ratios[index] = normalizedRatio;
      changed = true;
    }
    if (changed) this.#rebuildPositions();
    return changed;
  }

  remove(index: number) {
    if (index < 0 || index >= this.#count) return false;
    const removedColumn = this.#columns[index]!;
    const removedSpace = this.#heights[index]! + this.#geometry.gap;
    for (let nextIndex = index; nextIndex < this.#count - 1; nextIndex += 1) {
      const oldIndex = nextIndex + 1;
      const column = this.#columns[oldIndex]!;
      this.#ratios[nextIndex] = this.#ratios[oldIndex]!;
      this.#columns[nextIndex] = column;
      this.#ys[nextIndex] = this.#ys[oldIndex]!
        - (column === removedColumn ? removedSpace : 0);
      this.#heights[nextIndex] = this.#heights[oldIndex]!;
    }
    this.#count -= 1;
    this.#reindexExistingPositions();
    return true;
  }

  truncate(count: number) {
    const nextCount = Math.max(0, Math.min(this.#count, Math.floor(count)));
    if (nextCount === this.#count) return false;
    this.#count = nextCount;
    this.#reindexExistingPositions();
    return true;
  }

  setGeometry(geometry: GalleryCompactGeometry) {
    const normalized = normalizedGeometry(geometry);
    if (geometryMatches(this.#geometry, normalized)) return false;
    this.#geometry = normalized;
    this.#resetColumns();
    this.#rebuildPositions();
    return true;
  }

  position(index: number): CompactMasonryPosition | null {
    if (index < 0 || index >= this.#count) return null;
    const column = this.#columns[index]!;
    const y = this.#ys[index]!;
    const height = this.#heights[index]!;
    return {
      index,
      column,
      x: column * (this.#columnWidth + this.#geometry.gap),
      y,
      width: this.#columnWidth,
      height,
      bottom: y + height
    };
  }

  pageBounds(startIndex: number, itemCount: number): CompactPageBounds {
    const start = Math.max(0, Math.min(this.#count, Math.floor(startIndex)));
    const end = Math.max(
      start,
      Math.min(this.#count, start + Math.max(0, Math.floor(itemCount)))
    );
    let top = Number.POSITIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    for (let index = start; index < end; index += 1) {
      const y = this.#ys[index]!;
      top = Math.min(top, y);
      bottom = Math.max(bottom, y + this.#heights[index]!);
    }
    const fallback = start > 0
      ? this.#ys[start - 1]! + this.#heights[start - 1]!
      : 0;
    return Number.isFinite(top) && Number.isFinite(bottom)
      ? { top, bottom }
      : { top: fallback, bottom: fallback };
  }

  windowIndexes({
    start,
    end,
    maxItems = galleryMaxMountedTiles,
    priorityStart = start,
    priorityEnd = end,
    pinnedIndex = -1
  }: {
    start: number;
    end: number;
    maxItems?: number;
    priorityStart?: number;
    priorityEnd?: number;
    pinnedIndex?: number;
  }) {
    const boundedStart = Math.max(0, start);
    const boundedEnd = Math.max(boundedStart, end);
    const itemLimit = Math.max(1, Math.floor(maxItems));
    const center = (
      Math.max(boundedStart, priorityStart)
      + Math.min(boundedEnd, priorityEnd)
    ) / 2;
    const distanceFromPriority = (index: number) => (
      Math.abs(this.#ys[index]! + this.#heights[index]! / 2 - center)
    );
    const byDistanceThenIndex = (left: number, right: number) => (
      distanceFromPriority(left) - distanceFromPriority(right)
      || left - right
    );
    const intersecting: number[] = [];
    for (const column of this.#columnIndexes) {
      let index = this.#firstColumnIntersection(column, boundedStart);
      while (index < column.length) {
        const itemIndex = column.at(index);
        if (this.#ys[itemIndex]! > boundedEnd) break;
        intersecting.push(itemIndex);
        index += 1;
      }
    }
    intersecting.sort((left, right) => left - right);
    let mounted = intersecting.length <= itemLimit
      ? intersecting
      : intersecting
          .slice()
          .sort(byDistanceThenIndex)
          .slice(0, itemLimit)
          .sort((left, right) => left - right);
    if (
      pinnedIndex < 0
      || pinnedIndex >= this.#count
      || mounted.includes(pinnedIndex)
    ) {
      return mounted;
    }
    if (mounted.length >= itemLimit) {
      mounted = mounted
        .slice()
        .sort(byDistanceThenIndex)
        .slice(0, itemLimit - 1);
    }
    return [...mounted, pinnedIndex].sort((left, right) => left - right);
  }

  #itemHeight(ratio: number) {
    const tileBorder = 1;
    return Math.max(
      tileBorder * 2,
      Math.max(0, this.#columnWidth - tileBorder * 2) * ratio
        + tileBorder * 2
    );
  }

  #ensureCapacity(required: number) {
    if (required <= this.#capacity) return;
    const capacity = Math.max(64, 2 ** Math.ceil(Math.log2(required)));
    const ratios = new Float32Array(capacity);
    const columns = new Uint16Array(capacity);
    const ys = new Float64Array(capacity);
    const heights = new Float32Array(capacity);
    ratios.set(this.#ratios.subarray(0, this.#count));
    columns.set(this.#columns.subarray(0, this.#count));
    ys.set(this.#ys.subarray(0, this.#count));
    heights.set(this.#heights.subarray(0, this.#count));
    this.#ratios = ratios;
    this.#columns = columns;
    this.#ys = ys;
    this.#heights = heights;
    this.#capacity = capacity;
  }

  #resetColumns() {
    this.#columnWidth = columnWidth(this.#geometry);
    this.#columnHeights = new Float64Array(this.#geometry.columnCount);
    this.#columnIndexes = Array.from(
      { length: this.#geometry.columnCount },
      () => new CompactIndexColumn()
    );
  }

  #rebuildPositions() {
    this.#resetColumns();
    for (let index = 0; index < this.#count; index += 1) {
      const column = shortestColumn(this.#columnHeights);
      const y = this.#columnHeights[column]!;
      const height = this.#itemHeight(this.#ratios[index]!);
      this.#columns[index] = column;
      this.#ys[index] = y;
      this.#heights[index] = height;
      this.#columnHeights[column] = y + height + this.#geometry.gap;
      this.#columnIndexes[column]!.push(index);
    }
  }

  #reindexExistingPositions() {
    this.#columnHeights.fill(0);
    for (const column of this.#columnIndexes) column.clear();
    for (let index = 0; index < this.#count; index += 1) {
      const column = this.#columns[index]!;
      this.#columnIndexes[column]!.push(index);
      this.#columnHeights[column] = Math.max(
        this.#columnHeights[column]!,
        this.#ys[index]! + this.#heights[index]! + this.#geometry.gap
      );
    }
  }

  #firstColumnIntersection(column: CompactIndexColumn, start: number) {
    let lower = 0;
    let upper = column.length;
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      const itemIndex = column.at(middle);
      if (this.#ys[itemIndex]! + this.#heights[itemIndex]! < start) {
        lower = middle + 1;
      } else {
        upper = middle;
      }
    }
    return lower;
  }
}
