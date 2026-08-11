import { appConfig } from "@imageshow/shared";
import { logger } from "../../core/logger.ts";
import { redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import { decodeImageCursor, encodeImageCursor } from "../cursor.ts";
import {
  getReadyImageCacheCoordinatorStatus,
  reportReadyImageCacheFailure,
  withReadyImageCacheRead
} from "./coordinator.ts";
import {
  resolveReadyImageFilterIndex,
  validateReadyImageFilterIndex,
  type ReadyImageFilterIndex
} from "./filter-index.ts";
import {
  ReadyImageCoreCacheError,
  isReadyImageCoreCacheError
} from "./cache-errors.ts";
import { discardReadyImageDerivedResult } from "./derived-cache-lifecycle.ts";
import type { ImageFilterPlan } from "../filter-plan.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY
} from "./keys.ts";
import {
  parseReadyImageCacheItem,
  readyImageIdFromMember,
  readyImageMember,
  type ReadyImageCacheResult,
  type ReadyImageCacheItem
} from "./model.ts";

export type ReadyImageCachePage = {
  items: ReadyImageCacheItem[];
  total: number;
  nextCursor: string | null;
};

function cacheItemCount() {
  return getReadyImageCacheCoordinatorStatus().meta?.itemCount ?? 0;
}

function parsedItem(raw: string | null, expectedMember?: string) {
  const item = parseReadyImageCacheItem(raw);
  if (
    !item
    || (expectedMember && readyImageMember(item.id) !== expectedMember)
  ) {
    throw new ReadyImageCoreCacheError(
      "Ready-image cache returned a corrupt core item"
    );
  }
  return item;
}

