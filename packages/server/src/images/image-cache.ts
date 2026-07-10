import { appConfig, type Brightness, type Device } from "@imageshow/shared";
import { pingRedis, redis } from "../core/redis-client.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";

export const MD5_CACHE_PREFIX = "imageshow:md5:";
export const PUBLIC_IMAGES_CACHE_PREFIX = "imageshow:public_images:";
export const ORIGINAL_DIRECT_CACHE_PREFIX = "imageshow:original_direct:";
export const ADMIN_OVERVIEW_CACHE_PREFIX = "imageshow:admin_overview:";
const PUBLIC_IMAGES_GEN_KEY = "imageshow:public_images_gen";
export const IMAGE_LOOKUP_MEDIA_KEY = "imageshow:image_lookup:media";
export const IMAGE_LOOKUP_THUMBS_KEY = "imageshow:image_lookup:thumbs";
export const IMAGE_LOOKUP_ID_KEY = "imageshow:image_lookup:id";
export const GALLERY_FACETS_KEY = "imageshow:gallery_facets";
const ORIGINAL_DIRECT_CACHE_TTL_SECONDS = 60 * 60;
const ADMIN_OVERVIEW_CACHE_TTL_SECONDS = 60;

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
      || typeof value.theme !== "string" || typeof value.status !== "string" || !imageLookupStatuses.has(value.status)) return null;
    return value as ImageLookupByIdItem;
  } catch {
    return null;
  }
}

export async function publicImagesCacheGeneration(): Promise<string> {
  try {
    await pingRedis();
    return (await redis.get(PUBLIC_IMAGES_GEN_KEY)) ?? "0";
  } catch {
    return "0";
  }
}

