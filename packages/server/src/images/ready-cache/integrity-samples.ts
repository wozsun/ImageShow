import type { Redis } from "ioredis";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY
} from "./keys.ts";
import {
  parseReadyImageCacheItem,
  readyImageIdSuffixScore,
  readyImageMember,
  readyImageThumbKey,
  serializeReadyImageCacheItem,
  type ReadyImageCacheItem
} from "./model.ts";
import { REDIS_BATCH_MAX_COMMANDS } from "./redis-batch.ts";

const STARTUP_SAMPLE_SIZE = 32;

function readyImageSampleRanks(itemCount: number) {
  if (!Number.isSafeInteger(itemCount) || itemCount < 0) {
    throw new Error("Ready-image cache contains an invalid item count");
  }
  if (!itemCount) return [];
  const ranks = new Set<number>([0, itemCount - 1]);
  const interval = Math.max(1, Math.floor(itemCount / STARTUP_SAMPLE_SIZE));
  for (
    let rank = interval;
    rank < itemCount && ranks.size < STARTUP_SAMPLE_SIZE;
    rank += interval
  ) {
    ranks.add(rank);
  }
  return [...ranks].sort((left, right) => left - right);
}

export async function validateReadyImageSamples(
  samples: ReadyImageCacheItem[],
  client: Redis
) {
  let pipeline = client.pipeline();
  let validators: Array<(value: unknown) => void> = [];
  const flush = async () => {
    if (!validators.length) return;
    const results = await execRedisPipeline(pipeline);
    if (results.length !== validators.length) {
      throw new Error("Ready-image cache sample pipeline was incomplete");
    }
    results.forEach((result, index) => validators[index]?.(result[1]));
    pipeline = client.pipeline();
    validators = [];
  };
  const queue = async (
    command: () => unknown,
    validate: (value: unknown) => void
  ) => {
    command();
    validators.push(validate);
    if (validators.length >= REDIS_BATCH_MAX_COMMANDS) await flush();
  };
  for (const item of samples) {
    const member = readyImageMember(item.id);
    await queue(
      () => pipeline.hget(READY_IMAGE_ITEMS_KEY, member),
      (value) => {
        if (value !== serializeReadyImageCacheItem(item)) {
          throw new Error("Ready-image cache item sample failed validation");
        }
      }
    );
    for (const [lookup, field] of [
      [READY_IMAGE_OBJECT_LOOKUP_KEY, item.object_key],
      [READY_IMAGE_THUMB_LOOKUP_KEY, readyImageThumbKey(item)]
    ] as const) {
      await queue(
        () => pipeline.hget(lookup, field),
        (value) => {
          if (value !== member) {
            throw new Error("Ready-image cache lookup sample failed validation");
          }
        }
      );
    }
    await queue(
      () => pipeline.zscore(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, member),
      (value) => {
        if (
          value === null
          || value === undefined
          || Number(value) !== readyImageIdSuffixScore(item)
        ) {
          throw new Error("Ready-image cache suffix sample failed validation");
        }
      }
    );
    await queue(
      () => pipeline.zscore(READY_IMAGE_ALL_INDEX_KEY, member),
      (value) => {
        if (
          value === null
          || value === undefined
          || Number(value) !== item.sort_score
        ) {
          throw new Error("Ready-image cache index sample failed validation");
        }
      }
    );
  }
  await flush();
}

export async function validatePersistedReadyImageSamples(
  itemCount: number,
  client: Redis
) {
  const ranks = readyImageSampleRanks(itemCount);
  if (!ranks.length) return;

  const rankPipeline = client.pipeline();
  for (const rank of ranks) {
    rankPipeline.zrange(
      READY_IMAGE_ALL_INDEX_KEY,
      String(rank),
      String(rank)
    );
  }
  const rankResults = await execRedisPipeline(rankPipeline);
  const members = rankResults.map((result) => {
    const values = result[1] as string[];
    const member = values[0];
    if (!member || values.length !== 1) {
      throw new Error("Ready-image cache sample rank is incomplete");
    }
    return member;
  });
  const raws = await client.hmget(READY_IMAGE_ITEMS_KEY, ...members);
  const items = raws.map((raw, index) => {
    const item = parseReadyImageCacheItem(raw);
    if (!item || readyImageMember(item.id) !== members[index]) {
      throw new Error("Ready-image cache contains a corrupt item sample");
    }
    return item;
  });
  await validateReadyImageSamples(items, client);
}
