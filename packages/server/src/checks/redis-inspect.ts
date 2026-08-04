import { deploymentConfig } from "../config/deployment-config.ts";
import { pingRedis, redis } from "../core/redis-client.ts";
import {
  getReadyImageCacheCoordinatorStatus
} from "../images/ready-cache/coordinator.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_CACHE_PREFIX,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_INTEGRITY_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_META_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_STATS_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY
} from "../images/ready-cache/keys.ts";
import { readReadyImageCacheMeta } from "../images/ready-cache/meta.ts";
import { ORIGINAL_DIRECT_CACHE_PREFIX } from "../images/original-direct-cache.ts";

const SESSION_KEY_PREFIX = "imageshow:session:";
const LOGIN_FAIL_KEY_PREFIX = "imageshow:login_fail:";

const coreKeyNames = [
  READY_IMAGE_META_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_STATS_KEY,
  READY_IMAGE_INTEGRITY_KEY,
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY
];

export async function inspectRedisState() {
  await pingRedis();
  const [serverInfo, memoryInfo, keyspaceInfo, dbsize, scanned, persistedMeta] =
    await Promise.all([
      redis.info("server"),
      redis.info("memory"),
      redis.info("keyspace"),
      redis.dbsize(),
      scanImageshowKeys(),
      readReadyImageCacheMeta().catch(() => null)
    ]);
  const coreKeys = await Promise.all(coreKeyNames.map((key) => (
    redisKeySummary(key).catch(() => missingKeySummary(key))
  )));
  const coordinator = getReadyImageCacheCoordinatorStatus();
  const issues: string[] = [];
  if (!coordinator.readable) {
    issues.push(`统一图片缓存不可读：${coordinator.reason}`);
  }
  if (!persistedMeta) issues.push("统一图片缓存 meta 不存在或无法解析");
  if (persistedMeta?.state !== "ready") {
    issues.push(`统一图片缓存状态不是 ready：${persistedMeta?.state ?? "missing"}`);
  }
  for (const key of coreKeys) {
    if (persistedMeta?.itemCount && !key.exists) {
      issues.push(`统一图片缓存核心键不存在：${key.key}`);
    }
  }

  return {
    connection: {
      status: redis.status,
      configured_db: deploymentConfig.redis.db,
      redis_version: parseRedisInfo(
        serverInfo,
        new Set(["redis_version"])
      ).redis_version ?? "unknown",
      dbsize,
      memory: parseRedisInfo(memoryInfo),
      keyspace: parseRedisInfo(keyspaceInfo)
    },
    prefix_counts: scanned,
    image_cache: {
      coordinator,
      persisted_meta: persistedMeta,
      core_keys: coreKeys
    },
    issues
  };
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
    ready_image_cache: 0,
    ready_image_indexes: 0,
    ready_image_filters: 0,
    ready_image_filter_meta: 0,
    ready_image_stats_results: 0,
    original_direct_cache: 0,
    sessions: 0,
    login_failures: 0,
    temporary: 0,
    other: 0
  };
}

async function scanImageshowKeys() {
  const counts = emptyPrefixCounts();
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      "imageshow:*",
      "COUNT",
      500
    );
    cursor = nextCursor;
    for (const key of keys) {
      counts.imageshow_total += 1;
      if (key.startsWith(READY_IMAGE_CACHE_PREFIX)) {
        counts.ready_image_cache += 1;
        if (key.startsWith(`${READY_IMAGE_CACHE_PREFIX}index:`)) {
          counts.ready_image_indexes += 1;
        } else if (key.startsWith(`${READY_IMAGE_CACHE_PREFIX}filter-meta:`)) {
          counts.ready_image_filter_meta += 1;
        } else if (key.startsWith(`${READY_IMAGE_CACHE_PREFIX}filter:`)) {
          counts.ready_image_filters += 1;
        } else if (key.startsWith(`${READY_IMAGE_CACHE_PREFIX}stats-result:`)) {
          counts.ready_image_stats_results += 1;
        }
      } else if (key.startsWith(ORIGINAL_DIRECT_CACHE_PREFIX)) {
        counts.original_direct_cache += 1;
      } else if (key.startsWith(SESSION_KEY_PREFIX)) {
        counts.sessions += 1;
      } else if (key.startsWith(LOGIN_FAIL_KEY_PREFIX)) {
        counts.login_failures += 1;
      } else {
        counts.other += 1;
      }
      if (key.includes(":tmp:") || key.includes(":filter-temp:")) {
        counts.temporary += 1;
      }
    }
  } while (cursor !== "0");
  return counts;
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
