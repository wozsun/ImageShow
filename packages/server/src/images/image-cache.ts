import { appConfig } from "@imageshow/shared";
import { pingRedis, redis } from "../core/redis-client.js";

export const MD5_CACHE_PREFIX = "imageshow:md5:";
export const PUBLIC_IMAGES_CACHE_PREFIX = "imageshow:public_images:";
const PUBLIC_IMAGES_GEN_KEY = "imageshow:public_images_gen";
export const IMAGE_LOOKUP_MEDIA_KEY = "imageshow:image_lookup:media";
export const IMAGE_LOOKUP_THUMBS_KEY = "imageshow:image_lookup:thumbs";
export const GALLERY_FACETS_KEY = "imageshow:gallery_facets";

export type ImageLookupItem = { object_key: string; thumb_key: string; ext: string; slug?: string };

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
    await redis.set(`${PUBLIC_IMAGES_CACHE_PREFIX}${key}`, JSON.stringify(value), "EX", appConfig.folderMapTtlSeconds);
  } catch {
    // Redis 不可用时以 PostgreSQL 为准。
  }
}

export async function getImageLookupByThumbKey(thumbKey: string) {
  try {
    await pingRedis();
    const raw = await redis.hget(IMAGE_LOOKUP_THUMBS_KEY, thumbKey);
    return raw ? JSON.parse(raw) as ImageLookupItem : null;
  } catch {
    return null;
  }
}

export async function getImageLookupByObjectKey(objectKey: string) {
  try {
    await pingRedis();
    const raw = await redis.hget(IMAGE_LOOKUP_MEDIA_KEY, objectKey);
    return raw ? JSON.parse(raw) as ImageLookupItem : null;
  } catch {
    return null;
  }
}

export async function setImageLookup(item: ImageLookupItem) {
  await setImageLookups([item]);
}

export async function setImageLookups(items: ImageLookupItem[]) {
  if (!items.length) return;
  try {
    await pingRedis();
    const pipeline = redis.pipeline();
    for (const item of items) {
      const value = JSON.stringify(item);
      pipeline.hset(IMAGE_LOOKUP_MEDIA_KEY, item.object_key, value);
      pipeline.hset(IMAGE_LOOKUP_THUMBS_KEY, item.thumb_key, value);
    }
    pipeline.expire(IMAGE_LOOKUP_MEDIA_KEY, appConfig.folderMapTtlSeconds);
    pipeline.expire(IMAGE_LOOKUP_THUMBS_KEY, appConfig.folderMapTtlSeconds);
    await pipeline.exec();
  } catch {
    // 写缓存失败只会多一次后续数据库读取。
  }
}

export async function invalidateImageReadCaches() {
  try {
    await pingRedis();

    await Promise.all([
      redis.incr(PUBLIC_IMAGES_GEN_KEY),
      redis.del(IMAGE_LOOKUP_MEDIA_KEY, IMAGE_LOOKUP_THUMBS_KEY, GALLERY_FACETS_KEY)
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
    await redis.set(`${MD5_CACHE_PREFIX}${md5}`, JSON.stringify(items), "EX", appConfig.folderMapTtlSeconds);
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
    await redis.set(GALLERY_FACETS_KEY, JSON.stringify(value), "EX", appConfig.folderMapTtlSeconds);
  } catch {
    // Redis 不可用时以 PostgreSQL 为准。
  }
}
