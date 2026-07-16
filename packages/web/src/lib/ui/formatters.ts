import type { ImageItem } from "../types.js";

export function shortImageId(id: string) {
  return `#${id.replace(/-/g, "").slice(-12)}`;
}

export function imageDisplayTitle(item: { id: string; title?: string }) {
  return item.title?.trim() || shortImageId(item.id);
}

export function displayNameOrSlug(item: { slug: string; display_name?: string }) {
  return item.display_name?.trim() || item.slug;
}

export function facetDisplayName(
  options: readonly { slug: string; display_name?: string }[],
  slug: string,
  fallback = slug,
) {
  if (!slug) return fallback;
  const option = options.find((item) => item.slug === slug);
  return option ? displayNameOrSlug(option) : slug;
}

export function formatImageClassification(item: ImageItem) {
  return `${item.theme} · ${item.device}/${item.brightness}`;
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

export function cssUrl(value: string) {
  return `url("${escapeCssString(value)}")`;
}

function escapeCssString(value: string) {
  return value.replace(/["\\\u0000-\u001f\u007f]/g, (char) => {
    if (char === "\"") return "\\\"";
    if (char === "\\") return "\\\\";
    if (char === "\n") return "\\a ";
    if (char === "\r") return "\\d ";
    if (char === "\f") return "\\c ";
    const code = char.codePointAt(0)?.toString(16) ?? "fffd";
    return `\\${code} `;
  });
}
