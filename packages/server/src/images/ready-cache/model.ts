import {
  brightnesses,
  devices,
  slugMaxLength,
  slugPattern,
  type Brightness,
  type Device
} from "@imageshow/shared/browser";
import { thumbnailObjectKey } from "../../storage/image-paths.ts";

export const READY_IMAGE_CACHE_SCHEMA = 4;
export const READY_IMAGE_REBUILD_BATCH_SIZE = 1_000;
export const READY_IMAGE_REBUILD_MAX_ATTEMPTS = 2;
export const READY_IMAGE_REBUILD_QUIET_MS = 250;
export const READY_IMAGE_INCREMENTAL_LIMIT = 200;
const READY_IMAGE_CACHE_MAX_ITEM_BYTES = 256 * 1024;

export type ReadyImageCacheState =
  | "ready"
  | "rebuilding"
  | "degraded";

export type ReadyImageCacheMeta = {
  schema: number;
  state: ReadyImageCacheState;
  appliedRevision: string;
  itemCount: number;
  builtAt: string;
  startedAt: string;
  processed: number;
  total: number;
  memoryBytes: number | null;
  lastError: string;
};

export type ReadyImageCacheItem = {
  id: string;
  object_key: string;
  ext: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  storage_slug: string;
  author: string;
  tags: string[];
  width: number;
  height: number;
  image_size: number;
  image_time: string;
  sort_score: number;
  title: string;
  description: string;
  source: string;
  original: string;
  md5: string;
  created_at: string;
  updated_at: string;
};

export type ReadyImageCacheResult<T> =
  | { cached: true; value: T }
  | { cached: false };

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

export function readyImageCacheItemFromRow(
  row: Record<string, unknown>
): ReadyImageCacheItem {
  const tags = Array.isArray(row.tags)
    ? [...new Set(row.tags.map(String))].sort()
    : [];
  if (
    tags.length > 50
    || tags.some((tag) => (
      tag.length > slugMaxLength || !slugPattern.test(tag)
    ))
  ) {
    throw new Error("Ready-image cache row contains invalid tags");
  }
  const item: ReadyImageCacheItem = {
    id: String(row.id ?? "").toLowerCase(),
    object_key: String(row.object_key ?? ""),
    ext: String(row.ext ?? ""),
    device: row.device as Device,
    brightness: row.brightness as Brightness,
    theme: String(row.theme ?? "none"),
    storage_slug: String(row.storage_slug ?? ""),
    author: String(row.author ?? ""),
    tags,
    width: finiteNonNegative(row.width),
    height: finiteNonNegative(row.height),
    image_size: finiteNonNegative(row.image_size),
    image_time: timestamp(row.cursor_image_time ?? row.image_time, "image_time"),
    sort_score: readyImageSortScore(row.sort_score),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    source: String(row.source ?? ""),
    original: String(row.original ?? ""),
    md5: String(row.md5 ?? ""),
    created_at: timestamp(row.cursor_created_at ?? row.created_at, "created_at"),
    updated_at: timestamp(row.cursor_updated_at ?? row.updated_at, "updated_at")
  };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(item.id)
    || !item.object_key
    || !imageExtensions.has(item.ext)
    || !devices.includes(item.device)
    || !brightnesses.includes(item.brightness)
    || item.theme.length > slugMaxLength
    || !slugPattern.test(item.theme)
    || item.storage_slug.length > slugMaxLength
    || !slugPattern.test(item.storage_slug)
    || (item.author && (
      item.author.length > slugMaxLength || !slugPattern.test(item.author)
    ))
  ) {
    throw new Error("Ready-image cache row is outside the supported model");
  }
  return item;
}

export function parseReadyImageCacheItem(
  raw: string | null
): ReadyImageCacheItem | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !Array.isArray(value)
      || value.length !== 21
      || value.slice(0, 8).some((field) => typeof field !== "string")
      || !Array.isArray(value[8])
      || value[8].some((tag) => typeof tag !== "string")
      || value.slice(9, 12).some((field) => typeof field !== "number")
      || typeof value[12] !== "string"
      || typeof value[13] !== "number"
      || value.slice(14).some((field) => typeof field !== "string")
    ) {
      return null;
    }
    return readyImageCacheItemFromRow({
      id: value[0],
      object_key: value[1],
      ext: value[2],
      device: value[3],
      brightness: value[4],
      theme: value[5],
      storage_slug: value[6],
      author: value[7],
      tags: value[8],
      width: value[9],
      height: value[10],
      image_size: value[11],
      cursor_image_time: value[12],
      sort_score: value[13],
      title: value[14],
      description: value[15],
      source: value[16],
      original: value[17],
      md5: value[18],
      cursor_created_at: value[19],
      cursor_updated_at: value[20]
    });
  } catch {
    return null;
  }
}

/** Fixed-position JSON avoids repeating field names for every cached image. */
export function serializeReadyImageCacheItem(item: ReadyImageCacheItem) {
  const serialized = JSON.stringify([
    item.id,
    item.object_key,
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
    item.image_time,
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

export function readyImageIdFromMember(member: string) {
  if (!/^[0-9a-f]{32}$/.test(member)) return null;
  return [
    member.slice(0, 8),
    member.slice(8, 12),
    member.slice(12, 16),
    member.slice(16, 20),
    member.slice(20)
  ].join("-");
}

export function readyImageThumbKey(item: ReadyImageCacheItem) {
  return thumbnailObjectKey(item.object_key);
}

function readyImageIdSuffix(item: Pick<ReadyImageCacheItem, "id">) {
  return item.id.slice(-12);
}

export function readyImageIdSuffixScore(
  item: Pick<ReadyImageCacheItem, "id">
) {
  return Number.parseInt(readyImageIdSuffix(item), 16);
}

export function readyImageStatFields(item: ReadyImageCacheItem) {
  return [
    "total",
    `device:${item.device}`,
    `brightness:${item.brightness}`,
    `axis:${item.device}:${item.brightness}`,
    `theme:${item.theme}`,
    ...item.tags.map((tag) => `tag:${tag}`),
    ...(item.author ? [`author:${item.author}`] : [])
  ];
}
