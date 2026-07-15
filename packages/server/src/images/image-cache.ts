import { appConfig, type Brightness, type Device } from "@imageshow/shared";
import { redis } from "../core/redis-client.ts";
import { deleteRedisKeys, getRedisJson, setRedisJson } from "../core/redis-json.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";

export const MD5_CACHE_PREFIX = "imageshow:md5:";
export const PUBLIC_IMAGES_CACHE_PREFIX = "imageshow:public_images:";
export const ORIGINAL_DIRECT_CACHE_PREFIX = "imageshow:original_direct:";
export const ADMIN_OVERVIEW_CACHE_PREFIX = "imageshow:admin_overview:";
const PUBLIC_IMAGES_GEN_KEY = "imageshow:public_images_gen";
export const IMAGE_LOOKUP_MEDIA_KEY = "imageshow:image_lookup:media";
export const IMAGE_LOOKUP_THUMBS_KEY = "imageshow:image_lookup:thumbs";
export const IMAGE_LOOKUP_ID_KEY = "imageshow:image_lookup:id";
const GALLERY_FACETS_KEY = "imageshow:gallery_facets";
const ORIGINAL_DIRECT_CACHE_TTL_SECONDS = 60 * 60;
const ADMIN_OVERVIEW_CACHE_TTL_SECONDS = 60;
export const IMAGE_LOOKUP_TTL_SECONDS = appConfig.imageLookup.ttlSeconds;

export type ImageLookupItem = {
  object_key: string;
  thumb_key: string;
  ext: string;
  storage_slug: string;
  status: "ready";
};
export type ImageLookupByIdItem = {
  id: string;
  object_key: string;
  original: string;
  ext: string;
  storage_slug: string;
  is_link: boolean;
  device: Device;
  brightness: Brightness;
  theme: string;
  status: string;
  description: string;
  source: string;
};
type ImageObjectLookupSource = {
  is_link?: boolean;
  object_key: string;
  ext: string;
  storage_slug: string;
  status?: string;
};
export type CompleteImageLookupSource = {
  id: string;
  object_key: string;
  original: string | null;
  ext: string;
  storage_slug: string;
  is_link: boolean;
  device: Device;
  brightness: Brightness;
  theme: string;
  status: string;
  description: string | null;
  source: string | null;
};
type OriginalDirectCacheValue = { direct: boolean };

const imageLookupExtensions = new Set(["jpg", "png", "webp", "gif", "avif"]);
const imageLookupStatuses = new Set(["ready", "deleted"]);

/** @internal Exported only for local cache-shape verification. */
export function parseImageLookup(raw: string): ImageLookupItem | null {
  try {
    const value = JSON.parse(raw) as Partial<ImageLookupItem>;
    if (
      typeof value.object_key !== "string" || !value.object_key ||
      typeof value.thumb_key !== "string" || !value.thumb_key ||
      typeof value.ext !== "string" || !imageLookupExtensions.has(value.ext) ||
      typeof value.storage_slug !== "string" || !value.storage_slug ||
      value.status !== "ready"
    ) return null;
    return value as ImageLookupItem;
  } catch {
    return null;
  }
}

/** @internal Exported only for local cache-shape verification. */
export function parseImageLookupById(raw: string): ImageLookupByIdItem | null {
  try {
    const value = JSON.parse(raw) as Partial<ImageLookupByIdItem>;
    if (typeof value.id !== "string" || typeof value.object_key !== "string" || typeof value.original !== "string"
      || typeof value.ext !== "string" || !imageLookupExtensions.has(value.ext)
      || typeof value.storage_slug !== "string" || typeof value.is_link !== "boolean"
      || !appConfig.devices.includes(value.device as Device) || !appConfig.brightness.includes(value.brightness as Brightness)
      || typeof value.theme !== "string" || typeof value.status !== "string" || !imageLookupStatuses.has(value.status)
      || typeof value.description !== "string" || typeof value.source !== "string") return null;
    return value as ImageLookupByIdItem;
  } catch {
    return null;
  }
}

export async function publicImagesCacheGeneration(): Promise<string> {
  try {
    return (await redis.get(PUBLIC_IMAGES_GEN_KEY)) ?? "0";
  } catch {
    return "0";
  }
}

