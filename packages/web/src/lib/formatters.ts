import type { ImageItem } from "./types.js";

export function formatImageMeta(item: ImageItem) {
  return `${item.theme} · ${item.device}/${item.brightness} · ${formatIndex(item)}`;
}

export function formatIndex(item: ImageItem) {
  return String(item.category_index).padStart(6, "0");
}

export function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

export function formatDimensions(width: number, height: number) {
  return width > 0 && height > 0 ? `${width} x ${height}` : "未记录";
}
