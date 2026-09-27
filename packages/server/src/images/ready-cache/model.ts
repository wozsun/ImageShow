import type { ImageVariantRecord } from "../variants/record.ts";
import { unsetThemeFilter } from "@imageshow/shared/browser";
import {
  brightnesses,
  devices,
  slugMaxLength,
  slugPattern,
  type Brightness,
  type Device
} from "@imageshow/shared/browser";

export const READY_IMAGE_REBUILD_BATCH_SIZE = 1_000;
export const READY_IMAGE_REBUILD_MAX_ATTEMPTS = 2;
export const READY_IMAGE_REBUILD_QUIET_MS = 250;
export const READY_IMAGE_INCREMENTAL_LIMIT = 200;
const READY_IMAGE_CACHE_MAX_ITEM_BYTES = 256 * 1024;

export type ReadyImageCacheState = "ready" | "rebuilding" | "degraded";

export type ReadyImageCacheMeta = {
  state: ReadyImageCacheState;
  appliedRevision: string;
  itemCount: number;
  lastUpdatedAt: string;
  fullRebuildStartedAt: string;
  fullRebuildCompletedAt: string;
  processed: number;
  total: number;
  lastFullRebuildCoreMemoryBytes: number | null;
  lastFullRebuildMeasuredAt: string;
  lastError: string;
};

export type ReadyImageSourceRow = ImageVariantRecord & {
  id: string;
  device: string;
  brightness: string;
  theme: string | null;
  storage_slug: string;
  author: string;
  tags: string[];
  sort_score: number | string;
  title: string;
  description: string;
  source: string;
  original: string;
  cursor_created_at: string;
  cursor_updated_at: string;
};

export type ReadyImageCacheItem = ImageVariantRecord & {
  id: string;
  device: Device;
  brightness: Brightness;
  theme: string | null;
  storage_slug: string;
  author: string;
  tags: string[];
  width: number;
  height: number;
  sort_score: number;
  title: string;
  description: string;
  source: string;
  original: string;
  created_at: string;
  updated_at: string;
};

export type ReadyImageCacheResult<T> = { cached: true; value: T } | { cached: false };

function finiteNonNegative(value: unknown) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("Ready-image cache row contains an invalid numeric field");
  }
  return number;
}

function timestamp(value: unknown, field: string) {
  const text = value instanceof Date ? value.toISOString() : String(value ?? "");
  if (!Number.isFinite(Date.parse(text))) {
    throw new Error(`Ready-image cache row contains invalid ${field}`);
  }
  return text;
}

export function readyImageSortScore(value: unknown) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Invalid ready-image sort score");
    return value;
  }
  const raw = String(value ?? "");
  if (!/^-?\d+$/.test(raw)) {
    throw new Error("Ready-image cache row contains an invalid sort score");
  }
  const integer = BigInt(raw);
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (integer < -maximum || integer > maximum) {
    throw new Error("Ready-image image_time cannot be represented exactly in Redis");
  }
  return Number(integer);
}

