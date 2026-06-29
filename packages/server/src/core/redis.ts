// Redis cache layer. PostgreSQL stays the source of truth; reads here degrade
// to a database rebuild (or are skipped) when Redis is unavailable. Holds the
// random pool, gallery filter options, public-image lists and md5/lookup caches.
import { Redis } from "ioredis";
import { v7 as uuidv7 } from "uuid";
import { appConfig, indexKey } from "@imageshow/shared";
import { env } from "../config/env.js";
import { pool } from "./db.js";

export const redis = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  db: env.REDIS_DB,
  lazyConnect: true,
  maxRetriesPerRequest: 1
});

export const FOLDER_MAP_KEY = "imageshow:folder_map";
export const RANDOM_OBJECTS_KEY = "imageshow:random_objects";
export const GALLERY_OPTIONS_KEY = "imageshow:gallery_options";
export const MD5_CACHE_PREFIX = "imageshow:md5:";
export const PUBLIC_IMAGES_CACHE_PREFIX = "imageshow:public_images:";
// Generation counter for the public-image list cache. Invalidation bumps this in
// O(1) instead of SCAN-deleting every cached page; stale entries (now under an old
// generation in their key) are never read again and expire on their own TTL.
const PUBLIC_IMAGES_GEN_KEY = "imageshow:public_images_gen";
export const IMAGE_LOOKUP_OBJECTS_KEY = "imageshow:image_lookup:objects";
export const IMAGE_LOOKUP_THUMBS_KEY = "imageshow:image_lookup:thumbs";
// Small, rarely-changing lists read on hot public paths: the theme/tag vocabulary
// (slug + display name) backs term resolution on every filtered random/gallery
// request, and the assembled gallery filter facets back the gallery's filter UI.
const THEME_VOCAB_KEY = "imageshow:theme_vocab";
const TAG_VOCAB_KEY = "imageshow:tag_vocab";
const AUTHOR_VOCAB_KEY = "imageshow:author_vocab";
const GALLERY_FACETS_KEY = "imageshow:gallery_facets";
let redisConnectPromise: Promise<unknown> | null = null;

export type FolderMap = Record<string, Record<string, Record<string, number>>>;
export type GalleryFilterOptions = { devices: string[]; brightnesses: string[]; themes: string[] };
export type RandomPoolSnapshot = { folderMap: FolderMap; themes: string[] };
export type ImageLookupItem = { object_key: string; thumb_key: string; ext: string; slug?: string };
export type RandomObjectIndexItem = {
  id: string;
  object_key: string;
  ext: string;
  index_key: string;
  device: "pc" | "mb";
  brightness: "dark" | "light";
  theme: string;
  category_index: number;
  storage_slug: string;
  is_link: boolean;
};

export async function pingRedis() {
  if (redis.status === "wait" || redis.status === "end") {
    redisConnectPromise ??= redis.connect().finally(() => {
      redisConnectPromise = null;
    });
    await redisConnectPromise;
  }
  await redis.ping();
}

export async function rebuildFolderMap() {
  const result = await pool.query(
    `SELECT id, device, brightness, theme, category_key, category_index, object_key, ext, storage_slug, is_link
     FROM metadata
     WHERE status='ready'
     ORDER BY category_key, category_index`
  );
  const map: FolderMap = {};
  const objectEntries: string[] = [];
  for (const row of result.rows) {
    map[row.device] ??= {};
    map[row.device][row.brightness] ??= {};
    map[row.device][row.brightness][row.theme] ??= 0;
    map[row.device][row.brightness][row.theme] += 1;
    objectEntries.push(...serializeRandomObject(row));
  }
  const tmp = `${FOLDER_MAP_KEY}:tmp:${Date.now()}`;
  const tmpObjects = `${RANDOM_OBJECTS_KEY}:tmp:${Date.now()}`;
  await redis.set(tmp, JSON.stringify(map), "EX", appConfig.folderMapTtlSeconds);
  await redis.set(GALLERY_OPTIONS_KEY, JSON.stringify(optionsFromFolderMap(map)), "EX", appConfig.folderMapTtlSeconds);
  if (objectEntries.length) {
    await redis.hset(tmpObjects, ...objectEntries);
    await redis.expire(tmpObjects, appConfig.folderMapTtlSeconds);
  }
  await redis.rename(tmp, FOLDER_MAP_KEY);
  if (objectEntries.length) await redis.rename(tmpObjects, RANDOM_OBJECTS_KEY);
  else await redis.del(RANDOM_OBJECTS_KEY);
  await redis.expire(FOLDER_MAP_KEY, appConfig.folderMapTtlSeconds);
  if (objectEntries.length) await redis.expire(RANDOM_OBJECTS_KEY, appConfig.folderMapTtlSeconds);
  return map;
}

