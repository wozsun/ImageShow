import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_INTEGRITY_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_STATS_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY,
  assertReadyImageCacheKey
} from "./keys.ts";
import {
  REDIS_BATCH_MAX_COMMANDS,
  RedisPipelineBatcher,
  chunkHashEntries,
  estimatedRedisBytes
} from "./redis-batch.ts";

const INTEGRITY_ENTRY_COUNT_FIELD = "_entry_count";
const INTEGRITY_STATS_DIGEST_FIELD = "_stats_digest";
const INTEGRITY_RESERVED_FIELD_COUNT = 2;
const SCAN_COUNT = 1_000;
const coreCardinalityKeys = new Set([
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_STATS_KEY
]);

export type ReadyImageCardinalities = Map<string, number>;
export type ReadyImageStats = Map<string, number>;

function nonNegativeCardinality(raw: unknown, field: string) {
  const value = String(raw ?? "");
  if (!/^\d+$/.test(value)) {
    throw new Error(`Ready-image cache integrity contains invalid ${field}`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`Ready-image cache integrity ${field} is too large`);
  }
  return number;
}

function persistentDataKey(key: string) {
  assertReadyImageCacheKey(key);
  return (
    key === READY_IMAGE_ITEMS_KEY
    || key === READY_IMAGE_STATS_KEY
    || key === READY_IMAGE_ALL_INDEX_KEY
    || key === READY_IMAGE_OBJECT_LOOKUP_KEY
    || key === READY_IMAGE_THUMB_LOOKUP_KEY
    || key === READY_IMAGE_ID_SUFFIX_LOOKUP_KEY
  );
}

function cardinalityKind(key: string): "hash" | "zset" {
  if (
    key === READY_IMAGE_ITEMS_KEY
    || key === READY_IMAGE_STATS_KEY
    || key === READY_IMAGE_OBJECT_LOOKUP_KEY
    || key === READY_IMAGE_THUMB_LOOKUP_KEY
  ) {
    return "hash";
  }
  return "zset";
}

type RedisCardinalityCommands = {
  hlen(key: string): unknown;
  zcard(key: string): unknown;
};

function readyImageStatsDigest(stats: ReadyImageStats) {
  const digest = createHash("sha256");
  const entries = [...stats].sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ));
  for (const [field, rawCount] of entries) {
    if (!field) throw new Error("Ready-image cache statistics contain an empty field");
    const count = nonNegativeCardinality(rawCount, `statistic ${field}`);
    digest.update(String(Buffer.byteLength(field, "utf8")));
    digest.update(":");
    digest.update(field);
    digest.update(":");
    digest.update(String(count));
    digest.update(";");
  }
  return digest.digest("hex");
}

async function readReadyImageStats(client: Redis) {
  const stats: ReadyImageStats = new Map();
  let cursor = "0";
  do {
    const [next, fields] = await client.hscan(
      READY_IMAGE_STATS_KEY,
      cursor,
      "COUNT",
      SCAN_COUNT
    );
    cursor = next;
    for (let index = 0; index < fields.length; index += 2) {
      const field = fields[index];
      const value = fields[index + 1];
      if (!field) throw new Error("Ready-image cache statistics contain an empty field");
      stats.set(field, nonNegativeCardinality(value, `statistic ${field}`));
    }
  } while (cursor !== "0");
  return stats;
}

function sameReadyImageStats(left: ReadyImageStats, right: ReadyImageStats) {
  return left.size === right.size
    && [...left].every(([field, count]) => right.get(field) === count);
}

export async function validateReadyImageStatsIntegrity(
  expected: ReadyImageStats | null,
  client: Redis
) {
  const [stats, persistedDigest] = await Promise.all([
    readReadyImageStats(client),
    client.hget(READY_IMAGE_INTEGRITY_KEY, INTEGRITY_STATS_DIGEST_FIELD)
  ]);
  if (persistedDigest !== readyImageStatsDigest(stats)) {
    throw new Error("Ready-image cache statistics digest differs from the manifest");
  }
  if (expected && !sameReadyImageStats(stats, expected)) {
    throw new Error("Ready-image cache statistics differ from the build");
  }
  return stats;
}

