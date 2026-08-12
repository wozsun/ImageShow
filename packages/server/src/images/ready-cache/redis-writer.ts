import type { Redis } from "ioredis";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_CACHE_PREFIX,
  READY_IMAGE_CORE_KEYS,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_META_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY,
  assertReadyImageCacheKey
} from "./keys.ts";
import {
  incrementReadyImageCount,
  type ReadyImageCardinalities,
  type ReadyImageStats
} from "./integrity.ts";
import {
  readyImageIdSuffixScore,
  readyImageMember,
  readyImageStatFields,
  readyImageThumbKey,
  serializeReadyImageCacheItem,
  type ReadyImageCacheItem
} from "./model.ts";
import {
  RedisPipelineBatcher,
  chunkHashEntries,
  chunkSortedSetEntries,
  estimatedRedisBytes
} from "./redis-batch.ts";

const SCAN_BATCH_SIZE = 1_000;

export async function clearReadyImageCacheData(
  client: Redis,
  signal?: AbortSignal
) {
  // Deleting while SCAN advances can move hash-table buckets. Repeat complete
  // passes until one observes only the retained meta key, so a rebuild cannot
  // accidentally publish over an owned key skipped by an earlier pass.
  let removedInPass: number;
  do {
    let cursor = "0";
    removedInPass = 0;
    do {
      signal?.throwIfAborted();
      const [nextCursor, scanned] = await client.scan(
        cursor,
        "MATCH",
        `${READY_IMAGE_CACHE_PREFIX}*`,
        "COUNT",
        SCAN_BATCH_SIZE
      );
      cursor = nextCursor;
      const keys = [...new Set(scanned)].filter((key) => (
        key !== READY_IMAGE_META_KEY
      ));
      for (const key of keys) assertReadyImageCacheKey(key);
      if (keys.length) {
        removedInPass += await client.unlink(...keys);
      }
    } while (cursor !== "0");
  } while (removedInPass > 0);
  signal?.throwIfAborted();
}

async function queueHashEntries(
  key: string,
  entries: Iterable<readonly [string, string]>,
  writer: RedisPipelineBatcher
) {
  for (const chunk of chunkHashEntries(entries)) {
    const flat = chunk.flat();
    await writer.queue(
      estimatedRedisBytes(key, ...flat),
      (pipeline) => { pipeline.hset(key, ...flat); }
    );
  }
}

function* sortedSetEntries(members: Array<string | number>) {
  for (let index = 0; index < members.length; index += 2) {
    const score = members[index];
    const member = members[index + 1];
    if (score === undefined || member === undefined) continue;
    yield [score, String(member)] as const;
  }
}

export async function writeReadyImageCacheBatch(
  items: ReadyImageCacheItem[],
  cardinalities: ReadyImageCardinalities,
  stats: ReadyImageStats,
  client: Redis,
  signal?: AbortSignal
) {
  if (!items.length) return;
  signal?.throwIfAborted();
  const itemEntries: Array<readonly [string, string]> = [];
  const objectEntries: Array<readonly [string, string]> = [];
  const thumbEntries: Array<readonly [string, string]> = [];
  const suffixMembers: Array<string | number> = [];
  const allIndexMembers: Array<string | number> = [];
  for (const item of items) {
    const member = readyImageMember(item.id);
    itemEntries.push([member, serializeReadyImageCacheItem(item)]);
    objectEntries.push([item.object_key, member]);
    thumbEntries.push([readyImageThumbKey(item), member]);
    suffixMembers.push(readyImageIdSuffixScore(item), member);
    allIndexMembers.push(item.sort_score, member);
    incrementReadyImageCount(cardinalities, READY_IMAGE_ALL_INDEX_KEY);
    for (const field of readyImageStatFields(item)) {
      incrementReadyImageCount(stats, field);
    }
  }

  const writer = new RedisPipelineBatcher(client);
  await queueHashEntries(READY_IMAGE_ITEMS_KEY, itemEntries, writer);
  await queueHashEntries(READY_IMAGE_OBJECT_LOOKUP_KEY, objectEntries, writer);
  await queueHashEntries(READY_IMAGE_THUMB_LOOKUP_KEY, thumbEntries, writer);
  for (const entries of chunkSortedSetEntries(
    READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
    sortedSetEntries(suffixMembers)
  )) {
    const members = entries.flat();
    await writer.queue(
      estimatedRedisBytes(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, ...members),
      (pipeline) => {
        pipeline.zadd(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, ...members);
      }
    );
  }
  for (const entries of chunkSortedSetEntries(
    READY_IMAGE_ALL_INDEX_KEY,
    sortedSetEntries(allIndexMembers)
  )) {
    const members = entries.flat();
    await writer.queue(
      estimatedRedisBytes(READY_IMAGE_ALL_INDEX_KEY, ...members),
      (pipeline) => {
        pipeline.zadd(READY_IMAGE_ALL_INDEX_KEY, ...members);
      }
    );
  }
  await writer.flush();
  signal?.throwIfAborted();
}

export async function measureReadyImageCoreMemory(
  client: Redis,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const pipeline = client.pipeline();
  for (const key of READY_IMAGE_CORE_KEYS) {
    assertReadyImageCacheKey(key);
    pipeline.call("MEMORY", "USAGE", key, "SAMPLES", "0");
  }
  const results = await execRedisPipeline(pipeline);
  let total = 0;
  for (const result of results) {
    const bytes = Number(result[1] ?? 0);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error("Redis returned invalid ready-image core memory usage");
    }
    total += bytes;
    if (!Number.isSafeInteger(total)) {
      throw new Error("Ready-image core memory usage is too large");
    }
  }
  signal?.throwIfAborted();
  return total;
}