function optionsFromFolderMap(map: FolderMap): GalleryFilterOptions {
  const themes = new Set<string>();
  for (const device of Object.values(map)) {
    for (const brightness of Object.values(device)) {
      for (const theme of Object.keys(brightness)) themes.add(theme);
    }
  }
  return { devices: ["pc", "mb"], brightnesses: ["light", "dark"], themes: [...themes].sort() };
}

// Maps one ready metadata row to the [index_key, JSON] pair stored in the RANDOM_OBJECTS_KEY
// hash. Shared by the full rebuild and the per-category refresh so both write the identical
// shape; spread into an entries array (`objectEntries.push(...serializeRandomObject(row))`).
function serializeRandomObject(row: {
  id: string; object_key: string; ext: string; category_key: string; category_index: number | string;
  device: "pc" | "mb"; brightness: "dark" | "light"; theme: string; storage_slug: string; is_link: boolean;
}): [string, string] {
  const key = indexKey(row.category_key, Number(row.category_index));
  return [key, JSON.stringify({
    id: row.id,
    object_key: row.object_key,
    ext: row.ext,
    index_key: key,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    category_index: Number(row.category_index),
    storage_slug: row.storage_slug,
    is_link: row.is_link
  } satisfies RandomObjectIndexItem)];
}

export async function getFolderMap() {
  try {
    await pingRedis();
    const raw = await redis.get(FOLDER_MAP_KEY);
    if (raw) return JSON.parse(raw) as FolderMap;
    return await rebuildFolderMap();
  } catch {
    const error = new Error("Redis unavailable");
    error.name = "redis_unavailable";
    throw error;
  }
}

// Reads the folder map and gallery options in one round-trip so the random API
// can reuse the already-cached theme list (GalleryOptions.themes) instead of
// recomputing it from the folder map on every request. Throws redis_unavailable
// when Redis can't be reached so callers can fall back to PostgreSQL.
export async function getRandomPoolSnapshot(): Promise<RandomPoolSnapshot> {
  try {
    await pingRedis();
    const [mapRaw, optionsRaw] = await redis.mget(FOLDER_MAP_KEY, GALLERY_OPTIONS_KEY);
    if (mapRaw) {
      const folderMap = JSON.parse(mapRaw) as FolderMap;
      const themes = optionsRaw ? (JSON.parse(optionsRaw) as GalleryFilterOptions).themes : optionsFromFolderMap(folderMap).themes;
      return { folderMap, themes };
    }
    const folderMap = await rebuildFolderMap();
    return { folderMap, themes: optionsFromFolderMap(folderMap).themes };
  } catch {
    const error = new Error("Redis unavailable");
    error.name = "redis_unavailable";
    throw error;
  }
}

export async function getGalleryOptions() {
  try {
    await pingRedis();
    const raw = await redis.get(GALLERY_OPTIONS_KEY);
    if (raw) return JSON.parse(raw) as GalleryFilterOptions;
    return optionsFromFolderMap(await rebuildFolderMap());
  } catch {
    const result = await pool.query(
      "SELECT DISTINCT theme FROM metadata WHERE status='ready' ORDER BY theme"
    );
    return { devices: ["pc", "mb"], brightnesses: ["light", "dark"], themes: result.rows.map((row) => row.theme as string) };
  }
}

// Current generation for the public-image list cache. Callers capture it once at
// the start of a read and reuse it for both the lookup and the write-back, so a
// concurrent invalidation lands the about-to-be-written entry under the old
// generation (orphaned) rather than serving it as fresh.
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
    // PostgreSQL remains the source of truth when Redis is unavailable.
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
    const raw = await redis.hget(IMAGE_LOOKUP_OBJECTS_KEY, objectKey);
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
      pipeline.hset(IMAGE_LOOKUP_OBJECTS_KEY, item.object_key, value);
      pipeline.hset(IMAGE_LOOKUP_THUMBS_KEY, item.thumb_key, value);
    }
    pipeline.expire(IMAGE_LOOKUP_OBJECTS_KEY, appConfig.folderMapTtlSeconds);
    pipeline.expire(IMAGE_LOOKUP_THUMBS_KEY, appConfig.folderMapTtlSeconds);
    await pipeline.exec();
  } catch {
    // A missed metadata lookup cache only costs one future database read.
  }
}