export function readyImageCacheItemFromRow(row: ReadyImageSourceRow): ReadyImageCacheItem {
  const tags = Array.isArray(row.tags)
    ? [...new Set(row.tags.map(String))].sort()
    : [];
  if (
    tags.length > 50 ||
    tags.some((tag) => tag.length > slugMaxLength || !slugPattern.test(tag))
  ) {
    throw new Error("Ready-image cache row contains invalid tags");
  }
  const item: ReadyImageCacheItem = {
    id: String(row.id ?? "").toLowerCase(),
    device: row.device as Device,
    brightness: row.brightness as Brightness,
    theme: row.theme === null ? null : String(row.theme),
    storage_slug: String(row.storage_slug ?? ""),
    author: String(row.author ?? ""),
    tags,
    width: finiteNonNegative(row.s_width),
    height: finiteNonNegative(row.s_height),
    l_width: finiteNonNegative(row.l_width),
    l_height: finiteNonNegative(row.l_height),
    l_byte_size: finiteNonNegative(row.l_byte_size),
    m_width: finiteNonNegative(row.m_width),
    m_height: finiteNonNegative(row.m_height),
    m_byte_size: finiteNonNegative(row.m_byte_size),
    s_width: finiteNonNegative(row.s_width),
    s_height: finiteNonNegative(row.s_height),
    s_byte_size: finiteNonNegative(row.s_byte_size),
    l_md5: String(row.l_md5),
    m_md5: String(row.m_md5),
    s_md5: String(row.s_md5),
    sort_score: readyImageSortScore(row.sort_score),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    source: String(row.source ?? ""),
    original: String(row.original ?? ""),
    created_at: timestamp(row.cursor_created_at, "created_at"),
    updated_at: timestamp(row.cursor_updated_at, "updated_at")
  };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id) ||
    !devices.includes(item.device) ||
    !brightnesses.includes(item.brightness) ||
    (item.theme !== null && (item.theme.length > slugMaxLength
      || !slugPattern.test(item.theme))) ||
    item.storage_slug.length > slugMaxLength ||
    !slugPattern.test(item.storage_slug) ||
    (item.author && (
      item.author.length > slugMaxLength || !slugPattern.test(item.author)
    ))
  ) {
    throw new Error("Ready-image cache row is outside the supported model");
  }
  for (const field of ["l_width","l_height","l_byte_size","m_width","m_height","m_byte_size","s_width","s_height","s_byte_size"] as const) if (Number(item[field]) <= 0) throw new Error("Invalid variant dimension or byte size");
  for (const field of ["l_md5","m_md5","s_md5"] as const) if (!/^[a-f0-9]{32}$/.test(item[field])) throw new Error("Invalid variant MD5");
  return item;
}

const cacheFields = ["id","device","brightness","theme","storage_slug","author","tags","sort_score","title","description","source","original","created_at","updated_at","l_width","l_height","l_byte_size","m_width","m_height","m_byte_size","s_width","s_height","s_byte_size","l_md5","m_md5","s_md5"] as const;

export function parseReadyImageCacheItem(raw: string | null): ReadyImageCacheItem | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (Buffer.byteLength(raw, "utf8") > READY_IMAGE_CACHE_MAX_ITEM_BYTES || !Array.isArray(value) || value.length !== cacheFields.length) return null;
    for (const [index, field] of cacheFields.entries()) {
      const entry: unknown = value[index];
      if (field === "tags") {
        if (!Array.isArray(entry) || entry.some((tag) => typeof tag !== "string")) return null;
      } else if (field === "theme") {
        if (entry !== null && typeof entry !== "string") return null;
      } else if (field === "sort_score" || /_(width|height|byte_size)$/.test(field)) {
        if (typeof entry !== "number" || !Number.isSafeInteger(entry) || (field !== "sort_score" && entry <= 0)) return null;
      } else if (typeof entry !== "string") return null;
    }
    const fields = Object.fromEntries(cacheFields.map((field, index) => [field, value[index]]));
    return readyImageCacheItemFromRow({ ...fields, cursor_created_at: fields.created_at, cursor_updated_at: fields.updated_at } as ReadyImageSourceRow);
  } catch { return null; }
}

/** The Redis namespace and positional contract describe only the current three variants. */
export function serializeReadyImageCacheItem(item: ReadyImageCacheItem) {
  const serialized = JSON.stringify(cacheFields.map((field) => item[field]));
  if (Buffer.byteLength(serialized, "utf8") > READY_IMAGE_CACHE_MAX_ITEM_BYTES) throw new Error("Ready-image cache item exceeds its byte budget");
  return serialized;
}

export function readyImageMember(id: string) {
  const member = id.toLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(member)) {
    throw new Error("Cannot encode an invalid ready-image UUID");
  }
  return member;
}

function readyImageIdSuffix(item: Pick<ReadyImageCacheItem, "id">) {
  return item.id.slice(-12);
}

export function readyImageIdSuffixScore(item: Pick<ReadyImageCacheItem, "id">) {
  return Number.parseInt(readyImageIdSuffix(item), 16);
}

export function readyImageStatFields(item: ReadyImageCacheItem) {
  return [
    "total",
    `device:${item.device}`,
    `brightness:${item.brightness}`,
    `axis:${item.device}:${item.brightness}`,
    `theme:${item.theme ?? unsetThemeFilter}`,
    ...item.tags.map((tag) => `tag:${tag}`),
    ...(item.author ? [`author:${item.author}`] : [])
  ];
}
