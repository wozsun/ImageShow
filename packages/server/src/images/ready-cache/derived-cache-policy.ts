import { redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  READY_IMAGE_FILTER_COUNTS_KEY,
  READY_IMAGE_FILTER_LRU_KEY,
  READY_IMAGE_CACHE_PREFIX,
  READY_IMAGE_STATS_RESULT_LRU_KEY,
  assertReadyImageCacheKey,
  readyImageFilterMetaKeyForFilterKey
} from "./keys.ts";

const FILTER_MAX_ENTRIES = 32;
const FILTER_MIN_TOTAL_MEMBERSHIPS = 10_000;
const FILTER_TOTAL_MEMBERSHIP_MULTIPLIER = 8;
const STATS_RESULT_MAX_ENTRIES = 128;
const STATS_RESULT_MAX_BYTES = 512 * 1024;
const SCAN_COUNT = 1_000;
let lastAccessScore = 0;

type FilterRegistryEntry = {
  key: string;
  count: number;
};

function nonNegativeInteger(raw: unknown) {
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nextAccessScore() {
  lastAccessScore = Math.max(Date.now(), lastAccessScore + 1);
  return lastAccessScore;
}

function filterMembershipLimit(itemCount: number) {
  const multiplied = itemCount * FILTER_TOTAL_MEMBERSHIP_MULTIPLIER;
  if (!Number.isSafeInteger(multiplied)) {
    throw new Error("Ready-image derived filter limit is outside the safe range");
  }
  return Math.max(FILTER_MIN_TOTAL_MEMBERSHIPS, multiplied);
}

async function readFilterRegistry() {
  const keys = await redis.zrange(READY_IMAGE_FILTER_LRU_KEY, 0, "-1");
  if (!keys.length) return { valid: [], invalid: [] };
  keys.forEach(assertReadyImageCacheKey);
  const pipeline = redis.pipeline();
  pipeline.hmget(READY_IMAGE_FILTER_COUNTS_KEY, ...keys);
  for (const key of keys) {
    pipeline.exists(readyImageFilterMetaKeyForFilterKey(key));
  }
  const results = await execRedisPipeline(pipeline);
  const counts = results[0]?.[1] as Array<string | null> ?? [];
  const valid: FilterRegistryEntry[] = [];
  const invalid: string[] = [];
  keys.forEach((key, index) => {
    const count = nonNegativeInteger(counts[index]);
    const metaExists = Number(results[index + 1]?.[1] ?? 0) === 1;
    if (count === null || !metaExists) invalid.push(key);
    else valid.push({ key, count });
  });
  return { valid, invalid };
}

async function evictDerivedFilters(keys: string[]) {
  if (!keys.length) return;
  const transaction = redis.multi();
  for (const key of keys) {
    assertReadyImageCacheKey(key);
    transaction.unlink(key, readyImageFilterMetaKeyForFilterKey(key));
    transaction.zrem(READY_IMAGE_FILTER_LRU_KEY, key);
    transaction.hdel(READY_IMAGE_FILTER_COUNTS_KEY, key);
  }
  await execRedisPipeline(transaction);
}

async function evictStatsResults(keys: string[]) {
  if (!keys.length) return;
  keys.forEach(assertReadyImageCacheKey);
  const transaction = redis.multi();
  transaction.unlink(...keys);
  transaction.zrem(READY_IMAGE_STATS_RESULT_LRU_KEY, ...keys);
  await execRedisPipeline(transaction);
}

export async function trimLeastRecentlyUsedDerivedCaches() {
  const [filters, statsKeys] = await Promise.all([
    readFilterRegistry(),
    redis.zrange(READY_IMAGE_STATS_RESULT_LRU_KEY, 0, "-1")
  ]);
  const retainedFilters = filters.valid.length > 1
    ? filters.valid.slice(-Math.ceil(filters.valid.length / 2))
    : filters.valid;
  const retainedFilterKeys = new Set(retainedFilters.map(({ key }) => key));
  const filterVictims = [
    ...filters.invalid,
    ...filters.valid
      .filter(({ key }) => !retainedFilterKeys.has(key))
      .map(({ key }) => key)
  ];
  const statsVictims = statsKeys.slice(
    0,
    Math.max(0, statsKeys.length - Math.ceil(statsKeys.length / 2))
  );
  await Promise.all([
    evictDerivedFilters(filterVictims),
    evictStatsResults(statsVictims)
  ]);
}

/**
 * Registers one published filter and bounds duplicate ZSET memberships. The
 * caller owns the ready-image write fence, which serializes this registry in
 * the supported single-application deployment.
 */
export async function registerReadyImageDerivedFilter(
  key: string,
  count: number,
  itemCount: number
) {
  assertReadyImageCacheKey(key);
  if (
    nonNegativeInteger(count) === null
    || nonNegativeInteger(itemCount) === null
  ) {
    throw new Error("Ready-image derived filter has an invalid cardinality");
  }
  const transaction = redis.multi();
  transaction.zadd(READY_IMAGE_FILTER_LRU_KEY, nextAccessScore(), key);
  transaction.hset(READY_IMAGE_FILTER_COUNTS_KEY, key, String(count));
  await execRedisPipeline(transaction);

  const registry = await readFilterRegistry();
  const retained = [...registry.valid];
  let memberships = retained.reduce((sum, entry) => sum + entry.count, 0);
  if (!Number.isSafeInteger(memberships)) {
    throw new Error("Ready-image derived filter memberships are too large");
  }
  const victims = [...registry.invalid];
  const membershipLimit = filterMembershipLimit(itemCount);
  while (
    retained.length > FILTER_MAX_ENTRIES
    || memberships > membershipLimit
  ) {
    const victim = retained.shift();
    if (!victim) break;
    victims.push(victim.key);
    memberships -= victim.count;
  }
  await evictDerivedFilters(victims);
}

export async function touchReadyImageDerivedFilter(key: string) {
  assertReadyImageCacheKey(key);
  await redis.zadd(READY_IMAGE_FILTER_LRU_KEY, nextAccessScore(), key);
}

const storeStatsResultScript = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
redis.call('ZADD', KEYS[2], ARGV[3], KEYS[1])
local overflow = redis.call('ZCARD', KEYS[2]) - tonumber(ARGV[4])
if overflow > 0 then
  local victims = redis.call('ZRANGE', KEYS[2], 0, overflow - 1)
  for _, key in ipairs(victims) do
    redis.call('UNLINK', key)
    redis.call('ZREM', KEYS[2], key)
  end
end
return 1`;

export async function storeReadyImageStatsResult(
  key: string,
  serialized: string,
  ttlSeconds: number
) {
  assertReadyImageCacheKey(key);
  if (Buffer.byteLength(serialized, "utf8") > STATS_RESULT_MAX_BYTES) {
    return false;
  }
  await redis.call(
    "EVAL",
    storeStatsResultScript,
    "2",
    key,
    READY_IMAGE_STATS_RESULT_LRU_KEY,
    serialized,
    String(ttlSeconds),
    String(nextAccessScore()),
    String(STATS_RESULT_MAX_ENTRIES)
  );
  return true;
}

export async function touchReadyImageStatsResult(key: string) {
  assertReadyImageCacheKey(key);
  await redis.zadd(READY_IMAGE_STATS_RESULT_LRU_KEY, nextAccessScore(), key);
}

export async function discardReadyImageStatsResult(key: string) {
  assertReadyImageCacheKey(key);
  const transaction = redis.multi();
  transaction.unlink(key);
  transaction.zrem(READY_IMAGE_STATS_RESULT_LRU_KEY, key);
  await execRedisPipeline(transaction);
}

async function clearPattern(pattern: string) {
  let removedInPass: number;
  do {
    let cursor = "0";
    removedInPass = 0;
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_COUNT
      );
      cursor = next;
      keys.forEach(assertReadyImageCacheKey);
      if (keys.length) removedInPass += await redis.unlink(...keys);
    } while (cursor !== "0");
  } while (removedInPass > 0);
}

/**
 * Drops only published reproducible query products while preserving gallery
 * core data. Builder-owned temporary keys expire independently and are never
 * removed from under an active filter construction.
 */
export async function clearReadyImageDisposableCaches() {
  await Promise.all([
    clearPattern(`${READY_IMAGE_CACHE_PREFIX}filter:*`),
    clearPattern(`${READY_IMAGE_CACHE_PREFIX}filter-meta:*`),
    clearPattern(`${READY_IMAGE_CACHE_PREFIX}stats-result:*`)
  ]);
  await redis.unlink(
    READY_IMAGE_FILTER_LRU_KEY,
    READY_IMAGE_FILTER_COUNTS_KEY,
    READY_IMAGE_STATS_RESULT_LRU_KEY
  );
  await redis.call("MEMORY", "PURGE").catch(() => undefined);
}
