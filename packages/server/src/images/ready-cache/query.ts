import { logger } from "../../core/logger.ts";
import { redis } from "../../core/redis/client.ts";
import { execRedisPipeline } from "../../core/redis/pipeline.ts";
import {
  isRedisUnavailableError,
  requireOperationalRedis,
  runRequiredRedisCommand
} from "../../core/runtime-availability.ts";
import { decodeImageCursor, encodeImageCursor } from "../cursor.ts";
import type { PublicImageOrder } from "@imageshow/shared/browser";
import {
  getReadyImageCacheCoordinatorStatus,
  reportReadyImageCacheFailure,
  withReadyImageCacheRead
} from "./coordinator.ts";
import {
  resolveReadyImageFilterIndex,
  resolveReadyImageFilterIndexForRequiredRead,
  validateReadyImageFilterIndex,
  type ReadyImageFilterIndex
} from "./indexes/filter.ts";
import {
  ReadyImageCoreCacheError,
  isReadyImageCoreCacheError
} from "./cache-errors.ts";
import { discardReadyImageDerivedResult } from "./derived/lifecycle.ts";
import type { ImageFilterPlan } from "../filter-plan.ts";
import type { PageWindow } from "../page-window.ts";
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
import {
  readReadyImageOrderedWindow,
  type ReadyImageCacheWindow,
  type ReadyImagePageReadMode,
  type ReadyImageWindowDependencies
} from "./ordered-window.ts";
import { sampleResolvedReadyImageIndex } from "./random-sampler.ts";

export type ReadyImageCachePage = {
  items: ReadyImageCacheItem[];
  total: number;
  nextCursor: string | null;
};

export type ReadyImagePageReadResult<T> =
  | { status: "hit"; value: T }
  | { status: "fallback" }
  | { status: "redis_unavailable"; error: Error };

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
    if (isRedisUnavailableError(error)) throw error;
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

function executePageRedisCommand<T>(
  mode: ReadyImagePageReadMode,
  work: () => Promise<T>
) {
  return mode === "required" ? runRequiredRedisCommand(work) : work();
}

async function cursorWindowStart(
  index: ReadyImageFilterIndex,
  cursor: string | undefined,
  order: PublicImageOrder,
  mode: ReadyImagePageReadMode
) {
  if (cursor === undefined) return 0;
  const decoded = decodeImageCursor(cursor);
  const member = readyImageMember(decoded.id);
  const cursorState = redis.pipeline();
  cursorState.zscore(index.key, member);
  if (order === "oldest") cursorState.zrank(index.key, member);
  else cursorState.zrevrank(index.key, member);
  const cursorResults = await executePageRedisCommand(
    mode,
    () => execRedisPipeline(cursorState)
  );
  const scoreRaw = cursorResults[0]?.[1];
  const rankRaw = cursorResults[1]?.[1];
  if (scoreRaw === null || rankRaw === null) return null;
  const score = Number(scoreRaw);
  const rank = Number(rankRaw);
  return Number.isSafeInteger(score)
    && score === decoded.sortScore
    && Number.isSafeInteger(rank)
    && rank >= 0
    ? rank + 1
    : null;
}

function readyImageWindowDependencies(
  order: PublicImageOrder
): ReadyImageWindowDependencies {
  return {
    validate: validateReadyImageFilterIndex,
    count: (index) => redis.zcard(index.key),
    members: (index, start, stop) => order === "oldest"
      ? redis.zrange(index.key, String(start), String(stop))
      : redis.zrevrange(index.key, start, stop),
    items: readCoreItems,
    assertDerivedItems: assertDerivedMissingItemsAreNotCore
  };
}

async function readPageFromIndex<T>(
  index: ReadyImageFilterIndex,
  locate: (mode: ReadyImagePageReadMode) => Promise<{
    start: number;
    present: (window: ReadyImageCacheWindow) => T;
  } | null>,
  limit: number,
  order: PublicImageOrder,
  mode: ReadyImagePageReadMode
): Promise<ReadyImagePageReadResult<T>> {
  try {
    const result = await readCache(async () => {
      const location = await locate(mode);
      if (!location) return null;
      const window = await readReadyImageOrderedWindow(
        index,
        location.start,
        limit,
        mode,
        readyImageWindowDependencies(order)
      );
      return window ? location.present(window) : null;
    }, index.kind === "core" ? "core" : "derived", async () => {
      await discardReadyImageQueryIndex(index);
    });
    if (!result.cached || result.value === null) {
      // A rebuilding/revision transition is a legitimate fallback, but a
      // connection loss that invalidated the read lease remains a hard 503.
      if (mode === "required") await requireOperationalRedis();
      return { status: "fallback" };
    }
    return { status: "hit", value: result.value };
  } catch (error) {
    if (isRedisUnavailableError(error)) {
      return {
        status: "redis_unavailable",
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
    throw error;
  }
}

async function resolvedReadyImagePage<T>(
  plan: ImageFilterPlan,
  locate: (
    index: ReadyImageFilterIndex,
    mode: ReadyImagePageReadMode
  ) => Promise<{
    start: number;
    present: (window: ReadyImageCacheWindow) => T;
  } | null>,
  limit: number,
  order: PublicImageOrder,
  signal: AbortSignal | undefined,
  background: boolean,
  mode: ReadyImagePageReadMode
): Promise<ReadyImagePageReadResult<T>> {
  try {
    const index = mode === "required"
      ? await resolveReadyImageFilterIndexForRequiredRead(plan)
      : await resolveReadyImageFilterIndex(plan, signal, background);
    if (!index) return { status: "fallback" };
    return readPageFromIndex(
      index,
      (readMode) => locate(index, readMode),
      limit,
      order,
      mode
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (isRedisUnavailableError(error)) {
      return {
        status: "redis_unavailable",
        error: error instanceof Error ? error : new Error(String(error))
      };
    }
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
    return { status: "fallback" };
  }
}

export function readReadyImageCursorPage(
  plan: ImageFilterPlan,
  limit: number,
  order: PublicImageOrder,
  cursor?: string,
  signal?: AbortSignal,
  background = false
): Promise<ReadyImagePageReadResult<ReadyImageCachePage>> {
  return resolvedReadyImagePage(
    plan,
    async (index, mode) => {
      const start = await cursorWindowStart(index, cursor, order, mode);
      if (start === null) return null;
      return {
        start,
        present: (window) => {
          const last = window.items.at(-1);
          return {
            ...window,
            nextCursor: start + window.items.length < window.total && last
              ? encodeImageCursor({
                  cursor_image_time: last.image_time,
                  id: last.id
                })
              : null
          };
        }
      };
    },
    limit,
    order,
    signal,
    background,
    "fallback"
  );
}

export function readReadyImagePageWindow(
  plan: ImageFilterPlan,
  window: PageWindow
): Promise<ReadyImagePageReadResult<ReadyImageCacheWindow>> {
  return resolvedReadyImagePage(
    plan,
    async () => ({
      start: window.start,
      present: (value) => value
    }),
    window.limit,
    "latest",
    undefined,
    false,
    "required"
  );
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
    const result = await readCache(
      () => sampleResolvedReadyImageIndex(
        index,
        limit,
        recent
      ),
      index.kind === "core" ? "core" : "derived",
      async () => {
        await discardReadyImageQueryIndex(index);
      }
    );
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