export async function getPublicImagesCache<T>(key: string) {
  try {
    await pingRedis();
    const raw = await redis.get(`${PUBLIC_IMAGES_CACHE_PREFIX}${key}`);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

export async function setPublicImagesCache(key: string, value: unknown) {
  try {
    await pingRedis();
    await redis.set(`${PUBLIC_IMAGES_CACHE_PREFIX}${key}`, JSON.stringify(value), "EX", appConfig.derivedCacheTtlSeconds);
  } catch {
    // Redis 不可用时以 PostgreSQL 为准。
  }
}

export async function getPublicImageDetailCache<T>(key: string) {
  return getPublicImagesCache<T>(`detail:${key}`);
}

export async function setPublicImageDetailCache(key: string, value: unknown) {
  await setPublicImagesCache(`detail:${key}`, value);
}

export async function getOriginalDirectCache(key: string) {
  try {
    await pingRedis();
    const raw = await redis.get(`${ORIGINAL_DIRECT_CACHE_PREFIX}${key}`);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<OriginalDirectCacheValue>;
    return typeof value.direct === "boolean" ? { direct: value.direct } : null;
  } catch {
    return null;
  }
}

export async function setOriginalDirectCache(key: string, direct: boolean) {
  try {
    await pingRedis();
    await redis.set(`${ORIGINAL_DIRECT_CACHE_PREFIX}${key}`, JSON.stringify({ direct }), "EX", ORIGINAL_DIRECT_CACHE_TTL_SECONDS);
  } catch {
    // 外站直连策略缓存失败时，下次请求重新探测即可。
  }
}

export async function getAdminOverviewCache<T>(key: string) {
  try {
    await pingRedis();
    const raw = await redis.get(`${ADMIN_OVERVIEW_CACHE_PREFIX}${key}`);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

export async function setAdminOverviewCache(key: string, value: unknown) {
  try {
    await pingRedis();
    await redis.set(`${ADMIN_OVERVIEW_CACHE_PREFIX}${key}`, JSON.stringify(value), "EX", ADMIN_OVERVIEW_CACHE_TTL_SECONDS);
  } catch {
    // 管理概览缓存失败只会多跑一次聚合查询。
  }
}

export async function getImageLookupByThumbKey(thumbKey: string) {
  try {
    await pingRedis();
    const raw = await redis.hget(IMAGE_LOOKUP_THUMBS_KEY, thumbKey);
    return raw ? parseImageLookup(raw) : null;
  } catch {
    return null;
  }
}

export async function getImageLookupByObjectKey(objectKey: string) {
  try {
    await pingRedis();
    const raw = await redis.hget(IMAGE_LOOKUP_MEDIA_KEY, objectKey);
    return raw ? parseImageLookup(raw) : null;
  } catch {
    return null;
  }
}

export async function getImageLookupById(id: string) {
  try {
    await pingRedis();
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
    await pingRedis();
    const pipeline = redis.pipeline();
    for (const item of items) {
      const value = JSON.stringify(item);
      pipeline.hset(IMAGE_LOOKUP_MEDIA_KEY, item.object_key, value);
      pipeline.hset(IMAGE_LOOKUP_THUMBS_KEY, item.thumb_key, value);
    }
    pipeline.expire(IMAGE_LOOKUP_MEDIA_KEY, appConfig.derivedCacheTtlSeconds);
    pipeline.expire(IMAGE_LOOKUP_THUMBS_KEY, appConfig.derivedCacheTtlSeconds);
    await pipeline.exec();
  } catch {
    // 写缓存失败只会多一次后续数据库读取。
  }
}

export async function setImageLookupById(item: ImageLookupByIdItem) {
  try {
    await pingRedis();
    await redis.hset(IMAGE_LOOKUP_ID_KEY, item.id, JSON.stringify(item));
    await redis.expire(IMAGE_LOOKUP_ID_KEY, appConfig.derivedCacheTtlSeconds);
  } catch {
    // 写缓存失败只会多一次后续数据库读取。
  }
}

async function setImageLookupsById(items: ImageLookupByIdItem[]) {
  if (!items.length) return;
  try {
    await pingRedis();
    const pipeline = redis.pipeline();
    for (const item of items) pipeline.hset(IMAGE_LOOKUP_ID_KEY, item.id, JSON.stringify(item));
    pipeline.expire(IMAGE_LOOKUP_ID_KEY, appConfig.derivedCacheTtlSeconds);
    await pipeline.exec();
  } catch {
    // 批量预热失败时资源接口仍会回查 PostgreSQL。
  }
}

export async function warmImageLookups(items: Array<{
  id?: string;
  is_link?: boolean;
  object_key: string;
  original?: string | null;
  ext: string;
  storage_slug: string;
  device?: Device;
  brightness?: Brightness;
  theme?: string;
  status?: string;
}>) {
  const objectLookups: ImageLookupItem[] = [];
  const idLookups: ImageLookupByIdItem[] = [];
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
    if (item.id && item.device && item.brightness && item.theme && item.status) {
      idLookups.push({
        id: item.id,
        object_key: item.object_key,
        original: item.original ?? "",
        ext: item.ext,
        storage_slug: item.storage_slug,
        is_link: Boolean(item.is_link),
        device: item.device,
        brightness: item.brightness,
        theme: item.theme,
        status: item.status
      });
    }
  }
  await Promise.all([
    setImageLookups(objectLookups),
    setImageLookupsById(idLookups)
  ]);
}

export async function invalidateImageReadCaches() {
  try {
    await pingRedis();

    await Promise.all([
      redis.incr(PUBLIC_IMAGES_GEN_KEY),
      redis.del(IMAGE_LOOKUP_MEDIA_KEY, IMAGE_LOOKUP_THUMBS_KEY, IMAGE_LOOKUP_ID_KEY, GALLERY_FACETS_KEY)
    ]);
  } catch {
    // 写入路径已提交到 PostgreSQL，缓存失效失败不影响正确性。
  }
}

export async function getMd5Cache(md5: string) {
  try {
    await pingRedis();
    const raw = await redis.get(`${MD5_CACHE_PREFIX}${md5}`);
    return raw ? JSON.parse(raw) as unknown[] : null;
  } catch {
    return null;
  }
}

export async function setMd5Cache(md5: string, items: unknown[]) {
  try {
    await pingRedis();
    await redis.set(`${MD5_CACHE_PREFIX}${md5}`, JSON.stringify(items), "EX", appConfig.derivedCacheTtlSeconds);
  } catch {
    // 判重下次可回退到 PostgreSQL。
  }
}

export async function invalidateMd5Cache(md5: string) {
  if (!md5) return;
  try {
    await pingRedis();
    await redis.del(`${MD5_CACHE_PREFIX}${md5}`);
  } catch {
    // PostgreSQL 仍是真相源，缓存失效失败不影响正确性。
  }
}

export async function invalidateMd5Caches(md5s: string[]) {
  const keys = [...new Set(md5s.filter(Boolean))].map((md5) => `${MD5_CACHE_PREFIX}${md5}`);
  if (!keys.length) return;
  try {
    await pingRedis();
    await redis.del(...keys);
  } catch {
    // PostgreSQL 仍是真相源，旧缓存会自然过期。
  }
}

export async function getGalleryFacetsCache<T>(): Promise<T | null> {
  try {
    await pingRedis();
    const raw = await redis.get(GALLERY_FACETS_KEY);
    return raw ? JSON.parse(raw) as T : null;
  } catch {
    return null;
  }
}

export async function setGalleryFacetsCache(value: unknown) {
  try {
    await pingRedis();
    await redis.set(GALLERY_FACETS_KEY, JSON.stringify(value), "EX", appConfig.derivedCacheTtlSeconds);
  } catch {
    // Redis 不可用时以 PostgreSQL 为准。
  }
}
