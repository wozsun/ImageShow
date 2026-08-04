import { createHash } from "node:crypto";

const READY_IMAGE_CACHE_NAMESPACE = "imageshow:cache:images";
export const READY_IMAGE_CACHE_PREFIX = `${READY_IMAGE_CACHE_NAMESPACE}:`;
export const READY_IMAGE_META_KEY = `${READY_IMAGE_CACHE_PREFIX}meta`;
export const READY_IMAGE_ITEMS_KEY = `${READY_IMAGE_CACHE_PREFIX}items`;
export const READY_IMAGE_STATS_KEY = `${READY_IMAGE_CACHE_PREFIX}stats`;
export const READY_IMAGE_INTEGRITY_KEY = `${READY_IMAGE_CACHE_PREFIX}integrity`;
export const READY_IMAGE_ALL_INDEX_KEY = `${READY_IMAGE_CACHE_PREFIX}index:all`;
export const READY_IMAGE_OBJECT_LOOKUP_KEY = `${READY_IMAGE_CACHE_PREFIX}lookup:object`;
export const READY_IMAGE_THUMB_LOOKUP_KEY = `${READY_IMAGE_CACHE_PREFIX}lookup:thumb`;
export const READY_IMAGE_ID_SUFFIX_LOOKUP_KEY = `${READY_IMAGE_CACHE_PREFIX}lookup:id-suffix`;
export const READY_IMAGE_FILTER_LRU_KEY = `${READY_IMAGE_CACHE_PREFIX}filter-lru`;
export const READY_IMAGE_FILTER_COUNTS_KEY = `${READY_IMAGE_CACHE_PREFIX}filter-counts`;
export const READY_IMAGE_STATS_RESULT_LRU_KEY = `${READY_IMAGE_CACHE_PREFIX}stats-result-lru`;

const READY_IMAGE_FILTER_KEY_PREFIX = `${READY_IMAGE_CACHE_PREFIX}filter:`;
const READY_IMAGE_FILTER_META_KEY_PREFIX = `${READY_IMAGE_CACHE_PREFIX}filter-meta:`;

function imageIndexKey(axis: string, ...values: string[]) {
  return `${READY_IMAGE_CACHE_PREFIX}index:${axis}:${values.join(":")}`;
}

export function readyImageAxisIndexKey(device: string, brightness: string) {
  return imageIndexKey("axis", device, brightness);
}

export function readyImageThemeIndexKey(theme: string) {
  return imageIndexKey("theme", theme);
}

export function readyImageTagIndexKey(tag: string) {
  return imageIndexKey("tag", tag);
}

export function readyImageAuthorIndexKey(author: string) {
  return imageIndexKey("author", author);
}

function filterDigest(signature: string) {
  return createHash("sha256").update(signature).digest("hex");
}

export function readyImageFilterKey(signature: string) {
  return `${READY_IMAGE_FILTER_KEY_PREFIX}${filterDigest(signature)}`;
}

export function readyImageFilterMetaKey(signature: string) {
  return `${READY_IMAGE_FILTER_META_KEY_PREFIX}${filterDigest(signature)}`;
}

export function readyImageFilterMetaKeyForFilterKey(key: string) {
  if (!key.startsWith(READY_IMAGE_FILTER_KEY_PREFIX)) {
    throw new Error(`Invalid ready-image filter key: ${key}`);
  }
  return `${READY_IMAGE_FILTER_META_KEY_PREFIX}${key.slice(
    READY_IMAGE_FILTER_KEY_PREFIX.length
  )}`;
}

export function readyImageStatsResultKey(signature: string) {
  return `${READY_IMAGE_CACHE_PREFIX}stats-result:${filterDigest(signature)}`;
}

function isReadyImageCacheKey(key: string) {
  return key.startsWith(READY_IMAGE_CACHE_PREFIX);
}

export function assertReadyImageCacheKey(key: string) {
  if (!isReadyImageCacheKey(key)) {
    throw new Error(`Refusing to operate on non-image-cache key: ${key}`);
  }
  return key;
}
