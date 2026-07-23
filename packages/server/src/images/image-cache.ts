import { appConfig, type Brightness, type Device } from "@imageshow/shared";
import { redis } from "../core/redis-client.ts";
import { getRedisJson, setRedisJson } from "../core/redis-json.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import {
  parseImageLookup,
  parseImageLookupById,
  type ImageLookupByIdItem,
  type ImageLookupItem
} from "./image-cache-schema.ts";

export const MD5_CACHE_PREFIX = "imageshow:md5:";
export const PUBLIC_IMAGES_CACHE_PREFIX = "imageshow:public_images:";
export const ORIGINAL_DIRECT_CACHE_PREFIX = "imageshow:original_direct:";
export const ADMIN_OVERVIEW_CACHE_PREFIX = "imageshow:admin_overview:";
export const IMAGE_CACHE_REVISION_KEY = "imageshow:image_cache_revision";
export const IMAGE_LOOKUP_MEDIA_KEY = "imageshow:image_lookup:v2:media";
export const IMAGE_LOOKUP_THUMBS_KEY = "imageshow:image_lookup:v2:thumbs";
export const IMAGE_LOOKUP_ID_KEY = "imageshow:image_lookup:v2:id";
const GALLERY_FACETS_KEY = "imageshow:gallery_facets";
const ORIGINAL_DIRECT_CACHE_TTL_SECONDS = 60 * 60;
const ADMIN_OVERVIEW_CACHE_TTL_SECONDS = 60;
export const IMAGE_LOOKUP_TTL_SECONDS = appConfig.imageLookup.ttlSeconds;

type ImageObjectLookupSource = {
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
  device: Device;
  brightness: Brightness;
  theme: string;
  status: string;
  description: string | null;
  source: string | null;
};
type OriginalDirectCacheValue = { direct: boolean };

let localMutationEpoch = 0;
let synchronizedMutationEpoch = 0;
let revisionQueue: Promise<void> = Promise.resolve();

function synchronizeImageCacheRevision(targetEpoch: number): Promise<string | null> {
  let result: string | null = null;
  const operation = revisionQueue.then(async () => {
    try {
      result = String(await redis.incr(IMAGE_CACHE_REVISION_KEY));
      synchronizedMutationEpoch = Math.max(synchronizedMutationEpoch, targetEpoch);
    } catch {
      result = null;
    }
  });
  revisionQueue = operation.catch(() => undefined);
  return operation.then(() => result);
}

/**
 * Returns null whenever Redis cannot prove the current cache generation. Read
 * paths must then use PostgreSQL and skip cache writes.
 */
export async function imageCacheRevision(): Promise<string | null> {
  const requiredEpoch = localMutationEpoch;
  if (synchronizedMutationEpoch < requiredEpoch) {
    await synchronizeImageCacheRevision(requiredEpoch);
  }
  if (synchronizedMutationEpoch < localMutationEpoch) return null;
  try {
    return (await redis.get(IMAGE_CACHE_REVISION_KEY)) ?? "0";
  } catch {
    return null;
  }
}

async function advanceImageCacheRevision() {
  localMutationEpoch += 1;
  return synchronizeImageCacheRevision(localMutationEpoch);
}

async function usableRevision(expectedRevision?: string | null) {
  const current = await imageCacheRevision();
  if (!current) return null;
  if (expectedRevision !== undefined && expectedRevision !== current) return null;
  return current;
}

function revisionKey(prefix: string, revision: string, key = "") {
  return `${prefix}${revision}${key ? `:${key}` : ""}`;
}

function lookupHashKey(baseKey: string, revision: string) {
  return `${baseKey}:${revision}`;
}

export async function publicImagesCacheGeneration(): Promise<string | null> {
  return imageCacheRevision();
}

export async function getPublicImagesCache<T>(key: string, expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return null;
  return getRedisJson<T>(revisionKey(PUBLIC_IMAGES_CACHE_PREFIX, revision, key));
}

export async function setPublicImagesCache(key: string, value: unknown, expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return;
  await setRedisJson(revisionKey(PUBLIC_IMAGES_CACHE_PREFIX, revision, key), value);
}

