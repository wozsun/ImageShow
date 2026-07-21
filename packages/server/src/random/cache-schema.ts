import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { Brightness, Device } from "@imageshow/shared";

export const RANDOM_CACHE_NAMESPACE = "imageshow:random:v2";
export const RANDOM_CURRENT_KEY = `${RANDOM_CACHE_NAMESPACE}:current`;
export const RANDOM_MUTATION_REVISION_KEY = `${RANDOM_CACHE_NAMESPACE}:version`;
export const RANDOM_UPDATE_LOCK_KEY = `${RANDOM_CACHE_NAMESPACE}:update_lock`;
export const RANDOM_REBUILD_LOCK_KEY = `${RANDOM_CACHE_NAMESPACE}:rebuild_lock`;
export const RANDOM_REBUILD_COMPLETED_KEY = `${RANDOM_CACHE_NAMESPACE}:rebuild_completed`;
export const GALLERY_FILTER_OPTIONS_KEY = "imageshow:gallery_filter_options:v2";

export const RANDOM_UPDATE_LOCK_TTL_MS = 30_000;
export const RANDOM_UPDATE_LOCK_RENEW_INTERVAL_MS = 10_000;
export const RANDOM_REBUILD_LOCK_TTL_MS = 120_000;
export const RANDOM_REBUILD_WAIT_INTERVAL_MS = 100;
export const RANDOM_REBUILD_WAIT_ATTEMPTS =
  RANDOM_REBUILD_LOCK_TTL_MS / RANDOM_REBUILD_WAIT_INTERVAL_MS;
export const RANDOM_OLD_GENERATION_TTL_SECONDS = 60 * 60;
export const RANDOM_FILTER_TTL_SECONDS = 90;
export const RANDOM_FILTER_CONSISTENCY_WAIT_MS = 3_000;
export const RANDOM_FILTER_WAIT_BASE_MS = 25;
export const RANDOM_FILTER_WAIT_MAX_MS = 250;
export const RANDOM_REBUILD_BATCH_SIZE = 500;
export const RANDOM_CLEANUP_BATCH_SIZE = 500;

export const RANDOM_GENERATION_PUBLISH_SCRIPT = `
  local currentRevision = tonumber(redis.call("GET", KEYS[2]) or "0")
  if currentRevision ~= tonumber(ARGV[1]) then return { 0, "" } end
  local previousGeneration = redis.call("GET", KEYS[1]) or ""
  redis.call("SET", KEYS[1], ARGV[2])
  redis.call("SET", KEYS[3], ARGV[1])
  redis.call("SET", KEYS[4], ARGV[3])
  return { 1, previousGeneration }
`;

export const RANDOM_INCREMENTAL_COMPLETE_SCRIPT = `
  local currentGeneration = redis.call("GET", KEYS[1]) or ""
  local currentRevision = tonumber(redis.call("GET", KEYS[2]) or "0")
  local currentToken = redis.call("GET", KEYS[4]) or ""
  if currentGeneration ~= ARGV[1]
    or currentRevision ~= tonumber(ARGV[2])
    or currentToken ~= ARGV[3] then
    return 0
  end
  redis.call("SET", KEYS[3], ARGV[2])
  return 1
`;

export const RANDOM_UPDATE_LOCK_RENEW_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

export const RANDOM_FILTER_CONSISTENCY_SCRIPT = `
  local requestedRevision = redis.call("GET", KEYS[1]) or "0"
  local completedRevision = redis.call("GET", KEYS[2]) or "0"
  local updateInProgress = redis.call("EXISTS", KEYS[3])
  return { requestedRevision, completedRevision, updateInProgress }
`;

export const RANDOM_FILTER_CACHE_READ_SCRIPT = `
  if redis.call("EXISTS", KEYS[5]) == 1 then return -2 end
  local currentRevision = redis.call("GET", KEYS[3]) or "0"
  local completedRevision = tonumber(redis.call("GET", KEYS[4]) or "0")
  if currentRevision ~= ARGV[1]
    or completedRevision < tonumber(currentRevision) then
    return -2
  end
  if redis.call("EXISTS", KEYS[1]) == 1 then
    local count = redis.call("SCARD", KEYS[1])
    redis.call("EXPIRE", KEYS[1], ARGV[2])
    return count
  end
  if redis.call("EXISTS", KEYS[2]) == 1 then
    redis.call("EXPIRE", KEYS[2], ARGV[2])
    return 0
  end
  return -1
`;

