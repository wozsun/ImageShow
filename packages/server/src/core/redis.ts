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

const PUBLIC_IMAGES_GEN_KEY = "imageshow:public_images_gen";
export const IMAGE_LOOKUP_OBJECTS_KEY = "imageshow:image_lookup:objects";
export const IMAGE_LOOKUP_THUMBS_KEY = "imageshow:image_lookup:thumbs";

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
    // 写缓存失败只会多一次后续数据库读取。
  }
}

export async function invalidateImageReadCaches() {
  try {
    await pingRedis();

    await Promise.all([
      redis.incr(PUBLIC_IMAGES_GEN_KEY),
      redis.del(IMAGE_LOOKUP_OBJECTS_KEY, IMAGE_LOOKUP_THUMBS_KEY, GALLERY_FACETS_KEY)
    ]);
  } catch {
    // 写入路径已提交到 PostgreSQL，缓存失效失败不影响正确性。
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

export type VocabEntry = { slug: string; display_name: string };

async function loadVocab(table: "theme" | "tag"): Promise<VocabEntry[]> {
  return (await pool.query(`SELECT slug, display_name FROM ${table} ORDER BY slug`)).rows as VocabEntry[];
}

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

export function getThemeVocab(): Promise<VocabEntry[]> {
  return cachedVocab(THEME_VOCAB_KEY, () => loadVocab("theme"));
}

export function getTagVocab(): Promise<VocabEntry[]> {
  return cachedVocab(TAG_VOCAB_KEY, () => loadVocab("tag"));
}

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
    // Redis 不可用时以 PostgreSQL 为准。
  }
}

async function invalidateVocab(vocabKey: string) {
  try {
    await pingRedis();
    await redis.del(vocabKey, GALLERY_FACETS_KEY);
  } catch {
    // 旧词表会按 TTL 自然过期。
  }
}

export const invalidateThemeVocab = () => invalidateVocab(THEME_VOCAB_KEY);
export const invalidateTagVocab = () => invalidateVocab(TAG_VOCAB_KEY);
export const invalidateAuthorVocab = () => invalidateVocab(AUTHOR_VOCAB_KEY);
