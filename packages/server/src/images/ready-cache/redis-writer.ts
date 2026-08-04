import type { Redis } from "ioredis";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  READY_IMAGE_CACHE_PREFIX,
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
  readyImageIndexKeys,
  readyImageMember,
  readyImageStatFields,
  readyImageThumbKey,
  serializeReadyImageCacheItem,
  type ReadyImageCacheItem
} from "./model.ts";
import {
  REDIS_BATCH_MAX_COMMANDS,
  REDIS_BATCH_MAX_BYTES,
  RedisPipelineBatcher,
  chunkHashEntries,
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

function chunkSortedSetMembers(members: Array<string | number>) {
  const chunks: Array<Array<string | number>> = [];
  let chunk: Array<string | number> = [];
  let bytes = 0;
  for (let index = 0; index < members.length; index += 2) {
    const score = members[index];
    const member = members[index + 1];
    if (score === undefined || member === undefined) continue;
    const entryBytes = estimatedRedisBytes(score, member);
    if (chunk.length && bytes + entryBytes > REDIS_BATCH_MAX_BYTES) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(score, member);
    bytes += entryBytes;
  }
  if (chunk.length) chunks.push(chunk);
  return chunks;
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
  const memberships = new Map<string, Array<string | number>>();
  for (const item of items) {
    const member = readyImageMember(item.id);
    itemEntries.push([member, serializeReadyImageCacheItem(item)]);
    objectEntries.push([item.object_key, member]);
    thumbEntries.push([readyImageThumbKey(item), member]);
    suffixMembers.push(readyImageIdSuffixScore(item), member);
    for (const key of readyImageIndexKeys(item)) {
      const members = memberships.get(key) ?? [];
      members.push(item.sort_score, member);
      memberships.set(key, members);
      incrementReadyImageCount(cardinalities, key);
    }
    for (const field of readyImageStatFields(item)) {
      incrementReadyImageCount(stats, field);
    }
  }

  const writer = new RedisPipelineBatcher(client);
  await queueHashEntries(READY_IMAGE_ITEMS_KEY, itemEntries, writer);
  await queueHashEntries(READY_IMAGE_OBJECT_LOOKUP_KEY, objectEntries, writer);
  await queueHashEntries(READY_IMAGE_THUMB_LOOKUP_KEY, thumbEntries, writer);
  for (const members of chunkSortedSetMembers(suffixMembers)) {
    await writer.queue(
      estimatedRedisBytes(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, ...members),
      (pipeline) => {
        pipeline.zadd(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, ...members);
      }
    );
  }
  for (const [key, allMembers] of memberships) {
    for (const members of chunkSortedSetMembers(allMembers)) {
      await writer.queue(
        estimatedRedisBytes(key, ...members),
        (pipeline) => { pipeline.zadd(key, ...members); }
      );
    }
  }
  await writer.flush();
  signal?.throwIfAborted();
}

export async function estimateReadyImageCacheMemory(
  client: Redis,
  signal?: AbortSignal
) {
  let total = 0;
  let cursor = "0";
  do {
    signal?.throwIfAborted();
    const [next, keys] = await client.scan(
      cursor,
      "MATCH",
      `${READY_IMAGE_CACHE_PREFIX}*`,
      "COUNT",
      SCAN_BATCH_SIZE
    );
    cursor = next;
    for (let offset = 0; offset < keys.length; offset += REDIS_BATCH_MAX_COMMANDS) {
      const batch = keys.slice(offset, offset + REDIS_BATCH_MAX_COMMANDS);
      const pipeline = client.pipeline();
      for (const key of batch) {
        assertReadyImageCacheKey(key);
        pipeline.call("MEMORY", "USAGE", key, "SAMPLES", "5");
      }
      const results = await execRedisPipeline(pipeline);
      for (const result of results) {
        const bytes = Number(result[1] ?? 0);
        if (!Number.isSafeInteger(bytes) || bytes < 0) {
          throw new Error("Redis returned an invalid image-cache memory estimate");
        }
        total += bytes;
        if (!Number.isSafeInteger(total)) {
          throw new Error("Ready-image cache memory estimate is too large");
        }
      }
    }
  } while (cursor !== "0");
  return total;
}
