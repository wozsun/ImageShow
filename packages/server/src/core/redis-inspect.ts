import { env } from "../config/env.js";
import {
  FOLDER_MAP_KEY,
  GALLERY_OPTIONS_KEY,
  IMAGE_LOOKUP_OBJECTS_KEY,
  IMAGE_LOOKUP_THUMBS_KEY,
  MD5_CACHE_PREFIX,
  PUBLIC_IMAGES_CACHE_PREFIX,
  RANDOM_OBJECTS_KEY,
  pingRedis,
  redis,
  type FolderMap,
  type GalleryFilterOptions
} from "./redis.js";

const SESSION_KEY_PREFIX = "imageshow:session:";
const LOGIN_FAIL_KEY_PREFIX = "imageshow:login_fail:";

export async function inspectRedisState() {
  await pingRedis();
  const [folderRaw, galleryRaw, dbsize, memoryInfo, keyspaceInfo, randomObjectCount] = await Promise.all([
    redis.get(FOLDER_MAP_KEY),
    redis.get(GALLERY_OPTIONS_KEY),
    redis.dbsize(),
    redis.info("memory").catch(() => ""),
    redis.info("keyspace").catch(() => ""),
    redis.hlen(RANDOM_OBJECTS_KEY).catch(() => 0)
  ]);
  const folderMap = parseJson<FolderMap>(folderRaw, {});
  const galleryOptions = parseJson<GalleryFilterOptions>(galleryRaw, { devices: [], brightnesses: [], themes: [] });
  const [coreKeys, prefixCounts, randomIndexKeys] = await Promise.all([
    Promise.all([FOLDER_MAP_KEY, RANDOM_OBJECTS_KEY, GALLERY_OPTIONS_KEY, IMAGE_LOOKUP_OBJECTS_KEY, IMAGE_LOOKUP_THUMBS_KEY].map((key) => redisKeySummary(key))),
    redisPrefixCounts(),
    sampleHashKeys(RANDOM_OBJECTS_KEY, 12)
  ]);
  const folderSummary = summarizeFolderMap(folderMap);
  const gallerySummary = {
    devices: galleryOptions.devices,
    brightnesses: galleryOptions.brightnesses,
    themes: galleryOptions.themes,
    theme_count: galleryOptions.themes.length
  };
  const issues = redisStateIssues(folderSummary.total_images, randomObjectCount, coreKeys, galleryOptions, folderSummary.themes);
  return {
    connection: {
      status: redis.status,
      configured_db: env.REDIS_DB,
      dbsize,
      memory: parseRedisInfo(memoryInfo),
      keyspace: parseRedisInfo(keyspaceInfo)
    },
    prefix_counts: prefixCounts,
    core_keys: coreKeys,
    folder_summary: folderSummary,
    folder_map: folderMap,
    random_objects: {
      key: RANDOM_OBJECTS_KEY,
      count: randomObjectCount,
      sample_index_keys: randomIndexKeys
    },
    gallery_options: gallerySummary,
    issues
  };
}

function parseJson<T>(raw: string | null, fallback: T) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function redisKeySummary(key: string) {
  const [type, ttl, memoryUsage] = await Promise.all([
    redis.type(key),
    redis.ttl(key),
    redis.call("MEMORY", "USAGE", key).catch(() => null)
  ]);
  return {
    key,
    exists: type !== "none",
    type,
    ttl_seconds: ttl,
    memory_bytes: typeof memoryUsage === "number" ? memoryUsage : null,
    length: await redisKeyLength(key, type)
  };
}

async function redisKeyLength(key: string, type: string) {
  if (type === "string") return redis.strlen(key);
  if (type === "hash") return redis.hlen(key);
  if (type === "list") return redis.llen(key);
  if (type === "set") return redis.scard(key);
  if (type === "zset") return redis.zcard(key);
  return 0;
}

async function redisPrefixCounts() {
  const [all, md5, publicImages, sessions, loginFailures, temporary] = await Promise.all([
    scanCount("imageshow:*"),
    scanCount(`${MD5_CACHE_PREFIX}*`),
    scanCount(`${PUBLIC_IMAGES_CACHE_PREFIX}*`),
    scanCount(`${SESSION_KEY_PREFIX}*`),
    scanCount(`${LOGIN_FAIL_KEY_PREFIX}*`),
    scanCount("imageshow:*:tmp:*")
  ]);
  return {
    imageshow_total: all,
    md5_cache: md5,
    public_images_cache: publicImages,
    sessions,
    login_failures: loginFailures,
    temporary
  };
}

async function scanCount(pattern: string) {
  let cursor = "0";
  let count = 0;
  do {
    const result = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = result[0];
    count += result[1].length;
  } while (cursor !== "0");
  return count;
}

async function sampleHashKeys(key: string, limit: number) {
  const type = await redis.type(key);
  if (type !== "hash") return [];
  const [, entries] = await redis.hscan(key, "0", "COUNT", Math.max(1, limit * 2));
  return entries.filter((_, index) => index % 2 === 0).slice(0, limit);
}

function summarizeFolderMap(map: FolderMap) {
  const groupTotals: Record<string, number> = {};
  const themes = new Set<string>();
  let totalImages = 0;
  let categoryCount = 0;
  for (const [device, deviceMap] of Object.entries(map)) {
    for (const [brightness, brightnessMap] of Object.entries(deviceMap)) {
      const groupKey = `${device}-${brightness}`;
      groupTotals[groupKey] = 0;
      for (const [theme, countValue] of Object.entries(brightnessMap)) {
        const count = Number(countValue);
        if (!Number.isFinite(count) || count <= 0) continue;
        themes.add(theme);
        categoryCount += 1;
        totalImages += count;
        groupTotals[groupKey] += count;
      }
    }
  }
  return {
    total_images: totalImages,
    category_count: categoryCount,
    group_totals: groupTotals,
    themes: [...themes].sort()
  };
}

function redisStateIssues(
  folderTotal: number,
  randomObjectCount: number,
  coreKeys: Awaited<ReturnType<typeof redisKeySummary>>[],
  galleryOptions: GalleryFilterOptions,
  folderThemes: string[]
) {
  const issues: string[] = [];
  const requiredKeys = new Set([FOLDER_MAP_KEY, RANDOM_OBJECTS_KEY, GALLERY_OPTIONS_KEY]);
  for (const summary of coreKeys) {
    if (requiredKeys.has(summary.key) && !summary.exists) issues.push(`${summary.key} 不存在`);
  }
  if (folderTotal !== randomObjectCount) issues.push(`random_objects 数量 ${randomObjectCount} 与 folder_map 总数 ${folderTotal} 不一致`);
  const optionThemes = [...galleryOptions.themes].sort();
  if (JSON.stringify(optionThemes) !== JSON.stringify(folderThemes)) issues.push("gallery_options 主题列表与 folder_map 不一致");
  return issues;
}

function parseRedisInfo(info: string) {
  const picked = new Set([
    "used_memory_human",
    "used_memory_peak_human",
    "maxmemory_human",
    "mem_fragmentation_ratio",
    "db0"
  ]);
  const result: Record<string, string> = {};
  for (const rawLine of info.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes(":")) continue;
    const [key, value] = line.split(":", 2);
    if (picked.has(key)) result[key] = value;
  }
  return result;
}
