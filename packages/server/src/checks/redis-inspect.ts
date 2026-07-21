import { deploymentConfig } from "../config/deployment-config.ts";
import {
  GALLERY_FILTER_OPTIONS_KEY,
  RANDOM_CACHE_NAMESPACE,
  RANDOM_CURRENT_KEY,
  RANDOM_MUTATION_REVISION_KEY,
  RANDOM_REBUILD_COMPLETED_KEY,
  randomItemKey,
  randomManifestKey,
  randomSnapshotKey,
  type GalleryFilterOptions,
  type RandomCategoryCounts
} from "../random/random-cache.ts";
import {
  ADMIN_OVERVIEW_CACHE_PREFIX,
  IMAGE_CACHE_REVISION_KEY,
  IMAGE_LOOKUP_ID_KEY,
  IMAGE_LOOKUP_MEDIA_KEY,
  IMAGE_LOOKUP_THUMBS_KEY,
  IMAGE_LOOKUP_TTL_SECONDS,
  MD5_CACHE_PREFIX,
  ORIGINAL_DIRECT_CACHE_PREFIX,
  PUBLIC_IMAGES_CACHE_PREFIX
} from "../images/image-cache.ts";
import { pingRedis, redis } from "../core/redis-client.ts";

const SESSION_KEY_PREFIX = "imageshow:session:";
const LOGIN_FAIL_KEY_PREFIX = "imageshow:login_fail:";
const RANDOM_GENERATION_PREFIX = `${RANDOM_CACHE_NAMESPACE}:`;
const RANDOM_GLOBAL_PARTS = new Set([
  "current",
  "version",
  "update_lock",
  "rebuild_lock",
  "rebuild_completed"
]);
const RANDOM_GENERATION_TTL_SAMPLE_SIZE = 25;
const generationTtlSampleOffsets = new Map<string, number>();

type RandomPoolSnapshotValue = {
  categoryCounts: RandomCategoryCounts;
};