export async function invalidateImageReadCaches() {
  try {
    await pingRedis();
    // Bump the list-cache generation (O(1)) so every cached page is logically
    // invalidated at once, drop the two object/thumb lookup hashes outright, and drop
    // the gallery facets (an image add/remove changes which themes/tags are in use).
    await Promise.all([
      redis.incr(PUBLIC_IMAGES_GEN_KEY),
      redis.del(IMAGE_LOOKUP_OBJECTS_KEY, IMAGE_LOOKUP_THUMBS_KEY, GALLERY_FACETS_KEY)
    ]);
  } catch {
    // Cache invalidation failure is non-fatal because write paths committed to PostgreSQL.
  }
}

export async function bumpFolder(categoryKey: string, delta: number) {
  try {
    await pingRedis();
    await refreshRandomCategory(categoryKey, delta);
  } catch {
    await pool.query(
      `INSERT INTO operation_log(id, type, status)
       SELECT $1, 'cache.rebuild', 'pending'
       WHERE NOT EXISTS (
         SELECT 1 FROM operation_log
         WHERE type='cache.rebuild' AND status IN ('pending', 'running')
       )`,
      [uuidv7()]
    ).catch(() => undefined);
  }
}

async function refreshRandomCategory(categoryKey: string, delta: number) {
  const rowsResult = await pool.query(
    `SELECT id, device, brightness, theme, category_key, category_index, object_key, ext, storage_slug, is_link
     FROM metadata
     WHERE category_key=$1 AND status='ready'
     ORDER BY category_index`,
    [categoryKey]
  );
  const raw = await redis.get(FOLDER_MAP_KEY);
  const map = raw ? JSON.parse(raw) as FolderMap : await rebuildFolderMap();
  const previous = findMapEntry(map, categoryKey);
  const category = parseCategoryKey(categoryKey);
  if (previous) delete map[previous.device]?.[previous.brightness]?.[previous.theme];
  const rows = rowsResult.rows;
  const randomPoolCategory = category && category.device !== "none" && category.brightness !== "none" && rows.length > 0;
  if (randomPoolCategory) {
    map[category.device] ??= {};
    map[category.device][category.brightness] ??= {};
    map[category.device][category.brightness][category.theme] = rows.length;
  }
  pruneEmptyMap(map);
  // When a category shrinks, delete the index-key entries past the new length
  // so the random pool never resolves to a removed position.
  const staleTailStart = randomPoolCategory && delta >= 0 ? rows.length + 1 : 1;
  const staleTailEnd = previous?.count ?? 0;
  if (staleTailEnd >= staleTailStart) {
    await redis.hdel(
      RANDOM_OBJECTS_KEY,
      ...Array.from({ length: staleTailEnd - staleTailStart + 1 }, (_, index) => indexKey(categoryKey, staleTailStart + index))
    );
  }
  const objectEntries: string[] = [];
  for (const row of rows) {
    if (!["pc", "mb"].includes(row.device) || !["dark", "light"].includes(row.brightness)) continue;
    objectEntries.push(...serializeRandomObject(row));
  }
  if (objectEntries.length) await redis.hset(RANDOM_OBJECTS_KEY, ...objectEntries);
  await redis.set(FOLDER_MAP_KEY, JSON.stringify(map), "EX", appConfig.folderMapTtlSeconds);
  await redis.set(GALLERY_OPTIONS_KEY, JSON.stringify(optionsFromFolderMap(map)), "EX", appConfig.folderMapTtlSeconds);
  await redis.expire(RANDOM_OBJECTS_KEY, appConfig.folderMapTtlSeconds);
}

function parseCategoryKey(key: string) {
  const match = /^(pc|mb|none)-(dark|light|none)-(.+)$/.exec(key);
  if (!match) return null;
  const [, device, brightness, theme] = match;
  return { device, brightness, theme } as { device: "pc" | "mb" | "none"; brightness: "dark" | "light" | "none"; theme: string };
}

function findMapEntry(map: FolderMap, key: string) {
  for (const [device, deviceMap] of Object.entries(map)) {
    for (const [brightness, brightnessMap] of Object.entries(deviceMap)) {
      for (const [theme, count] of Object.entries(brightnessMap)) {
        if (`${device}-${brightness}-${theme}` === key) return { device, brightness, theme, count: Number(count) };
      }
    }
  }
  return null;
}

