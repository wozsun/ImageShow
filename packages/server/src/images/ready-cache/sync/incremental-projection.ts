import { redis } from "../../../core/redis/client.ts";
import { execRedisPipeline } from "../../../core/redis/pipeline.ts";
import { validateReadyImageSamples } from "../integrity/check.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_STATS_KEY
} from "../keys.ts";
import {
  READY_IMAGE_INCREMENTAL_LIMIT,
  parseReadyImageCacheItem,
  readyImageIdSuffixScore,
  readyImageMember,
  readyImageStatFields,
  serializeReadyImageCacheItem,
  type ReadyImageCacheItem
} from "../model.ts";
import {
  readReadyImageCardinalities,
  updateReadyImageIntegrity,
  type ReadyImageStats
} from "../integrity/manifest.ts";
import {
  REDIS_BATCH_MAX_COMMANDS,
  RedisPipelineBatcher,
  estimatedRedisBytes
} from "./redis-batch.ts";

function nonNegativeInteger(value: unknown, context: string) {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Ready-image incremental sync returned invalid ${context}`);
  }
  return count;
}

function adjustExpectedReadyImageStats(
  stats: ReadyImageStats,
  items: ReadyImageCacheItem[],
  difference: -1 | 1,
  deltas: Map<string, number>
) {
  for (const item of items) {
    for (const field of readyImageStatFields(item)) {
      const current = stats.get(field) ?? 0;
      const next = current + difference;
      if (!Number.isSafeInteger(next) || next < 0) {
        throw new Error(`Ready-image incremental statistics differ before updating ${field}`);
      }
      if (next === 0 && field !== "total") stats.delete(field);
      else stats.set(field, next);
      deltas.set(field, (deltas.get(field) ?? 0) + difference);
    }
  }
}

export async function readPreviousReadyImageCacheItems(ids: string[]) {
  const items: ReadyImageCacheItem[] = [];
  for (let offset = 0; offset < ids.length; offset += READY_IMAGE_INCREMENTAL_LIMIT) {
    const members = ids.slice(offset, offset + READY_IMAGE_INCREMENTAL_LIMIT).map(readyImageMember);
    const pipeline = redis.pipeline();
    pipeline.hmget(READY_IMAGE_ITEMS_KEY, ...members);
    pipeline.zmscore(READY_IMAGE_ALL_INDEX_KEY, ...members);
    const results = await execRedisPipeline(pipeline);
    const raws = (results[0]?.[1] as Array<string | null>) ?? [];
    const scores = (results[1]?.[1] as Array<string | null>) ?? [];
    if (raws.length !== members.length || scores.length !== members.length) {
      throw new Error("Ready-image incremental source lookup was incomplete");
    }
    raws.forEach((raw, index) => {
      if (Boolean(raw) !== Boolean(scores[index])) {
        throw new Error("Ready-image incremental source is internally inconsistent");
      }
      if (!raw) return;
      const item = parseReadyImageCacheItem(raw);
      if (!item || readyImageMember(item.id) !== members[index]) {
        throw new Error("Ready-image incremental source contains a corrupt item");
      }
      items.push(item);
    });
  }
  await validateReadyImageSamples(items, redis);
  return items;
}

async function queueRemoval(item: ReadyImageCacheItem, writer: RedisPipelineBatcher) {
  const member = readyImageMember(item.id);
  await writer.queue(estimatedRedisBytes(READY_IMAGE_ITEMS_KEY, member), (pipeline) => {
    pipeline.hdel(READY_IMAGE_ITEMS_KEY, member);
  });
  await writer.queue(estimatedRedisBytes(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, member), (pipeline) => {
    pipeline.zrem(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, member);
  });
  await writer.queue(estimatedRedisBytes(READY_IMAGE_ALL_INDEX_KEY, member), (pipeline) => {
    pipeline.zrem(READY_IMAGE_ALL_INDEX_KEY, member);
  });
}

async function queueAddition(
  item: ReadyImageCacheItem,
  previous: ReadyImageCacheItem | undefined,
  writer: RedisPipelineBatcher
) {
  const member = readyImageMember(item.id);
  const serialized = serializeReadyImageCacheItem(item);
  if (!previous || serializeReadyImageCacheItem(previous) !== serialized) {
    await writer.queue(
      estimatedRedisBytes(READY_IMAGE_ITEMS_KEY, member, serialized),
      (pipeline) => {
        pipeline.hset(READY_IMAGE_ITEMS_KEY, member, serialized);
      }
    );
  }
  if (!previous) {
    await writer.queue(
      estimatedRedisBytes(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, readyImageIdSuffixScore(item), member),
      (pipeline) => {
        pipeline.zadd(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, readyImageIdSuffixScore(item), member);
      }
    );
  }
  if (!previous || previous.sort_score !== item.sort_score) {
    await writer.queue(
      estimatedRedisBytes(READY_IMAGE_ALL_INDEX_KEY, item.sort_score, member),
      (pipeline) => {
        pipeline.zadd(READY_IMAGE_ALL_INDEX_KEY, item.sort_score, member);
      }
    );
  }
}

async function removeZeroStatistics(fields: string[]) {
  for (let offset = 0; offset < fields.length; offset += REDIS_BATCH_MAX_COMMANDS) {
    const chunk = fields.slice(offset, offset + REDIS_BATCH_MAX_COMMANDS);
    const values = await redis.hmget(READY_IMAGE_STATS_KEY, ...chunk);
    const zeroFields: string[] = [];
    values.forEach((value, index) => {
      if (value === null) return;
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("Ready-image incremental statistics became negative");
      }
      if (count === 0 && chunk[index] !== "total") {
        zeroFields.push(chunk[index]!);
      }
    });
    if (zeroFields.length) {
      await redis.hdel(READY_IMAGE_STATS_KEY, ...zeroFields);
    }
  }
}

async function validateIncrementalCardinalities(
  cardinalities: Map<string, number>,
  expectedItemCount: number
) {
  for (const key of [
    READY_IMAGE_ITEMS_KEY,
    READY_IMAGE_ALL_INDEX_KEY,
    READY_IMAGE_ID_SUFFIX_LOOKUP_KEY
  ]) {
    if (cardinalities.get(key) !== expectedItemCount) {
      throw new Error(`Ready-image incremental core cardinality differs for ${key}`);
    }
  }
  const totalStatistic = nonNegativeInteger(
    await redis.hget(READY_IMAGE_STATS_KEY, "total"),
    "total statistic"
  );
  if (cardinalities.get(READY_IMAGE_ALL_INDEX_KEY) !== totalStatistic) {
    throw new Error("Ready-image incremental all index differs from total statistic");
  }
}

export async function applyReadyImageCacheDelta(
  previousItems: ReadyImageCacheItem[],
  currentItems: ReadyImageCacheItem[],
  nextItemCount: number,
  expectedStats: ReadyImageStats
) {
  const statDeltas = new Map<string, number>();
  // Decrement the complete previous contribution before applying additions.
  // A net-zero update must still detect insufficient or corrupt old counts.
  adjustExpectedReadyImageStats(expectedStats, previousItems, -1, statDeltas);
  adjustExpectedReadyImageStats(expectedStats, currentItems, 1, statDeltas);
  const previousById = new Map(previousItems.map((item) => [item.id, item]));
  const currentIds = new Set(currentItems.map((item) => item.id));
  const writer = new RedisPipelineBatcher(redis);
  for (const item of previousItems) {
    if (!currentIds.has(item.id)) await queueRemoval(item, writer);
  }
  for (const item of currentItems) {
    await queueAddition(item, previousById.get(item.id), writer);
  }
  const changedStats: string[] = [];
  for (const [field, difference] of statDeltas) {
    if (!difference) continue;
    changedStats.push(field);
    await writer.queue(
      estimatedRedisBytes(READY_IMAGE_STATS_KEY, field, difference),
      (pipeline) => {
        pipeline.hincrby(READY_IMAGE_STATS_KEY, field, difference);
      }
    );
  }
  await writer.flush();
  await removeZeroStatistics(changedStats);

  const touchedCardinalityKeys = [
    READY_IMAGE_ITEMS_KEY,
    READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
    READY_IMAGE_STATS_KEY,
    READY_IMAGE_ALL_INDEX_KEY
  ];
  const cardinalities = await readReadyImageCardinalities(touchedCardinalityKeys, redis);
  await validateIncrementalCardinalities(cardinalities, nextItemCount);
  await updateReadyImageIntegrity(cardinalities, redis);
  await validateReadyImageSamples(currentItems, redis);
}