export async function getPublicImagesCache<T>(key: string) {
  return getRedisJson<T>(`${PUBLIC_IMAGES_CACHE_PREFIX}${key}`);
}

export async function setPublicImagesCache(key: string, value: unknown) {
  await setRedisJson(`${PUBLIC_IMAGES_CACHE_PREFIX}${key}`, value);
}

export async function getPublicImageDetailCache<T>(key: string) {
  return getPublicImagesCache<T>(`detail:${key}`);
}

export async function setPublicImageDetailCache(key: string, value: unknown) {
  await setPublicImagesCache(`detail:${key}`, value);
}

export async function getOriginalDirectCache(key: string) {
  const value = await getRedisJson<Partial<OriginalDirectCacheValue>>(`${ORIGINAL_DIRECT_CACHE_PREFIX}${key}`);
  return typeof value?.direct === "boolean" ? { direct: value.direct } : null;
}

export async function setOriginalDirectCache(key: string, direct: boolean) {
  await setRedisJson(`${ORIGINAL_DIRECT_CACHE_PREFIX}${key}`, { direct }, ORIGINAL_DIRECT_CACHE_TTL_SECONDS);
}

export async function getAdminOverviewCache<T>(key: string) {
  return getRedisJson<T>(`${ADMIN_OVERVIEW_CACHE_PREFIX}${key}`);
}

export async function setAdminOverviewCache(key: string, value: unknown) {
  await setRedisJson(`${ADMIN_OVERVIEW_CACHE_PREFIX}${key}`, value, ADMIN_OVERVIEW_CACHE_TTL_SECONDS);
}

export async function getImageLookupByThumbKey(thumbKey: string) {
  try {
    const raw = await redis.hget(IMAGE_LOOKUP_THUMBS_KEY, thumbKey);
    return raw ? parseImageLookup(raw) : null;
  } catch {
    return null;
  }
}

export async function getImageLookupByObjectKey(objectKey: string) {
  try {
    const raw = await redis.hget(IMAGE_LOOKUP_MEDIA_KEY, objectKey);
    return raw ? parseImageLookup(raw) : null;
  } catch {
    return null;
  }
}

export async function getImageLookupById(id: string) {
  try {
    const raw = await redis.hget(IMAGE_LOOKUP_ID_KEY, id);
    return raw ? parseImageLookupById(raw) : null;
  } catch {
    return null;
  }
}

export async function setImageLookup(item: ImageLookupItem) {
  await setImageLookups([item]);
}

async function setImageLookups(items: ImageLookupItem[]) {
  if (!items.length) return;
  try {
    const pipeline = redis.pipeline();
    const mediaFieldValues = items.flatMap((item) => [item.object_key, JSON.stringify(item)]);
    const thumbFieldValues = items.flatMap((item) => [item.thumb_key, JSON.stringify(item)]);
    pipeline.hsetex(
      IMAGE_LOOKUP_MEDIA_KEY,
      "EX",
      IMAGE_LOOKUP_TTL_SECONDS,
      "FIELDS",
      items.length,
      ...mediaFieldValues
    );
    pipeline.hsetex(
      IMAGE_LOOKUP_THUMBS_KEY,
      "EX",
      IMAGE_LOOKUP_TTL_SECONDS,
      "FIELDS",
      items.length,
      ...thumbFieldValues
    );
    await execRedisPipeline(pipeline);
  } catch {
    // HSETEX 将每个 hash 的字段写入与 TTL 原子完成；失败只会造成缓存 miss。
  }
}

function imageLookupByIdItem(item: CompleteImageLookupSource): ImageLookupByIdItem {
  return {
    id: item.id,
    object_key: item.object_key,
    original: item.original ?? "",
    ext: item.ext,
    storage_slug: item.storage_slug,
    is_link: item.is_link,
    device: item.device,
    brightness: item.brightness,
    theme: item.theme,
    status: item.status,
    description: item.description ?? "",
    source: item.source ?? ""
  };
}

export async function setImageLookupById(item: CompleteImageLookupSource): Promise<ImageLookupByIdItem> {
  const lookup = imageLookupByIdItem(item);
  try {
    await redis.hsetex(
      IMAGE_LOOKUP_ID_KEY,
      "EX",
      IMAGE_LOOKUP_TTL_SECONDS,
      "FIELDS",
      1,
      lookup.id,
      JSON.stringify(lookup)
    );
  } catch {
    // 写缓存失败时资源接口仍会回查 PostgreSQL。
  }
  return lookup;
}