async function readCache<T>(
  work: () => Promise<T>,
  scope: "core" | "derived" = "core",
  discardDerived?: () => Promise<void>
): Promise<ReadyImageCacheResult<T>> {
  try {
    const lease = await withReadyImageCacheRead(work);
    return lease.acquired
      ? { cached: true, value: lease.value }
      : { cached: false };
  } catch (error) {
    if (scope === "core" || isReadyImageCoreCacheError(error)) {
      reportReadyImageCacheFailure(error);
    } else {
      recordReadyImageCacheError("derived", "derived_read_failed", error);
      await discardDerived?.().catch(() => undefined);
      logger.warn("ready_image_derived_cache_read_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return { cached: false };
  }
}

function discardReadyImageQueryIndex(index: ReadyImageFilterIndex) {
  if (index.kind === "core") return Promise.resolve();
  return discardReadyImageDerivedResult(index.key, index.kind);
}

async function queryIndexIsValid(index: ReadyImageFilterIndex) {
  const validation = await validateReadyImageFilterIndex(index);
  if (validation === "valid") return true;
  if (validation === "invalid" && index.kind === "core") {
    throw new ReadyImageCoreCacheError(
      "Ready-image core index validation failed"
    );
  }
  return false;
}

async function readCoreItems(members: string[]) {
  try {
    return await redis.hmget(READY_IMAGE_ITEMS_KEY, ...members);
  } catch (cause) {
    throw new ReadyImageCoreCacheError(
      "Ready-image core items could not be read",
      { cause }
    );
  }
}

async function assertDerivedMissingItemsAreNotCore(
  members: string[],
  raws: Array<string | null>
) {
  const missingMembers = members.filter((_, index) => raws[index] === null);
  if (!missingMembers.length) return;
  let results: Awaited<ReturnType<typeof execRedisPipeline>>;
  try {
    const pipeline = redis.pipeline();
    pipeline.hlen(READY_IMAGE_ITEMS_KEY);
    pipeline.zcard(READY_IMAGE_ALL_INDEX_KEY);
    pipeline.zmscore(READY_IMAGE_ALL_INDEX_KEY, ...missingMembers);
    results = await execRedisPipeline(pipeline);
  } catch (cause) {
    throw new ReadyImageCoreCacheError(
      "Ready-image core item consistency could not be read",
      { cause }
    );
  }
  const expected = cacheItemCount();
  const itemCount = Number(results[0]?.[1] ?? -1);
  const allCount = Number(results[1]?.[1] ?? -1);
  const allScores = results[2]?.[1] as Array<string | null> ?? [];
  if (
    itemCount !== expected
    || allCount !== expected
    || allScores.length !== missingMembers.length
    || allScores.some((score) => score !== null)
  ) {
    throw new ReadyImageCoreCacheError(
      "Ready-image core items and index are inconsistent"
    );
  }
  throw new Error("Ready-image derived index references a missing item");
}

async function lookupItem(
  lookupKey: string,
  field: string
): Promise<ReadyImageCacheResult<ReadyImageCacheItem | null>> {
  return readCache(async () => {
    const member = await redis.hget(lookupKey, field);
    if (!member) {
      const expected = cacheItemCount();
      const actual = await redis.hlen(lookupKey);
      if (actual !== expected) {
        throw new Error(`Ready-image cache lookup ${lookupKey} is incomplete`);
      }
      return null;
    }
    if (!readyImageIdFromMember(member)) {
      throw new Error("Ready-image cache lookup contains an invalid member");
    }
    return parsedItem(await redis.hget(READY_IMAGE_ITEMS_KEY, member), member);
  });
}

export function readReadyImageByObjectKey(objectKey: string) {
  return lookupItem(READY_IMAGE_OBJECT_LOOKUP_KEY, objectKey);
}

export function readReadyImageByThumbKey(thumbKey: string) {
  return lookupItem(READY_IMAGE_THUMB_LOOKUP_KEY, thumbKey);
}

export async function readReadyImageById(
  id: string
): Promise<ReadyImageCacheResult<ReadyImageCacheItem | null>> {
  const member = readyImageMember(id);
  return readCache(async () => {
    const raw = await redis.hget(READY_IMAGE_ITEMS_KEY, member);
    if (!raw) {
      if (await redis.hlen(READY_IMAGE_ITEMS_KEY) !== cacheItemCount()) {
        throw new Error("Ready-image cache item hash is incomplete");
      }
      return null;
    }
    return parsedItem(raw, member);
  });
}

async function readPageFromIndex(
  index: ReadyImageFilterIndex,
  limit: number,
  cursor: string | undefined
): Promise<ReadyImageCacheResult<ReadyImageCachePage>> {
  const decoded = cursor !== undefined ? decodeImageCursor(cursor) : null;
  return readCache(async () => {
    if (!await queryIndexIsValid(index)) return null;
    let start = 0;
    if (decoded) {
      const member = readyImageMember(decoded.id);
      const cursorState = redis.pipeline();
      cursorState.zscore(index.key, member);
      cursorState.zrevrank(index.key, member);
      const cursorResults = await execRedisPipeline(cursorState);
      const scoreRaw = cursorResults[0]?.[1];
      const rankRaw = cursorResults[1]?.[1];
      if (scoreRaw === null || rankRaw === null) {
        // A cursor can legitimately disappear after a committed mutation.
        // PostgreSQL remains the precise fallback for that uncommon boundary.
        return null;
      }
      const score = Number(scoreRaw);
      const rank = Number(rankRaw);
      if (
        !Number.isSafeInteger(score)
        || score !== decoded.sortScore
        || !Number.isSafeInteger(rank)
        || rank < 0
      ) {
        // A changed cursor image cannot preserve PostgreSQL keyset semantics.
        return null;
      }
      start = rank + 1;
    }
    const transaction = redis.pipeline();
    transaction.zcard(index.key);
    transaction.zrevrange(index.key, start, start + limit);
    const indexResults = await execRedisPipeline(transaction);
    const total = Number(indexResults[0]?.[1] ?? 0);
    const members = indexResults[1]?.[1] as string[] ?? [];
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new Error("Ready-image cache returned an invalid page count");
    }
    if (index.count !== null && index.count !== total) {
      throw new Error("Ready-image cached filter cardinality changed");
    }
    if (!members.length) {
      return await queryIndexIsValid(index)
        ? { items: [], total, nextCursor: null }
        : null;
    }
    const raws = await readCoreItems(members);
    if (index.kind !== "core") {
      await assertDerivedMissingItemsAreNotCore(members, raws);
    }
    const allItems = raws.map((raw, position) => (
      parsedItem(raw, members[position])
    ));
    const hasNext = allItems.length > limit;
    const items = allItems.slice(0, limit);
    const last = items.at(-1);
    const value = {
      items,
      total,
      nextCursor: hasNext && last
        ? encodeImageCursor({ cursor_image_time: last.image_time, id: last.id })
        : null
    };
    return await queryIndexIsValid(index) ? value : null;
  }, index.kind === "core" ? "core" : "derived", async () => {
    await discardReadyImageQueryIndex(index);
  }).then((result) => {
    if (!result.cached || result.value === null) return { cached: false };
    return { cached: true, value: result.value };
  });
}

export async function readReadyImagePage(
  plan: ImageFilterPlan,
  limit: number,
  cursor?: string,
  signal?: AbortSignal,
  background = false
): Promise<ReadyImageCacheResult<ReadyImageCachePage>> {
  try {
    const index = await resolveReadyImageFilterIndex(plan, signal, background);
    if (!index) return { cached: false };
    return readPageFromIndex(index, limit, cursor);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (isReadyImageCoreCacheError(error)) {
      reportReadyImageCacheFailure(error);
    } else {
      recordReadyImageCacheError(
        "derived",
        "derived_filter_resolution_failed",
        error
      );
      logger.warn("ready_image_derived_filter_resolution_failed", {
        signature: plan.signature,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return { cached: false };
  }
}

export async function sampleReadyImages(
  plan: ImageFilterPlan,
  limit: number,
  recent: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
  background = false
): Promise<ReadyImageCacheResult<ReadyImageCacheItem[]>> {
  try {
    const index = await resolveReadyImageFilterIndex(plan, signal, background);
    if (!index) return { cached: false };
    const result = await readCache(async () => {
      if (!await queryIndexIsValid(index)) return null;
      const count = await redis.zcard(index.key);
      if (!count) return await queryIndexIsValid(index) ? [] : null;
      const requested = limit <= 1
        ? Math.max(8, Math.min(64, appConfig.randomDedupe.historySize + 1))
        : Math.min(count, limit + recent.size);
      const members = await redis.zrandmember(index.key, requested);
      if (!members.length) {
        await queryIndexIsValid(index);
        return null;
      }
      const raws = await readCoreItems(members);
      if (index.kind !== "core") {
        await assertDerivedMissingItemsAreNotCore(members, raws);
      }
      const fresh: ReadyImageCacheItem[] = [];
      const fallback: ReadyImageCacheItem[] = [];
      raws.forEach((raw, position) => {
        const item = parsedItem(raw, members[position]);
        (recent.has(item.id) ? fallback : fresh).push(item);
      });
      const value = [...fresh, ...fallback].slice(0, limit);
      return await queryIndexIsValid(index) ? value : null;
    }, index.kind === "core" ? "core" : "derived", async () => {
      await discardReadyImageQueryIndex(index);
    });
    if (!result.cached || result.value === null) return { cached: false };
    return { cached: true, value: result.value };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (isReadyImageCoreCacheError(error)) {
      reportReadyImageCacheFailure(error);
    } else {
      recordReadyImageCacheError(
        "derived",
        "derived_random_resolution_failed",
        error
      );
      logger.warn("ready_image_derived_random_resolution_failed", {
        signature: plan.signature,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return { cached: false };
  }
}

export async function readTargetedReadyImages(
  ids: string[]
): Promise<ReadyImageCacheResult<ReadyImageCacheItem[]>> {
  return readCache(async () => {
    const fullIds = ids.filter((id) => id.length > 12);
    const suffixes = ids.filter((id) => id.length === 12);
    const members = new Set(fullIds.map(readyImageMember));
    if (suffixes.length) {
      const pipeline = redis.pipeline();
      pipeline.zcard(READY_IMAGE_ID_SUFFIX_LOOKUP_KEY);
      for (const suffix of suffixes) {
        const score = Number.parseInt(suffix, 16);
        pipeline.zrangebyscore(
          READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
          score,
          score
        );
      }
      const results = await execRedisPipeline(pipeline);
      if (Number(results[0]?.[1] ?? 0) !== cacheItemCount()) {
        throw new Error("Ready-image cache suffix index is incomplete");
      }
      for (const result of results.slice(1)) {
        for (const member of result[1] as string[]) members.add(member);
      }
    }
    if (!members.size) return [];
    const orderedMembers = [...members];
    const pipeline = redis.pipeline();
    pipeline.hlen(READY_IMAGE_ITEMS_KEY);
    pipeline.zcard(READY_IMAGE_ALL_INDEX_KEY);
    pipeline.hmget(READY_IMAGE_ITEMS_KEY, ...orderedMembers);
    pipeline.zmscore(READY_IMAGE_ALL_INDEX_KEY, ...orderedMembers);
    const results = await execRedisPipeline(pipeline);
    const expected = cacheItemCount();
    if (
      Number(results[0]?.[1] ?? 0) !== expected
      || Number(results[1]?.[1] ?? 0) !== expected
    ) {
      throw new Error("Ready-image cache core projection is incomplete");
    }
    const raws = results[2]?.[1] as Array<string | null> ?? [];
    const scores = results[3]?.[1] as Array<string | null> ?? [];
    if (raws.length !== orderedMembers.length || scores.length !== orderedMembers.length) {
      throw new Error("Ready-image targeted lookup returned an incomplete result");
    }
    return raws.flatMap((raw, position) => {
      if (Boolean(raw) !== Boolean(scores[position])) {
        throw new Error("Ready-image targeted lookup is internally inconsistent");
      }
      if (!raw) return [];
      return [parsedItem(raw, orderedMembers[position])];
    });
  });
}
