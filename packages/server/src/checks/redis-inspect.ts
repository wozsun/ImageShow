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
  READY_IMAGE_EXACT_SYNC_MAX_ITEMS
} from "../images/mutation-sync-policy.ts";
import {
  READY_IMAGE_DERIVED_CACHE_POLICY
} from "../images/ready-cache/derived-cache-policy.ts";
import {
  READY_IMAGE_DERIVED_WORK_POLICY,
  getReadyImageDerivedWorkStatus
} from "../images/ready-cache/derived-work-policy.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_CACHE_PREFIX,
  READY_IMAGE_DERIVED_INDEX_META_PREFIX,
  READY_IMAGE_DERIVED_INDEX_PREFIX,
  READY_IMAGE_DERIVED_PREFIX,
  READY_IMAGE_FILTER_KEY_PREFIX,
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
    scanned,
    persistedMeta,
    requiredCommands
  ] =
    await Promise.all([
      redis.info("server"),
      redis.info("memory"),
      redis.info("keyspace"),
      redis.dbsize(),
      scanImageshowKeys(),
      readReadyImageCacheMeta().catch(() => null),
      readRequiredRedisCommandCapabilities()
    ]);
  const memoryState = parseRedisMemoryState(memoryInfo);
  const coreKeys = await Promise.all(coreKeyNames.map((key) => (
    redisKeySummary(key).catch(() => missingKeySummary(key))
  )));
  const derivedKeys = await summarizeRedisKeys(
    scanned.imageKeys.filter((key) => key.startsWith(READY_IMAGE_DERIVED_PREFIX))
  );
  const coreOccupancy = deepOccupancy(
    coreKeys,
    coreKeys.find((key) => (
      key.key === READY_IMAGE_ITEMS_KEY && key.type === "hash"
    ))?.type_length ?? 0
  );
  const derivedOccupancy = deepOccupancy(
    derivedKeys,
    derivedKeys.reduce((sum, key) => (
      key.type === "zset"
      && (
        key.key.startsWith(READY_IMAGE_DERIVED_INDEX_PREFIX)
        || key.key.startsWith(READY_IMAGE_FILTER_KEY_PREFIX)
      )
        ? sum + key.type_length
        : sum
    ), 0)
  );
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
    prefix_counts: scanned.counts,
    image_projection: {
      ...projection,
      core: coreOccupancy,
      derived: derivedOccupancy,
      coordinator,
      persisted_meta: persistedMeta,
      core_keys: coreKeys,
      derived_keys: derivedKeys,
      derived_policy: {
        ttl_seconds: READY_IMAGE_DERIVED_CACHE_POLICY.ttlSeconds,
        temporary_ttl_seconds:
          READY_IMAGE_DERIVED_CACHE_POLICY.temporaryTtlSeconds,
        max_results: READY_IMAGE_DERIVED_CACHE_POLICY.maxResults,
        max_result_members:
          READY_IMAGE_DERIVED_CACHE_POLICY.maxResultMembers,
        minimum_total_members:
          READY_IMAGE_DERIVED_CACHE_POLICY.minimumTotalMembers,
        total_member_multiplier:
          READY_IMAGE_DERIVED_CACHE_POLICY.totalMemberMultiplier,
        max_active_signatures:
          READY_IMAGE_DERIVED_CACHE_POLICY.maxActiveSignatures,
        max_stats_result_bytes:
          READY_IMAGE_DERIVED_CACHE_POLICY.maxStatsResultBytes
      },
      derived_work_policy: {
        ...READY_IMAGE_DERIVED_WORK_POLICY,
        active: getReadyImageDerivedWorkStatus()
      },
      mutation_sync_policy: {
        exact_sync_max_items: READY_IMAGE_EXACT_SYNC_MAX_ITEMS
      }
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
    type_length: await redisKeyLength(key, type)
  };
}

function missingKeySummary(key: string) {
  return {
    key,
    exists: false,
    type: "unknown",
    ttl_seconds: -2,
    memory_bytes: null,
    type_length: 0
  };
}

async function summarizeRedisKeys(keys: string[]) {
  const summaries: Awaited<ReturnType<typeof redisKeySummary>>[] = [];
  for (let offset = 0; offset < keys.length; offset += 32) {
    summaries.push(...await Promise.all(
      keys.slice(offset, offset + 32).map((key) => (
        redisKeySummary(key).catch(() => missingKeySummary(key))
      ))
    ));
  }
  return summaries;
}

function deepOccupancy(
  keys: Array<Awaited<ReturnType<typeof redisKeySummary>>>,
  memberCount: number
) {
  const existing = keys.filter((key) => key.exists);
  const memoryValues = existing.map((key) => key.memory_bytes);
  return {
    key_count: existing.length,
    member_count: memberCount,
    memory_bytes: memoryValues.every((value) => value !== null)
      ? memoryValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
      : null,
    source: "deep" as const
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

async function scanImageshowKeys() {
  const counts = emptyPrefixCounts();
  const imageKeys: string[] = [];
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
        imageKeys.push(key);
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
  return { counts, imageKeys };
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
