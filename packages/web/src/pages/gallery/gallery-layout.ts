import { useEffect, useState } from "react";
import { galleryRenderBatch } from "../../lib/constants.js";
import type { Device, GalleryImageCard } from "../../lib/types.js";
import { galleryColumnCount } from "./gallery-columns.js";

export function masonryColumns(items: GalleryImageCard[], columnCount: number) {
  const columns = Array.from({ length: Math.max(1, columnCount) }, () => [] as GalleryImageCard[]);
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

function galleryImageWeight(item: GalleryImageCard) {
  if (item.width > 0 && item.height > 0) return item.height / item.width;
  if (item.device === "mb") return 16 / 9;
  if (item.device === "pc") return 9 / 16;
  return 1;
}