function queueCardinality(
  client: RedisCardinalityCommands,
  key: string
) {
  if (cardinalityKind(key) === "hash") client.hlen(key);
  else client.zcard(key);
}

export async function writeReadyImageStatsAndIntegrity(
  stats: ReadyImageStats,
  cardinalities: ReadyImageCardinalities,
  client: Redis,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const expected = new Map(cardinalities);
  expected.set(READY_IMAGE_STATS_KEY, stats.size);
  const writer = new RedisPipelineBatcher(client);
  const statEntries = function* () {
    for (const [field, value] of stats) {
      yield [field, String(value)] as const;
    }
  };
  for (const chunk of chunkHashEntries(statEntries())) {
    const flat = chunk.flat();
    await writer.queue(
      estimatedRedisBytes(...flat),
      (pipeline) => { pipeline.hset(READY_IMAGE_STATS_KEY, ...flat); }
    );
  }
  const manifestEntries = function* () {
    yield [INTEGRITY_ENTRY_COUNT_FIELD, String(expected.size)] as const;
    yield [INTEGRITY_STATS_DIGEST_FIELD, readyImageStatsDigest(stats)] as const;
    for (const [key, value] of expected) {
      yield [key, String(value)] as const;
    }
  };
  for (const chunk of chunkHashEntries(manifestEntries())) {
    const flat = chunk.flat();
    await writer.queue(
      estimatedRedisBytes(...flat),
      (pipeline) => { pipeline.hset(READY_IMAGE_INTEGRITY_KEY, ...flat); }
    );
  }
  await writer.flush();
  signal?.throwIfAborted();
  return expected;
}

export async function readReadyImageIntegrity(
  client: Redis
): Promise<ReadyImageCardinalities> {
  const [entryCountRaw, statsDigest] = await client.hmget(
    READY_IMAGE_INTEGRITY_KEY,
    INTEGRITY_ENTRY_COUNT_FIELD,
    INTEGRITY_STATS_DIGEST_FIELD
  );
  const entryCount = nonNegativeCardinality(
    entryCountRaw,
    INTEGRITY_ENTRY_COUNT_FIELD
  );
  if (!/^[0-9a-f]{64}$/u.test(statsDigest ?? "")) {
    throw new Error("Ready-image cache integrity has an invalid statistics digest");
  }
  const cardinalities = new Map<string, number>();
  let cursor = "0";
  do {
    const [next, fields] = await client.hscan(
      READY_IMAGE_INTEGRITY_KEY,
      cursor,
      "COUNT",
      SCAN_COUNT
    );
    cursor = next;
    for (let index = 0; index < fields.length; index += 2) {
      const key = fields[index];
      const value = fields[index + 1];
      if (
        !key
        || key === INTEGRITY_ENTRY_COUNT_FIELD
        || key === INTEGRITY_STATS_DIGEST_FIELD
      ) {
        continue;
      }
      if (!persistentDataKey(key)) {
        throw new Error("Ready-image cache integrity references an invalid key");
      }
      cardinalities.set(key, nonNegativeCardinality(value, key));
    }
  } while (cursor !== "0");
  if (
    cardinalities.size !== entryCount
    || await client.hlen(READY_IMAGE_INTEGRITY_KEY)
      !== entryCount + INTEGRITY_RESERVED_FIELD_COUNT
  ) {
    throw new Error("Ready-image cache integrity manifest is incomplete");
  }
  return cardinalities;
}

export function sameReadyImageCardinalities(
  left: ReadyImageCardinalities,
  right: ReadyImageCardinalities
) {
  return left.size === right.size
    && [...left].every(([key, value]) => right.get(key) === value);
}