function pruneEmptyMap(map: FolderMap) {
  for (const [device, deviceMap] of Object.entries(map)) {
    for (const [brightness, brightnessMap] of Object.entries(deviceMap)) {
      for (const [theme, count] of Object.entries(brightnessMap)) {
        if (!Number.isFinite(Number(count)) || Number(count) <= 0) delete brightnessMap[theme];
      }
      if (!Object.keys(brightnessMap).length) delete deviceMap[brightness];
    }
    if (!Object.keys(deviceMap).length) delete map[device];
  }
}

export async function getRandomObject(index: string) {
  try {
    await pingRedis();
    const raw = await redis.hget(RANDOM_OBJECTS_KEY, index);
    return raw ? JSON.parse(raw) as RandomObjectIndexItem : null;
  } catch {
    const error = new Error("Redis unavailable");
    error.name = "redis_unavailable";
    throw error;
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
    // Duplicate checks can safely fall back to PostgreSQL on the next request.
  }
}

export async function invalidateMd5Cache(md5: string) {
  if (!md5) return;
  try {
    await pingRedis();
    await redis.del(`${MD5_CACHE_PREFIX}${md5}`);
  } catch {
    // Cache invalidation failure is non-fatal because PostgreSQL remains source of truth.
  }
}

export async function invalidateMd5Caches(md5s: string[]) {
  const keys = [...new Set(md5s.filter(Boolean))].map((md5) => `${MD5_CACHE_PREFIX}${md5}`);
  if (!keys.length) return;
  try {
    await pingRedis();
    await redis.del(...keys);
  } catch {
    // PostgreSQL remains authoritative; stale cache entries expire naturally.
  }
}

export type VocabEntry = { slug: string; display_name: string };

async function loadVocab(table: "theme" | "tag"): Promise<VocabEntry[]> {
  return (await pool.query(`SELECT slug, display_name FROM ${table} ORDER BY slug`)).rows as VocabEntry[];
}

// Cache-aside read of a small vocabulary list: serve from Redis, else load from PostgreSQL
// and backfill the cache; a Redis outage reads straight from PostgreSQL. A freshly
// auto-created slug (empty display name, made by ensureTheme / setImageTags) may be missing
// until the TTL lapses — harmless, since term resolution falls back to slug-identity for
// anything absent here. Shared by the theme / tag / author vocab getters below.
async function cachedVocab<T>(key: string, load: () => Promise<T>): Promise<T> {
  try {
    await pingRedis();
    const raw = await redis.get(key);
    if (raw) return JSON.parse(raw) as T;
    const rows = await load();
    await redis.set(key, JSON.stringify(rows), "EX", appConfig.folderMapTtlSeconds);
    return rows;
  } catch {
    return load();
  }
}

// The theme / tag vocabulary (slug + display name), read on every theme/tag term resolution.
export function getThemeVocab(): Promise<VocabEntry[]> {
  return cachedVocab(THEME_VOCAB_KEY, () => loadVocab("theme"));
}

export function getTagVocab(): Promise<VocabEntry[]> {
  return cachedVocab(TAG_VOCAB_KEY, () => loadVocab("tag"));
}

// The author vocabulary carries an extra `link` beyond slug + display name, since the
// image detail view renders the author as a link.
export type AuthorVocabEntry = { slug: string; display_name: string; link: string };

async function loadAuthorVocab(): Promise<AuthorVocabEntry[]> {
  return (await pool.query("SELECT slug, display_name, link FROM author ORDER BY slug")).rows as AuthorVocabEntry[];
}

export function getAuthorVocab(): Promise<AuthorVocabEntry[]> {
  return cachedVocab(AUTHOR_VOCAB_KEY, loadAuthorVocab);
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
    // PostgreSQL remains the source of truth when Redis is unavailable.
  }
}

// Called by the theme / tag / author admin mutations. Drops the changed vocabulary plus
// the gallery facets (which embed display names + the in-use slug set) so a rename/create/
// delete reflects immediately rather than waiting out the TTL.
async function invalidateVocab(vocabKey: string) {
  try {
    await pingRedis();
    await redis.del(vocabKey, GALLERY_FACETS_KEY);
  } catch {
    // Stale vocabulary expires on its own TTL.
  }
}

export const invalidateThemeVocab = () => invalidateVocab(THEME_VOCAB_KEY);
export const invalidateTagVocab = () => invalidateVocab(TAG_VOCAB_KEY);
export const invalidateAuthorVocab = () => invalidateVocab(AUTHOR_VOCAB_KEY);