export const RANDOM_FILTER_PUBLISH_SCRIPT = `
  if redis.call("EXISTS", KEYS[6]) == 1 then
    redis.call("UNLINK", KEYS[3])
    return { 0, 0 }
  end
  local currentRevision = redis.call("GET", KEYS[4]) or "0"
  local completedRevision = tonumber(redis.call("GET", KEYS[5]) or "0")
  if currentRevision ~= ARGV[1]
    or completedRevision < tonumber(currentRevision) then
    redis.call("UNLINK", KEYS[3])
    return { 0, 0 }
  end
  local count = redis.call("SCARD", KEYS[3])
  if count == 0 then
    redis.call("UNLINK", KEYS[1])
    redis.call("SET", KEYS[2], "1", "EX", ARGV[2])
    redis.call("UNLINK", KEYS[3])
  else
    redis.call("RENAME", KEYS[3], KEYS[1])
    redis.call("EXPIRE", KEYS[1], ARGV[2])
    redis.call("UNLINK", KEYS[2])
  end
  return { 1, count }
`;

export type RandomCategoryCounts = Record<
  string,
  Record<string, Record<string, number>>
>;

export type GalleryFilterOptions = {
  devices: string[];
  brightnesses: string[];
  themes: string[];
};

export type RandomPoolSnapshot = {
  generation: string;
  categoryCounts: RandomCategoryCounts;
  themes: string[];
};

export type RandomPoolItem = {
  id: string;
  object_key: string;
  ext: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  storage_slug: string;
  author: string;
  tags: string[];
};

type RetryableRandomPoolError = Error & { retryAfterSeconds: number };

export function redisUnavailable(): RetryableRandomPoolError {
  const error = new Error("Redis unavailable");
  error.name = "redis_unavailable";
  return Object.assign(error, { retryAfterSeconds: 1 });
}

export function randomPoolUpdating(): RetryableRandomPoolError {
  const error = new Error("Random pool update is still in progress");
  error.name = "random_pool_updating";
  return Object.assign(error, { retryAfterSeconds: 1 });
}

export function randomPoolRetryAfterSeconds(error: unknown) {
  if (
    !error
    || typeof error !== "object"
    || !["redis_unavailable", "random_pool_updating"].includes(
      String((error as { name?: unknown }).name)
    )
  ) {
    return undefined;
  }
  const seconds = Number((error as { retryAfterSeconds?: unknown }).retryAfterSeconds);
  return Number.isInteger(seconds) && seconds > 0 ? seconds : 1;
}

export function randomKey(generation: string, ...parts: string[]) {
  return [RANDOM_CACHE_NAMESPACE, generation, ...parts].join(":");
}

export function randomManifestKey(generation: string) {
  return randomKey(generation, "keys");
}

export function randomItemKey(generation: string) {
  return randomKey(generation, "item");
}

export function randomSnapshotKey(generation: string) {
  return randomKey(generation, "snapshot");
}

export function randomAxisSetKey(
  generation: string,
  device: string,
  brightness: string
) {
  return randomKey(generation, "axis", device, brightness);
}

export function randomCategorySetKey(
  generation: string,
  device: string,
  brightness: string,
  theme: string
) {
  return randomKey(generation, "cat", device, brightness, theme);
}

export function randomTagSetKey(generation: string, tag: string) {
  return randomKey(generation, "tag", tag);
}

export function randomAuthorSetKey(generation: string, author: string) {
  return randomKey(generation, "author", author);
}

export function randomFilterKey(
  generation: string,
  signature: string,
  suffix: string
) {
  const hash = createHash("sha1").update(signature).digest("hex");
  return randomKey(generation, "filter", hash, suffix);
}

export function parseRandomItem(raw: string | null): RandomPoolItem | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<RandomPoolItem> & { is_link?: unknown };
    if (
      "is_link" in value
      || typeof value.id !== "string" || !value.id
      || typeof value.object_key !== "string" || !value.object_key
      || typeof value.ext !== "string" || !["jpg", "png", "webp", "gif", "avif"].includes(value.ext)
      || !["pc", "mb"].includes(String(value.device))
      || !["dark", "light"].includes(String(value.brightness))
      || typeof value.theme !== "string"
      || typeof value.storage_slug !== "string" || !value.storage_slug
      || typeof value.author !== "string"
      || !Array.isArray(value.tags)
      || value.tags.length > 50
      || value.tags.some((tag) => typeof tag !== "string")
    ) return null;
    return value as RandomPoolItem;
  } catch {
    return null;
  }
}