export async function validateReadyImageCardinalities(
  cardinalities: ReadyImageCardinalities,
  client: Redis,
  signal?: AbortSignal
) {
  let pipeline = client.pipeline();
  let queued: Array<[string, number]> = [];
  const flush = async () => {
    if (!queued.length) return;
    const results = await execRedisPipeline(pipeline);
    queued.forEach(([key, expected], index) => {
      const actual = Number(results[index]?.[1]);
      if (actual !== expected) {
        throw new Error(
          `Ready-image cache cardinality mismatch for ${key}: ${actual}/${expected}`
        );
      }
    });
    pipeline = client.pipeline();
    queued = [];
  };
  for (const [key, expected] of cardinalities) {
    signal?.throwIfAborted();
    queueCardinality(pipeline, key);
    queued.push([key, expected]);
    if (queued.length >= REDIS_BATCH_MAX_COMMANDS) await flush();
  }
  await flush();
  signal?.throwIfAborted();
}

export async function readReadyImageCardinalities(
  keys: string[],
  client: Redis
) {
  const pairs = await readReadyImageCardinalityPairs(keys, client);
  const cardinalities = new Map<string, number>();
  for (const { key, actual } of pairs) cardinalities.set(key, actual);
  return cardinalities;
}

async function readReadyImageCardinalityPairs(
  keys: string[],
  client: Redis
) {
  const pairs: Array<{
    key: string;
    expected: number | null;
    actual: number;
  }> = [];
  const chunkSize = Math.max(1, Math.floor(REDIS_BATCH_MAX_COMMANDS / 2));
  for (let offset = 0; offset < keys.length; offset += chunkSize) {
    const chunk = keys.slice(offset, offset + chunkSize);
    const pipeline = client.pipeline();
    for (const key of chunk) {
      pipeline.hget(READY_IMAGE_INTEGRITY_KEY, key);
      queueCardinality(pipeline, key);
    }
    const results = await execRedisPipeline(pipeline);
    chunk.forEach((key, index) => {
      const existing = results[index * 2]?.[1];
      pairs.push({
        key,
        expected: existing === null
          ? null
          : nonNegativeCardinality(existing, `integrity value for ${key}`),
        actual: nonNegativeCardinality(
          results[index * 2 + 1]?.[1],
          `cardinality for ${key}`
        )
      });
    });
  }
  return pairs;
}

export async function updateReadyImageIntegrity(
  cardinalities: ReadyImageCardinalities,
  client: Redis
) {
  const writer = new RedisPipelineBatcher(client);
  for (const [key, count] of cardinalities) {
    if (count || coreCardinalityKeys.has(key)) {
      await writer.queue(
        estimatedRedisBytes(READY_IMAGE_INTEGRITY_KEY, key, count),
        (pipeline) => {
          pipeline.hset(READY_IMAGE_INTEGRITY_KEY, key, String(count));
        }
      );
    } else {
      await writer.queue(
        estimatedRedisBytes(READY_IMAGE_INTEGRITY_KEY, key),
        (pipeline) => { pipeline.hdel(READY_IMAGE_INTEGRITY_KEY, key); }
      );
    }
  }
  await writer.flush();
  const manifestLength = await client.hlen(READY_IMAGE_INTEGRITY_KEY);
  const entryCount = manifestLength - INTEGRITY_RESERVED_FIELD_COUNT;
  if (entryCount < 0) {
    throw new Error("Ready-image integrity manifest disappeared during sync");
  }
  await client.hset(
    READY_IMAGE_INTEGRITY_KEY,
    INTEGRITY_ENTRY_COUNT_FIELD,
    String(entryCount)
  );
}

export async function publishReadyImageStatsIntegrity(
  expected: ReadyImageStats,
  client: Redis
) {
  const stats = await readReadyImageStats(client);
  if (!sameReadyImageStats(stats, expected)) {
    throw new Error("Ready-image cache statistics differ after incremental sync");
  }
  const transaction = client.multi();
  transaction.hset(
    READY_IMAGE_INTEGRITY_KEY,
    READY_IMAGE_STATS_KEY,
    String(stats.size)
  );
  transaction.hset(
    READY_IMAGE_INTEGRITY_KEY,
    INTEGRITY_STATS_DIGEST_FIELD,
    readyImageStatsDigest(stats)
  );
  await execRedisPipeline(transaction);
  return stats;
}
