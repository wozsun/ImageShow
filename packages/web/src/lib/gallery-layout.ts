// Gallery masonry helpers: a responsive column count and shortest-column
// placement that balances columns using each image's aspect ratio as weight.
import { useEffect, useState } from "react";
import { galleryRenderBatch } from "./constants.js";
import type { Device, ImageItem } from "./types.js";

const galleryBreakpoints = { single: 520, double: 760, triple: 1080 } as const;
const galleryMaxColumns = 4;

export function masonryColumns(items: ImageItem[], columnCount: number) {
  const columns = Array.from({ length: Math.max(1, columnCount) }, () => [] as ImageItem[]);
  const heights = columns.map(() => 0);
  items.forEach((item) => {
    const targetIndex = heights.indexOf(Math.min(...heights));
    columns[targetIndex].push(item);
    heights[targetIndex] += galleryImageWeight(item);
  });
  return columns;
}

export function useGalleryColumnCount() {
  const [columnCount, setColumnCount] = useState(() => galleryColumnCount(window.innerWidth));
  useEffect(() => {
    const update = () => setColumnCount(galleryColumnCount(window.innerWidth));
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return columnCount;
}

export function nextRenderBatch(current: number, total: number) {
  return Math.min(total, current + galleryRenderBatch);
}

export function galleryImageRatio(device: Device, width = 0, height = 0) {
  if (width > 0 && height > 0) return `${width} / ${height}`;
  if (device === "mb") return "9 / 16";
  if (device === "pc") return "16 / 9";
  return "1 / 1";
}

function galleryColumnCount(width: number) {
  if (width <= galleryBreakpoints.single) return 1;
  if (width <= galleryBreakpoints.double) return 2;
  if (width <= galleryBreakpoints.triple) return 3;
  return galleryMaxColumns;
}

function galleryImageWeight(item: ImageItem) {
  if (item.width > 0 && item.height > 0) return item.height / item.width;
  if (item.device === "mb") return 16 / 9;
  if (item.device === "pc") return 9 / 16;
  return 1;
}
