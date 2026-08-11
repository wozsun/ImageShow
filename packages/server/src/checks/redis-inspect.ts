import { deploymentConfig } from "../config/deployment-config.ts";
import {
  parseRedisInfoFields,
  parseRedisMemoryState,
  pingRedis,
  readRequiredRedisCommandCapabilities,
  redis
} from "../core/redis-client.ts";
import {
  getReadyImageCacheCoordinatorStatus
} from "../images/ready-cache/coordinator.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_CACHE_PREFIX,
  READY_IMAGE_DERIVED_INDEX_META_PREFIX,
  READY_IMAGE_DERIVED_INDEX_PREFIX,
  READY_IMAGE_DERIVED_PREFIX,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_INTEGRITY_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_LAST_UPDATED_KEY,
  READY_IMAGE_META_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_STATS_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY
} from "../images/ready-cache/keys.ts";
import { readReadyImageCacheMeta } from "../images/ready-cache/meta.ts";
import {
  readReadyImageCacheAdminStatus
} from "../images/ready-cache/admin-status.ts";
import { adminSessionKeyFamilyPrefix } from "../users/admin-session-key.ts";
import { ORIGINAL_DIRECT_CACHE_PREFIX } from "../images/original-direct-cache.ts";

const LOGIN_FAIL_KEY_PREFIX = "imageshow:login_fail:";

const coreKeyNames = [
  READY_IMAGE_META_KEY,
  READY_IMAGE_LAST_UPDATED_KEY,
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
  const [
    serverInfo,
    memoryInfo,
    keyspaceInfo,
    dbsize,
    prefixCounts,
    persistedMeta,
    requiredCommands
  ] =
    await Promise.all([
      redis.info("server"),
      redis.info("memory"),
      redis.info("keyspace"),
      redis.dbsize(),
      scanImageshowKeyCounts(),
      readReadyImageCacheMeta().catch(() => null),
      readRequiredRedisCommandCapabilities()
    ]);
  const memoryState = parseRedisMemoryState(memoryInfo);
  const coreKeys = await Promise.all(coreKeyNames.map(async (key) => ({
    key,
    exists: await redis.exists(key) > 0
  })));
  const coordinator = getReadyImageCacheCoordinatorStatus();
  const projection = await readReadyImageCacheAdminStatus(null);
  const issues: string[] = [];
  if (!coordinator.readable) {
    issues.push(`统一图片缓存不可读：${coordinator.reason}`);
  }
  if (!persistedMeta) issues.push("统一图片缓存 meta 不存在或无法解析");
  for (const command of requiredCommands.missing) {
    issues.push(`Redis 缺少必需命令：${command}`);
  }
  if (persistedMeta?.state !== "ready") {
    issues.push(`统一图片缓存状态不是 ready：${persistedMeta?.state ?? "missing"}`);
  }
  const requiredCoreKeys = persistedMeta?.state === "ready"
    ? new Set(persistedMeta.itemCount === 0
      ? [
          READY_IMAGE_META_KEY,
          READY_IMAGE_STATS_KEY,
          READY_IMAGE_INTEGRITY_KEY,
          READY_IMAGE_LAST_UPDATED_KEY
        ]
      : coreKeyNames)
    : new Set<string>();
  for (const key of coreKeys) {
    if (requiredCoreKeys.has(key.key) && !key.exists) {
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
      required_commands: requiredCommands.commands,
      memory: {
        ...parseRedisInfo(memoryInfo),
        used_memory_bytes: memoryState.usedMemory,
        used_memory_rss_bytes: memoryState.usedMemoryRss
      },
      keyspace: parseRedisInfo(keyspaceInfo)
    },
    prefix_counts: prefixCounts,
    image_projection: projection,
    issues
  };
}

function emptyPrefixCounts() {
  return {
    imageshow_total: 0,
    ready_image_cache: 0,
    ready_image_indexes: 0,
    ready_image_index_meta: 0,
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

async function scanImageshowKeyCounts() {
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
        if (
          key === READY_IMAGE_ALL_INDEX_KEY
          || key.startsWith(READY_IMAGE_DERIVED_INDEX_PREFIX)
        ) {
          counts.ready_image_indexes += 1;
        } else if (key.startsWith(READY_IMAGE_DERIVED_INDEX_META_PREFIX)) {
          counts.ready_image_index_meta += 1;
        } else if (key.startsWith(`${READY_IMAGE_DERIVED_PREFIX}filter-meta:`)) {
          counts.ready_image_filter_meta += 1;
        } else if (key.startsWith(`${READY_IMAGE_DERIVED_PREFIX}filter:`)) {
          counts.ready_image_filters += 1;
        } else if (key.startsWith(`${READY_IMAGE_DERIVED_PREFIX}stats-result:`)) {
          counts.ready_image_stats_results += 1;
        }
      } else if (key.startsWith(ORIGINAL_DIRECT_CACHE_PREFIX)) {
        counts.original_direct_cache += 1;
      } else if (key.startsWith(adminSessionKeyFamilyPrefix)) {
        counts.sessions += 1;
      } else if (key.startsWith(LOGIN_FAIL_KEY_PREFIX)) {
        counts.login_failures += 1;
      } else {
        counts.other += 1;
      }
      if (
        key.includes(":tmp:")
        || key.startsWith(`${READY_IMAGE_DERIVED_PREFIX}temp:`)
      ) {
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
    "mem_fragmentation_ratio",
    "db0"
  ])
) {
  const result: Record<string, string> = {};
  for (const [key, value] of parseRedisInfoFields(info)) {
    if (picked.has(key)) result[key] = value;
  }
  return result;
}