export async function inspectRedisState() {
  await pingRedis();
  const [generation, requestedRaw, completedRaw, imageRevisionRaw] = await Promise.all([
    redis.get(RANDOM_CURRENT_KEY),
    redis.get(RANDOM_MUTATION_REVISION_KEY).catch(() => null),
    redis.get(RANDOM_REBUILD_COMPLETED_KEY).catch(() => null),
    redis.get(IMAGE_CACHE_REVISION_KEY).catch(() => null)
  ]);
  const imageRevision = imageRevisionRaw ?? "0";
  const imageLookupKeys = {
    media: `${IMAGE_LOOKUP_MEDIA_KEY}:${imageRevision}`,
    thumbs: `${IMAGE_LOOKUP_THUMBS_KEY}:${imageRevision}`,
    id: `${IMAGE_LOOKUP_ID_KEY}:${imageRevision}`
  };
  const snapshotKey = generation ? randomSnapshotKey(generation) : "";
  const itemKey = generation ? randomItemKey(generation) : "";
  const [snapshotRaw, galleryRaw, dbsize, serverInfo, memoryInfo, keyspaceInfo, scanned] = await Promise.all([
    snapshotKey ? redis.get(snapshotKey).catch(() => null) : Promise.resolve(null),
    redis.get(GALLERY_FILTER_OPTIONS_KEY).catch(() => null),
    redis.dbsize().catch(() => 0),
    redis.info("server").catch(() => ""),
    redis.info("memory").catch(() => ""),
    redis.info("keyspace").catch(() => ""),
    scanImageshowKeys().catch(() => ({ counts: emptyPrefixCounts(), generations: new Map<string, string[]>() }))
  ]);

  const snapshot = parseSnapshot(snapshotRaw);
  const galleryFilterOptions = parseJson<GalleryFilterOptions>(galleryRaw, {
    devices: [],
    brightnesses: [],
    themes: []
  });
  const coreKeyNames = [
    RANDOM_CURRENT_KEY,
    ...(generation ? [snapshotKey, itemKey, randomManifestKey(generation)] : []),
    GALLERY_FILTER_OPTIONS_KEY,
    IMAGE_CACHE_REVISION_KEY,
    imageLookupKeys.media,
    imageLookupKeys.thumbs,
    imageLookupKeys.id
  ];
  const [coreKeys, randomItemIds, hsetexSupported, lookupFieldTtls, generationInspection] = await Promise.all([
    Promise.all(coreKeyNames.map((key) => redisKeySummary(key).catch(() => missingKeySummary(key)))),
    itemKey ? sampleHashFields(itemKey, 12).catch(() => []) : Promise.resolve([]),
    inspectHsetexCapability(),
    inspectLookupFieldTtls(Object.values(imageLookupKeys)),
    inspectGenerations(generation, scanned.generations)
  ]);
  const randomObjectCount = itemKey
    ? await redis.hlen(itemKey).catch(() => 0)
    : 0;
  const categorySummary = summarizeCategoryCounts(snapshot?.categoryCounts ?? {});
  const galleryFilterSummary = {
    devices: galleryFilterOptions.devices,
    brightnesses: galleryFilterOptions.brightnesses,
    themes: galleryFilterOptions.themes,
    theme_count: galleryFilterOptions.themes.length
  };
  const issues = redisStateIssues({
    generation,
    snapshot,
    categoryTotal: categorySummary.total_images,
    randomObjectCount,
    coreKeys,
    galleryFilterOptions,
    categoryThemes: categorySummary.themes,
    generationInspection,
    hsetexSupported,
    requestedRevision: redisRevision(requestedRaw),
    completedRevision: redisRevision(completedRaw)
  });

  return {
    connection: {
      status: redis.status,
      configured_db: deploymentConfig.redis.db,
      redis_version: parseRedisInfo(serverInfo, new Set(["redis_version"])).redis_version ?? "unknown",
      hsetex_supported: hsetexSupported,
      dbsize,
      memory: parseRedisInfo(memoryInfo),
      keyspace: parseRedisInfo(keyspaceInfo)
    },
    prefix_counts: scanned.counts,
    core_keys: coreKeys,
    lookup_fields: {
      revision: imageRevision,
      configured_ttl_seconds: IMAGE_LOOKUP_TTL_SECONDS,
      media: keyLength(coreKeys, imageLookupKeys.media),
      thumbs: keyLength(coreKeys, imageLookupKeys.thumbs),
      id: keyLength(coreKeys, imageLookupKeys.id),
      ttl_samples: lookupFieldTtls
    },
    random_generation: generation ?? "",
    random_revisions: {
      mutation: redisRevision(requestedRaw),
      completed: redisRevision(completedRaw)
    },
    random_generations: generationInspection,
    random_category_summary: categorySummary,
    random_category_counts: snapshot?.categoryCounts ?? {},
    random_items: {
      key: itemKey,
      count: randomObjectCount,
      sample_ids: randomItemIds
    },
    gallery_filter_options: galleryFilterSummary,
    issues
  };
}

function parseSnapshot(raw: string | null): RandomPoolSnapshotValue | null {
  const parsed = parseJson<Partial<RandomPoolSnapshotValue> | null>(raw, null);
  if (!parsed?.categoryCounts) return null;
  return parsed as RandomPoolSnapshotValue;
}

