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

export type ReadyImageSourceRow = {
  id: string;
  ext: string;
  device: string;
  brightness: string;
  theme: string | null;
  storage_slug: string;
  author: string;
  tags: string[];
  width: number | string;
  height: number | string;
  image_size: number | string;
  sort_score: number | string;
  title: string;
  description: string;
  source: string;
  original: string;
  md5: string;
  cursor_created_at: string;
  cursor_updated_at: string;
};

export type ReadyImageCacheItem = {
  id: string;
  ext: string;
  device: Device;
  brightness: Brightness;
  theme: string | null;
  storage_slug: string;
  author: string;
  tags: string[];
  width: number;
  height: number;
  image_size: number;
  sort_score: number;
  title: string;
  description: string;
  source: string;
  original: string;
  md5: string;
  created_at: string;
  updated_at: string;
};

export type ReadyImageCacheResult<T> = { cached: true; value: T } | { cached: false };

const imageExtensions = new Set(["jpg", "png", "webp", "gif", "avif"]);
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
    ext: String(row.ext ?? ""),
    device: row.device as Device,
    brightness: row.brightness as Brightness,
    theme: row.theme === null ? null : String(row.theme),
    storage_slug: String(row.storage_slug ?? ""),
    author: String(row.author ?? ""),
    tags,
    width: finiteNonNegative(row.width),
    height: finiteNonNegative(row.height),
    image_size: finiteNonNegative(row.image_size),
    sort_score: readyImageSortScore(row.sort_score),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    source: String(row.source ?? ""),
    original: String(row.original ?? ""),
    md5: String(row.md5 ?? ""),
    created_at: timestamp(row.cursor_created_at, "created_at"),
    updated_at: timestamp(row.cursor_updated_at, "updated_at")
  };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id) ||
    !imageExtensions.has(item.ext) ||
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
  return item;
}

export function parseReadyImageCacheItem(raw: string | null): ReadyImageCacheItem | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(value) ||
      value.length !== 19 ||
      value
        .slice(0, 7)
        .some((field, index) =>
          index === 4 ? field !== null && typeof field !== "string" : typeof field !== "string"
        ) ||
      !Array.isArray(value[7]) ||
      value[7].some((tag) => typeof tag !== "string") ||
      value.slice(8, 12).some((field) => typeof field !== "number") ||
      value.slice(12).some((field) => typeof field !== "string")
    )
      return null;
    const row = {
      id: value[0],
      ext: value[1],
      device: value[2],
      brightness: value[3],
      theme: value[4],
      storage_slug: value[5],
      author: value[6],
      tags: value[7],
      width: value[8],
      height: value[9],
      image_size: value[10],
      sort_score: value[11],
      title: value[12],
      description: value[13],
      source: value[14],
      original: value[15],
      md5: value[16],
      cursor_created_at: value[17],
      cursor_updated_at: value[18]
    } satisfies ReadyImageSourceRow;
    return readyImageCacheItemFromRow(row);
  } catch {
    return null;
  }
}

/** Fixed-position JSON avoids repeating field names for every cached image. */
export function serializeReadyImageCacheItem(item: ReadyImageCacheItem) {
  const serialized = JSON.stringify([
    item.id,
    item.ext,
    item.device,
    item.brightness,
    item.theme,
    item.storage_slug,
    item.author,
    item.tags,
    item.width,
    item.height,
    item.image_size,
    item.sort_score,
    item.title,
    item.description,
    item.source,
    item.original,
    item.md5,
    item.created_at,
    item.updated_at
  ]);
  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes > READY_IMAGE_CACHE_MAX_ITEM_BYTES) {
    throw new Error(
      `Ready-image cache item ${item.id} exceeds ${READY_IMAGE_CACHE_MAX_ITEM_BYTES} bytes`
    );
  }
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