export function adjustCategoryCounts(
  counts: RandomCategoryCounts,
  item: Pick<RandomPoolItem, "device" | "brightness" | "theme">,
  delta: number
) {
  counts[item.device] ??= {};
  counts[item.device][item.brightness] ??= {};
  counts[item.device][item.brightness][item.theme] = Math.max(
    0,
    Number(counts[item.device][item.brightness][item.theme] ?? 0) + delta
  );
  if (delta < 0) pruneEmptyCategoryCounts(counts);
}

function pruneEmptyCategoryCounts(counts: RandomCategoryCounts) {
  for (const [device, deviceMap] of Object.entries(counts)) {
    for (const [brightness, brightnessMap] of Object.entries(deviceMap)) {
      for (const [theme, count] of Object.entries(brightnessMap)) {
        if (!Number.isFinite(Number(count)) || Number(count) <= 0) {
          delete brightnessMap[theme];
        }
      }
      if (!Object.keys(brightnessMap).length) delete deviceMap[brightness];
    }
    if (!Object.keys(deviceMap).length) delete counts[device];
  }
}

export function filterOptionsFromCategoryCounts(
  counts: RandomCategoryCounts
): GalleryFilterOptions {
  const themes = new Set<string>();
  for (const device of Object.values(counts)) {
    for (const brightness of Object.values(device)) {
      for (const theme of Object.keys(brightness)) themes.add(theme);
    }
  }
  return {
    devices: ["pc", "mb"],
    brightnesses: ["light", "dark"],
    themes: [...themes].sort()
  };
}

export function mapRandomItems(
  rows: Array<Record<string, unknown>>
): RandomPoolItem[] {
  return rows.map((row) => ({
    id: String(row.id),
    object_key: String(row.object_key),
    ext: String(row.ext),
    device: row.device as Device,
    brightness: row.brightness as Brightness,
    theme: String(row.theme),
    storage_slug: String(row.storage_slug),
    author: typeof row.author === "string" ? row.author : "",
    tags: Array.isArray(row.tags) ? row.tags as string[] : []
  }));
}

export function registerRandomKeys(generation: string, keys: Set<string>) {
  keys.add(randomManifestKey(generation));
  keys.add(randomItemKey(generation));
  keys.add(randomSnapshotKey(generation));
}

function membershipKeys(generation: string, item: RandomPoolItem): string[] {
  const keys = [
    randomAxisSetKey(generation, item.device, item.brightness),
    randomCategorySetKey(
      generation,
      item.device,
      item.brightness,
      item.theme
    )
  ];
  for (const tag of item.tags) keys.push(randomTagSetKey(generation, tag));
  if (item.author) keys.push(randomAuthorSetKey(generation, item.author));
  return keys;
}

export function collectMembership(
  target: Map<string, string[]>,
  generation: string,
  item: RandomPoolItem,
  keys?: Set<string>
) {
  for (const key of membershipKeys(generation, item)) {
    const ids = target.get(key);
    if (ids) ids.push(item.id);
    else target.set(key, [item.id]);
    keys?.add(key);
  }
}

export function queueMembershipMap(
  pipeline: ReturnType<Redis["pipeline"]>,
  command: "sadd" | "srem",
  memberships: Map<string, string[]>
) {
  for (const [key, ids] of memberships) pipeline[command](key, ...ids);
}

export function queueSnapshot(
  pipeline: ReturnType<Redis["pipeline"]>,
  generation: string,
  categoryCounts: RandomCategoryCounts,
  updateGalleryOptions = true
) {
  pipeline.set(
    randomSnapshotKey(generation),
    JSON.stringify({ categoryCounts })
  );
  if (updateGalleryOptions) {
    pipeline.set(
      GALLERY_FILTER_OPTIONS_KEY,
      JSON.stringify(filterOptionsFromCategoryCounts(categoryCounts))
    );
  }
}

export function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

export function redisRevision(raw: string | null) {
  const revision = Number(raw ?? "0");
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}
