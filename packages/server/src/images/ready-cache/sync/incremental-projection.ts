import { redis } from "../../../core/redis/client.ts";
import { execRedisPipeline } from "../../../core/redis/pipeline.ts";
import { validateReadyImageSamples } from "../integrity/check.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_STATS_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY
} from "../keys.ts";
import {
  READY_IMAGE_INCREMENTAL_LIMIT,
  parseReadyImageCacheItem,
  readyImageIdSuffixScore,
  readyImageMember,
  readyImageStatFields,
  readyImageThumbKey,
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
  difference: -1 | 1
) {
  for (const item of items) {
    for (const field of readyImageStatFields(item)) {
      const current = stats.get(field) ?? 0;
      const next = current + difference;
      if (!Number.isSafeInteger(next) || next < 0) {
        throw new Error(
          `Ready-image incremental statistics differ before updating ${field}`
        );
      }
      if (next === 0 && field !== "total") stats.delete(field);
      else stats.set(field, next);
    }
  }
}

export async function readPreviousReadyImageCacheItems(ids: string[]) {
  const items: ReadyImageCacheItem[] = [];
  for (
    let offset = 0;
    offset < ids.length;
    offset += READY_IMAGE_INCREMENTAL_LIMIT
  ) {
    const members = ids
      .slice(offset, offset + READY_IMAGE_INCREMENTAL_LIMIT)
      .map(readyImageMember);
    const pipeline = redis.pipeline();
    pipeline.hmget(READY_IMAGE_ITEMS_KEY, ...members);
    pipeline.zmscore(READY_IMAGE_ALL_INDEX_KEY, ...members);
    const results = await execRedisPipeline(pipeline);
    const raws = results[0]?.[1] as Array<string | null> ?? [];
    const scores = results[1]?.[1] as Array<string | null> ?? [];
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

async function queueRemoval(
  item: ReadyImageCacheItem,
  writer: RedisPipelineBatcher
) {
  const member = readyImageMember(item.id);
  for (const [key, field] of [
    [READY_IMAGE_ITEMS_KEY, member],
    [READY_IMAGE_OBJECT_LOOKUP_KEY, item.object_key],
    [READY_IMAGE_THUMB_LOOKUP_KEY, readyImageThumbKey(item)]
  ] as const) {
    await writer.queue(
      estimatedRedisBytes(key, field),
      (pipeline) => { pipeline.hdel(key, field); }
    );
  }
  await writer.queue(
    estimatedRedisBytes(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, member),
    (pipeline) => { pipeline.zrem(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, member); }
  );
  await writer.queue(
    estimatedRedisBytes(READY_IMAGE_ALL_INDEX_KEY, member),
    (pipeline) => { pipeline.zrem(READY_IMAGE_ALL_INDEX_KEY, member); }
  );
  for (const field of readyImageStatFields(item)) {
    await writer.queue(
      estimatedRedisBytes(READY_IMAGE_STATS_KEY, field, -1),
      (pipeline) => { pipeline.hincrby(READY_IMAGE_STATS_KEY, field, -1); }
    );
  }
}

async function queueAddition(
  item: ReadyImageCacheItem,
  writer: RedisPipelineBatcher
) {
  const member = readyImageMember(item.id);
  const serialized = serializeReadyImageCacheItem(item);
  for (const [key, field, value] of [
    [READY_IMAGE_ITEMS_KEY, member, serialized],
    [READY_IMAGE_OBJECT_LOOKUP_KEY, item.object_key, member],
    [READY_IMAGE_THUMB_LOOKUP_KEY, readyImageThumbKey(item), member]
  ] as const) {
    await writer.queue(
      estimatedRedisBytes(key, field, value),
      (pipeline) => { pipeline.hset(key, field, value); }
    );
  }
  await writer.queue(
    estimatedRedisBytes(
      READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
      readyImageIdSuffixScore(item),
      member
    ),
    (pipeline) => {
      pipeline.zadd(
        READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
        readyImageIdSuffixScore(item),
        member
      );
    }
  );
  await writer.queue(
    estimatedRedisBytes(
      READY_IMAGE_ALL_INDEX_KEY,
      item.sort_score,
      member
    ),
    (pipeline) => {
      pipeline.zadd(READY_IMAGE_ALL_INDEX_KEY, item.sort_score, member);
    }
  );
  for (const field of readyImageStatFields(item)) {
    await writer.queue(
      estimatedRedisBytes(READY_IMAGE_STATS_KEY, field, 1),
      (pipeline) => { pipeline.hincrby(READY_IMAGE_STATS_KEY, field, 1); }
    );
  }
}

async function removeZeroStatistics(fields: string[]) {
  for (
    let offset = 0;
    offset < fields.length;
    offset += REDIS_BATCH_MAX_COMMANDS
  ) {
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
    READY_IMAGE_OBJECT_LOOKUP_KEY,
    READY_IMAGE_THUMB_LOOKUP_KEY,
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
    throw new Error(
      "Ready-image incremental all index differs from total statistic"
    );
  }
}

export async function applyReadyImageCacheDelta(
  previousItems: ReadyImageCacheItem[],
  currentItems: ReadyImageCacheItem[],
  nextItemCount: number,
  expectedStats: ReadyImageStats
) {
  adjustExpectedReadyImageStats(expectedStats, previousItems, -1);
  adjustExpectedReadyImageStats(expectedStats, currentItems, 1);
  const touchedStats = new Set<string>();
  for (const item of [...previousItems, ...currentItems]) {
    for (const field of readyImageStatFields(item)) touchedStats.add(field);
  }
  const writer = new RedisPipelineBatcher(redis);
  for (const item of previousItems) await queueRemoval(item, writer);
  for (const item of currentItems) await queueAddition(item, writer);
  await writer.flush();
  await removeZeroStatistics([...touchedStats]);

  const touchedCardinalityKeys = [
    READY_IMAGE_ITEMS_KEY,
    READY_IMAGE_OBJECT_LOOKUP_KEY,
    READY_IMAGE_THUMB_LOOKUP_KEY,
    READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
    READY_IMAGE_STATS_KEY,
    READY_IMAGE_ALL_INDEX_KEY
  ];
  const cardinalities = await readReadyImageCardinalities(
    touchedCardinalityKeys,
    redis
  );
  await validateIncrementalCardinalities(
    cardinalities,
    nextItemCount
  );
  await updateReadyImageIntegrity(cardinalities, redis);
  await validateReadyImageSamples(currentItems, redis);
}