export async function getPublicImageDetailCache<T>(key: string, expectedRevision?: string | null) {
  return getPublicImagesCache<T>(`detail:${key}`, expectedRevision);
}

export async function setPublicImageDetailCache(key: string, value: unknown, expectedRevision?: string | null) {
  await setPublicImagesCache(`detail:${key}`, value, expectedRevision);
}

export async function getOriginalDirectCache(key: string) {
  const value = await getRedisJson<Partial<OriginalDirectCacheValue>>(`${ORIGINAL_DIRECT_CACHE_PREFIX}${key}`);
  return typeof value?.direct === "boolean" ? { direct: value.direct } : null;
}

export async function setOriginalDirectCache(key: string, direct: boolean) {
  await setRedisJson(`${ORIGINAL_DIRECT_CACHE_PREFIX}${key}`, { direct }, ORIGINAL_DIRECT_CACHE_TTL_SECONDS);
}

export async function getAdminOverviewCache<T>(key: string, expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return null;
  return getRedisJson<T>(revisionKey(ADMIN_OVERVIEW_CACHE_PREFIX, revision, key));
}

export async function setAdminOverviewCache(key: string, value: unknown, expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return;
  await setRedisJson(revisionKey(ADMIN_OVERVIEW_CACHE_PREFIX, revision, key), value, ADMIN_OVERVIEW_CACHE_TTL_SECONDS);
}

export async function getImageLookupByThumbKey(thumbKey: string, expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return null;
  try {
    const raw = await redis.hget(lookupHashKey(IMAGE_LOOKUP_THUMBS_KEY, revision), thumbKey);
    return raw ? parseImageLookup(raw) : null;
  } catch {
    return null;
  }
}

export async function getImageLookupByObjectKey(objectKey: string, expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return null;
  try {
    const raw = await redis.hget(lookupHashKey(IMAGE_LOOKUP_MEDIA_KEY, revision), objectKey);
    return raw ? parseImageLookup(raw) : null;
  } catch {
    return null;
  }
}

export async function getImageLookupById(id: string, expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return null;
  try {
    const raw = await redis.hget(lookupHashKey(IMAGE_LOOKUP_ID_KEY, revision), id);
    return raw ? parseImageLookupById(raw) : null;
  } catch {
    return null;
  }
}

export async function setImageLookup(item: ImageLookupItem, expectedRevision?: string | null) {
  await setImageLookups([item], expectedRevision);
}

