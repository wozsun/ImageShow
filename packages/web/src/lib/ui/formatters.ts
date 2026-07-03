import { appConfig } from "@imageshow/shared";
import type { ImageItem } from "../types.js";

export function formatImageMeta(item: ImageItem) {
  return `${item.theme} · ${item.device}/${item.brightness} · ${formatIndex(item)}`;
}

export function formatIndex(item: ImageItem) {
  return String(item.category_index).padStart(appConfig.categoryIndexDigits, "0");
}

export function formatDate(value: string) {
  return new Date(value).toLocaleString();
}

export function formatDimensions(width: number, height: number) {
  return width > 0 && height > 0 ? `${width} x ${height}` : "未记录";
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function formatBytes(bytes: number) {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}