async function setImageLookupsById(items: ImageLookupByIdItem[]) {
  if (!items.length) return;
  try {
    const fieldValues = items.flatMap((item) => [item.id, JSON.stringify(item)]);
    await redis.hsetex(
      IMAGE_LOOKUP_ID_KEY,
      "EX",
      IMAGE_LOOKUP_TTL_SECONDS,
      "FIELDS",
      items.length,
      ...fieldValues
    );
  } catch {
    // 批量预热失败时资源接口仍会回查 PostgreSQL。
  }
}

export async function warmObjectLookups(items: readonly ImageObjectLookupSource[]) {
  const objectLookups: ImageLookupItem[] = [];
  for (const item of items) {
    if (!item.is_link && item.status === "ready") {
      objectLookups.push({
        object_key: item.object_key,
        thumb_key: thumbnailObjectKey(item.object_key),
        ext: item.ext,
        storage_slug: item.storage_slug,
        status: "ready"
      });
    }
  }
  await setImageLookups(objectLookups);
}

async function warmImageIdLookups(items: readonly CompleteImageLookupSource[]) {
  const idLookups = items.map(imageLookupByIdItem);
  await setImageLookupsById(idLookups);
}

export async function warmCompleteImageLookups(items: readonly CompleteImageLookupSource[]) {
  await Promise.all([
    warmObjectLookups(items),
    warmImageIdLookups(items)
  ]);
}

export async function invalidateImageReadCaches(options: { facets?: boolean } = {}) {
  try {
    const pipeline = redis.pipeline().incr(PUBLIC_IMAGES_GEN_KEY);
    if (options.facets ?? true) pipeline.del(GALLERY_FACETS_KEY);
    await execRedisPipeline(pipeline);
  } catch {
    // 写入路径已提交到 PostgreSQL，缓存失效失败不影响正确性。
  }
}

export async function invalidateImageLookupEntries(items: Array<{
  id?: string;
  object_key?: string;
  thumb_key?: string;
}>) {
  const ids = [...new Set(items.flatMap((item) => item.id ? [item.id] : []))];
  const objectKeys = [...new Set(items.flatMap((item) => item.object_key ? [item.object_key] : []))];
  const thumbKeys = [...new Set(items.flatMap((item) => item.thumb_key
    ? [item.thumb_key]
    : item.object_key ? [thumbnailObjectKey(item.object_key)] : []))];
  if (!ids.length && !objectKeys.length && !thumbKeys.length) return;
  try {
    const pipeline = redis.pipeline();
    if (ids.length) pipeline.hdel(IMAGE_LOOKUP_ID_KEY, ...ids);
    if (objectKeys.length) pipeline.hdel(IMAGE_LOOKUP_MEDIA_KEY, ...objectKeys);
    if (thumbKeys.length) pipeline.hdel(IMAGE_LOOKUP_THUMBS_KEY, ...thumbKeys);
    await execRedisPipeline(pipeline);
  } catch {
    // 字段有独立 TTL；失效失败不会延长同一 hash 中其他字段的寿命。
  }
}

export async function getMd5Cache(md5: string) {
  return getRedisJson<unknown[]>(`${MD5_CACHE_PREFIX}${md5}`);
}

export async function setMd5Cache(md5: string, items: unknown[]) {
  await setRedisJson(`${MD5_CACHE_PREFIX}${md5}`, items);
}

export async function invalidateMd5Cache(md5: string) {
  if (!md5) return;
  await deleteRedisKeys(`${MD5_CACHE_PREFIX}${md5}`);
}

export async function invalidateMd5Caches(md5s: string[]) {
  const keys = [...new Set(md5s.filter(Boolean))].map((md5) => `${MD5_CACHE_PREFIX}${md5}`);
  if (!keys.length) return;
  await deleteRedisKeys(...keys);
}

export async function getGalleryFacetsCache<T>(): Promise<T | null> {
  return getRedisJson<T>(GALLERY_FACETS_KEY);
}

export async function setGalleryFacetsCache(value: unknown) {
  await setRedisJson(GALLERY_FACETS_KEY, value);
}

export async function invalidateGalleryFacetsCache() {
  await deleteRedisKeys(GALLERY_FACETS_KEY);
}