async function setImageLookups(items: ImageLookupItem[], expectedRevision?: string | null) {
  if (!items.length) return;
  const revision = await usableRevision(expectedRevision);
  if (!revision) return;
  try {
    const pipeline = redis.pipeline();
    const mediaFieldValues = items.flatMap((item) => [item.object_key, JSON.stringify(item)]);
    const thumbFieldValues = items.flatMap((item) => [item.thumb_key, JSON.stringify(item)]);
    pipeline.hsetex(
      lookupHashKey(IMAGE_LOOKUP_MEDIA_KEY, revision),
      "EX",
      IMAGE_LOOKUP_TTL_SECONDS,
      "FIELDS",
      items.length,
      ...mediaFieldValues
    );
    pipeline.hsetex(
      lookupHashKey(IMAGE_LOOKUP_THUMBS_KEY, revision),
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
    device: item.device,
    brightness: item.brightness,
    theme: item.theme,
    status: item.status,
    description: item.description ?? "",
    source: item.source ?? ""
  };
}

export async function setImageLookupById(item: CompleteImageLookupSource, expectedRevision?: string | null): Promise<ImageLookupByIdItem> {
  const lookup = imageLookupByIdItem(item);
  const revision = await usableRevision(expectedRevision);
  if (!revision) return lookup;
  try {
    await redis.hsetex(
      lookupHashKey(IMAGE_LOOKUP_ID_KEY, revision),
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

async function setImageLookupsById(items: ImageLookupByIdItem[], expectedRevision?: string | null) {
  if (!items.length) return;
  const revision = await usableRevision(expectedRevision);
  if (!revision) return;
  try {
    const fieldValues = items.flatMap((item) => [item.id, JSON.stringify(item)]);
    await redis.hsetex(
      lookupHashKey(IMAGE_LOOKUP_ID_KEY, revision),
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

export async function warmObjectLookups(items: readonly ImageObjectLookupSource[], expectedRevision?: string | null) {
  const objectLookups: ImageLookupItem[] = [];
  for (const item of items) {
    if (item.status === "ready") {
      objectLookups.push({
        object_key: item.object_key,
        thumb_key: thumbnailObjectKey(item.object_key),
        ext: item.ext,
        storage_slug: item.storage_slug,
        status: "ready"
      });
    }
  }
  await setImageLookups(objectLookups, expectedRevision);
}

async function warmImageIdLookups(items: readonly CompleteImageLookupSource[], expectedRevision?: string | null) {
  const idLookups = items.map(imageLookupByIdItem);
  await setImageLookupsById(idLookups, expectedRevision);
}

export async function warmCompleteImageLookups(items: readonly CompleteImageLookupSource[], expectedRevision?: string | null) {
  await Promise.all([
    warmObjectLookups(items, expectedRevision),
    warmImageIdLookups(items, expectedRevision)
  ]);
}

export type ImageLookupInvalidationEntry = {
  id?: string;
  object_key?: string;
  thumb_key?: string;
};

export async function invalidateImageCaches({
  lookupEntries = [],
  md5s = [],
  facets = true
}: {
  lookupEntries?: readonly ImageLookupInvalidationEntry[];
  md5s?: readonly string[];
  facets?: boolean;
} = {}) {
  // Capture the old scope, then advance before deleting any concrete keys. If
  // Redis is unavailable, localMutationEpoch keeps all reads cache-cold until a
  // later request successfully advances the shared revision.
  const previousRevision = await imageCacheRevision();
  const nextRevision = await advanceImageCacheRevision();

  const ids = [...new Set(lookupEntries.flatMap((item) => item.id ? [item.id] : []))];
  const objectKeys = [...new Set(lookupEntries.flatMap((item) => item.object_key ? [item.object_key] : []))];
  const thumbKeys = [...new Set(lookupEntries.flatMap((item) => item.thumb_key
    ? [item.thumb_key]
    : item.object_key ? [thumbnailObjectKey(item.object_key)] : []))];
  const uniqueMd5s = [...new Set(md5s.filter(Boolean))];

  try {
    const pipeline = redis.pipeline();
    const revisions = previousRevision ? [previousRevision] : [];
    for (const revision of revisions) {
      if (ids.length) pipeline.hdel(lookupHashKey(IMAGE_LOOKUP_ID_KEY, revision), ...ids);
      if (objectKeys.length) pipeline.hdel(lookupHashKey(IMAGE_LOOKUP_MEDIA_KEY, revision), ...objectKeys);
      if (thumbKeys.length) pipeline.hdel(lookupHashKey(IMAGE_LOOKUP_THUMBS_KEY, revision), ...thumbKeys);
      if (facets) pipeline.del(revisionKey(GALLERY_FACETS_KEY, revision));
      if (uniqueMd5s.length) {
        pipeline.del(...uniqueMd5s.map((md5) => revisionKey(MD5_CACHE_PREFIX, revision, md5)));
      }
    }

    await execRedisPipeline(pipeline);
  } catch {
    // Revision advancement is the correctness boundary. Concrete cleanup only
    // reclaims old fields sooner and may safely wait for TTL after a failure.
  }
  return nextRevision;
}

export async function getMd5Cache(md5: string, expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return null;
  return getRedisJson<unknown[]>(revisionKey(MD5_CACHE_PREFIX, revision, md5));
}

export async function setMd5Cache(md5: string, items: unknown[], expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return;
  await setRedisJson(revisionKey(MD5_CACHE_PREFIX, revision, md5), items);
}

export async function getGalleryFacetsCache<T>(expectedRevision?: string | null): Promise<T | null> {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return null;
  return getRedisJson<T>(revisionKey(GALLERY_FACETS_KEY, revision));
}

export async function setGalleryFacetsCache(value: unknown, expectedRevision?: string | null) {
  const revision = await usableRevision(expectedRevision);
  if (!revision) return;
  await setRedisJson(revisionKey(GALLERY_FACETS_KEY, revision), value);
}