function parseJson<T>(raw: string | null, fallback: T) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function inspectHsetexCapability() {
  const result = await redis.call("COMMAND", "INFO", "HSETEX").catch(() => null);
  return Array.isArray(result) && result.length > 0 && result[0] !== null;
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

function missingKeySummary(key: string) {
  return {
    key,
    exists: false,
    type: "unknown",
    ttl_seconds: -2,
    memory_bytes: null,
    length: 0
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

function emptyPrefixCounts() {
  return {
    imageshow_total: 0,
    random_pool: 0,
    md5_cache: 0,
    public_images_cache: 0,
    original_direct_cache: 0,
    admin_overview_cache: 0,
    sessions: 0,
    login_failures: 0,
    temporary: 0
  };
}

async function scanImageshowKeys() {
  const counts = emptyPrefixCounts();
  const generations = new Map<string, string[]>();
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "imageshow:*", "COUNT", 500);
    cursor = nextCursor;
    for (const key of keys) {
      counts.imageshow_total += 1;
      if (key.startsWith(RANDOM_GENERATION_PREFIX)) {
        counts.random_pool += 1;
        const generation = randomGenerationFromKey(key);
        if (generation) {
          const generationKeys = generations.get(generation);
          if (generationKeys) generationKeys.push(key);
          else generations.set(generation, [key]);
        }
      }
      if (key.startsWith(MD5_CACHE_PREFIX)) counts.md5_cache += 1;
      if (key.startsWith(PUBLIC_IMAGES_CACHE_PREFIX)) counts.public_images_cache += 1;
      if (key.startsWith(ORIGINAL_DIRECT_CACHE_PREFIX)) counts.original_direct_cache += 1;
      if (key.startsWith(ADMIN_OVERVIEW_CACHE_PREFIX)) counts.admin_overview_cache += 1;
      if (key.startsWith(SESSION_KEY_PREFIX)) counts.sessions += 1;
      if (key.startsWith(LOGIN_FAIL_KEY_PREFIX)) counts.login_failures += 1;
      if (key.includes(":tmp:")) counts.temporary += 1;
    }
  } while (cursor !== "0");
  return { counts, generations };
}

function randomGenerationFromKey(key: string) {
  if (!key.startsWith(RANDOM_GENERATION_PREFIX)) return "";
  const generation = key.slice(RANDOM_GENERATION_PREFIX.length).split(":", 1)[0];
  return RANDOM_GLOBAL_PARTS.has(generation) ? "" : generation;
}

async function sampleHashFields(key: string, limit: number): Promise<string[]> {
  if (await redis.type(key) !== "hash") return [];
  const raw = await redis.hrandfield(key, Math.max(1, limit));
  if (Array.isArray(raw)) return raw.filter((field): field is string => typeof field === "string").slice(0, limit);
  return typeof raw === "string" ? [raw] : [];
}

async function inspectLookupFieldTtls(keys: string[]) {
  const result: Record<string, Array<{ field: string; ttl_seconds: number | null }>> = {};
  for (const key of keys) {
    const fields = await sampleHashFields(key, 5).catch(() => []);
    if (!fields.length) {
      result[key] = [];
      continue;
    }
    const rawTtls = await redis.call("HTTL", key, "FIELDS", fields.length, ...fields).catch(() => []);
    const ttls = Array.isArray(rawTtls) ? rawTtls : [];
    result[key] = fields.map((field, index) => ({
      field,
      ttl_seconds: typeof ttls[index] === "number" ? ttls[index] : null
    }));
  }
  return result;
}

async function inspectGenerations(current: string | null, generations: Map<string, string[]>) {
  const result: Array<{
    generation: string;
    current: boolean;
    key_count: number;
    manifest_exists: boolean;
    ttl_seconds: number;
    ttl_sample_size: number;
    ttl_sample_offset: number;
    orphaned: boolean;
  }> = [];
  for (const sampledGeneration of generationTtlSampleOffsets.keys()) {
    if (!generations.has(sampledGeneration)) generationTtlSampleOffsets.delete(sampledGeneration);
  }
  for (const [generation, keys] of generations) {
    const manifest = randomManifestKey(generation);
    const ttlSample = rotatingGenerationTtlSample(generation, keys);
    const [manifestExists, ttls] = await Promise.all([
      redis.exists(manifest).catch(() => 0),
      Promise.all(ttlSample.keys.map((key) => redis.ttl(key).catch(() => -2)))
    ]);
    const isCurrent = generation === current;
    const positiveTtls = ttls.filter((ttl) => ttl > 0);
    const ttl = ttls.includes(-1)
      ? -1
      : positiveTtls.length ? Math.min(...positiveTtls) : -2;
    result.push({
      generation,
      current: isCurrent,
      key_count: keys.length,
      manifest_exists: Boolean(manifestExists),
      ttl_seconds: ttl,
      ttl_sample_size: ttlSample.keys.length,
      ttl_sample_offset: ttlSample.offset,
      orphaned: !isCurrent && (!manifestExists || ttl < 0)
    });
  }
  return result.sort((left, right) => Number(right.current) - Number(left.current)
    || right.generation.localeCompare(left.generation));
}

function rotatingGenerationTtlSample(generation: string, keys: string[]) {
  if (!keys.length) return { keys: [], offset: 0 };
  const requestedOffset = generationTtlSampleOffsets.get(generation) ?? 0;
  const offset = requestedOffset % keys.length;
  const sampleSize = Math.min(RANDOM_GENERATION_TTL_SAMPLE_SIZE, keys.length);
  const sample = Array.from(
    { length: sampleSize },
    (_, index) => keys[(offset + index) % keys.length],
  );
  generationTtlSampleOffsets.set(
    generation,
    (offset + sampleSize) % keys.length,
  );
  return { keys: sample, offset };
}

function keyLength(
  summaries: Awaited<ReturnType<typeof redisKeySummary>>[],
  key: string
) {
  return summaries.find((summary) => summary.key === key)?.length ?? 0;
}

function redisRevision(raw: string | null) {
  const revision = Number(raw ?? "0");
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
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

function redisStateIssues(input: {
  generation: string | null;
  snapshot: RandomPoolSnapshotValue | null;
  categoryTotal: number;
  randomObjectCount: number;
  coreKeys: Awaited<ReturnType<typeof redisKeySummary>>[];
  galleryFilterOptions: GalleryFilterOptions;
  categoryThemes: string[];
  generationInspection: Awaited<ReturnType<typeof inspectGenerations>>;
  hsetexSupported: boolean;
  requestedRevision: number;
  completedRevision: number;
}) {
  const issues: string[] = [];
  if (!input.generation) issues.push(`${RANDOM_CURRENT_KEY} 不存在`);
  if (input.generation && !input.snapshot) issues.push(`当前随机池 snapshot 不存在或无法解析`);
  if (input.generation) {
    const manifest = randomManifestKey(input.generation);
    if (!input.coreKeys.find((summary) => summary.key === manifest)?.exists) {
      issues.push(`当前随机池 manifest ${manifest} 不存在`);
    }
  }
  for (const summary of input.coreKeys) {
    if ([RANDOM_CURRENT_KEY, GALLERY_FILTER_OPTIONS_KEY].includes(summary.key) && !summary.exists) {
      issues.push(`${summary.key} 不存在`);
    }
  }
  if (input.snapshot && input.categoryTotal !== input.randomObjectCount) {
    issues.push(`random:item 数量 ${input.randomObjectCount} 与随机分类计数总数 ${input.categoryTotal} 不一致`);
  }
  const optionThemes = [...input.galleryFilterOptions.themes].sort();
  if (input.snapshot && JSON.stringify(optionThemes) !== JSON.stringify(input.categoryThemes)) {
    issues.push("gallery_filter_options 主题列表与随机分类计数不一致");
  }
  if (!input.hsetexSupported) issues.push("当前 Redis 不支持 HSETEX");
  if (input.completedRevision < input.requestedRevision) {
    issues.push(`随机池 completed revision ${input.completedRevision} 落后于 mutation revision ${input.requestedRevision}`);
  }
  for (const generation of input.generationInspection) {
    if (generation.orphaned) issues.push(`发现孤立 generation ${generation.generation}`);
  }
  return issues;
}

function parseRedisInfo(
  info: string,
  picked = new Set([
    "used_memory_human",
    "used_memory_peak_human",
    "maxmemory_human",
    "mem_fragmentation_ratio",
    "db0"
  ])
) {
  const result: Record<string, string> = {};
  for (const rawLine of info.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || !line.includes(":")) continue;
    const [key, value] = line.split(":", 2);
    if (picked.has(key)) result[key] = value;
  }
  return result;
}
