import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { pingRedis, redis } from "./redis-client.ts";
import {
  GALLERY_FILTER_OPTIONS_KEY,
  RANDOM_CURRENT_KEY,
  getRandomPoolSnapshot,
  randomCountsKey,
  randomItemKey,
  randomSnapshotKey,
  randomThemesKey,
  type RandomCategoryCounts,
  type GalleryFilterOptions
} from "../random/random-cache.ts";
import {
  ADMIN_OVERVIEW_CACHE_PREFIX,
  IMAGE_LOOKUP_ID_KEY,
  IMAGE_LOOKUP_MEDIA_KEY,
  IMAGE_LOOKUP_THUMBS_KEY,
  MD5_CACHE_PREFIX,
  ORIGINAL_DIRECT_CACHE_PREFIX,
  PUBLIC_IMAGES_CACHE_PREFIX
} from "../images/image-cache.ts";

const SESSION_KEY_PREFIX = "imageshow:session:";
const LOGIN_FAIL_KEY_PREFIX = "imageshow:login_fail:";

export async function inspectRedisState() {
  await pingRedis();
  const snapshot = await getRandomPoolSnapshot();
  const itemKey = randomItemKey(snapshot.generation);
  const snapshotKey = randomSnapshotKey(snapshot.generation);
  const countsKey = randomCountsKey(snapshot.generation);
  const themesKey = randomThemesKey(snapshot.generation);
  const [galleryRaw, dbsize, memoryInfo, keyspaceInfo, randomObjectCount] = await Promise.all([
    redis.get(GALLERY_FILTER_OPTIONS_KEY),
    redis.dbsize(),
    redis.info("memory").catch(() => ""),
    redis.info("keyspace").catch(() => ""),
    redis.hlen(itemKey).catch(() => 0)
  ]);
  const galleryFilterOptions = parseJson<GalleryFilterOptions>(galleryRaw, { devices: [], brightnesses: [], themes: [] });
  const [coreKeys, prefixCounts, randomItemIds] = await Promise.all([
    Promise.all([
      RANDOM_CURRENT_KEY,
      snapshotKey,
      itemKey,
      countsKey,
      themesKey,
      GALLERY_FILTER_OPTIONS_KEY,
      IMAGE_LOOKUP_MEDIA_KEY,
      IMAGE_LOOKUP_THUMBS_KEY,
      IMAGE_LOOKUP_ID_KEY
    ].map((key) => redisKeySummary(key))),
    redisPrefixCounts(),
    sampleHashKeys(itemKey, 12)
  ]);
  const categorySummary = summarizeCategoryCounts(snapshot.categoryCounts);
  const galleryFilterSummary = {
    devices: galleryFilterOptions.devices,
    brightnesses: galleryFilterOptions.brightnesses,
    themes: galleryFilterOptions.themes,
    theme_count: galleryFilterOptions.themes.length
  };
  const issues = redisStateIssues(
    categorySummary.total_images,
    randomObjectCount,
    coreKeys,
    galleryFilterOptions,
    categorySummary.themes,
    [RANDOM_CURRENT_KEY, snapshotKey, itemKey, countsKey]
  );
  return {
    connection: {
      status: redis.status,
      configured_db: getRuntimeConfig().redis.db,
      dbsize,
      memory: parseRedisInfo(memoryInfo),
      keyspace: parseRedisInfo(keyspaceInfo)
    },
    prefix_counts: prefixCounts,
    core_keys: coreKeys,
    random_generation: snapshot.generation,
    random_category_summary: categorySummary,
    random_category_counts: snapshot.categoryCounts,
    random_items: {
      key: itemKey,
      count: randomObjectCount,
      sample_ids: randomItemIds
    },
    gallery_filter_options: galleryFilterSummary,
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
  const [all, random, md5, publicImages, originalDirect, adminOverview, sessions, loginFailures, temporary] = await Promise.all([
    scanCount("imageshow:*"),
    scanCount("imageshow:random:*"),
    scanCount(`${MD5_CACHE_PREFIX}*`),
    scanCount(`${PUBLIC_IMAGES_CACHE_PREFIX}*`),
    scanCount(`${ORIGINAL_DIRECT_CACHE_PREFIX}*`),
    scanCount(`${ADMIN_OVERVIEW_CACHE_PREFIX}*`),
    scanCount(`${SESSION_KEY_PREFIX}*`),
    scanCount(`${LOGIN_FAIL_KEY_PREFIX}*`),
    scanCount("imageshow:*:tmp:*")
  ]);
  return {
    imageshow_total: all,
    random_pool: random,
    md5_cache: md5,
    public_images_cache: publicImages,
    original_direct_cache: originalDirect,
    admin_overview_cache: adminOverview,
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

function summarizeCategoryCounts(counts: RandomCategoryCounts) {
  const groupTotals: Record<string, number> = {};
  const themes = new Set<string>();
  let totalImages = 0;
  let categoryCount = 0;
  for (const [device, deviceMap] of Object.entries(counts)) {
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
  categoryTotal: number,
  randomObjectCount: number,
  coreKeys: Awaited<ReturnType<typeof redisKeySummary>>[],
  galleryFilterOptions: GalleryFilterOptions,
  categoryThemes: string[],
  requiredKeys: string[]
) {
  const issues: string[] = [];
  const required = new Set(requiredKeys);
  for (const summary of coreKeys) {
    if (required.has(summary.key) && !summary.exists) issues.push(`${summary.key} 不存在`);
  }
  if (categoryTotal !== randomObjectCount) {
    issues.push(
      `random:item 数量 ${randomObjectCount} 与随机分类计数总数 ${categoryTotal} 不一致`
    );
  }
  const optionThemes = [...galleryFilterOptions.themes].sort();
  if (JSON.stringify(optionThemes) !== JSON.stringify(categoryThemes)) {
    issues.push("gallery_filter_options 主题列表与随机分类计数不一致");
  }
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
