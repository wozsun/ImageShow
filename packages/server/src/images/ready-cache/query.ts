import { logger } from "../../core/logger.ts";
import { redis } from "../../core/redis/client.ts";
import { execRedisPipeline } from "../../core/redis/pipeline.ts";
import {
  isRedisUnavailableError,
  requireOperationalRedis,
  runRequiredRedisCommand
} from "../../core/runtime-availability.ts";
import {
  encodeImageCursor,
  type ImageBrowseContext,
  type ImageBrowsePosition
} from "../cursor.ts";
import type { AdminImageSort, PublicImageOrder } from "@imageshow/shared/browser";
import {
  getReadyImageCacheCoordinatorStatus,
  reportReadyImageCacheFailure,
  withReadyImageCacheRead
} from "./coordinator.ts";
import {
  resolveReadyImageFilterIndex,
  resolveReadyImageFilterIndexForRequiredRead,
  validateReadyImageFilterIndex,
  type ReadyImageFilterIndex,
  type ReadyImageIndexReadAccess
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
  READY_IMAGE_ITEMS_KEY
} from "./keys.ts";
import {
  parseReadyImageCacheItem,
  readyImageMember,
  type ReadyImageCacheResult,
  type ReadyImageCacheItem
} from "./model.ts";
import {
  readReadyImageOrderedWindow,
  readyImageWindowIndexIsValid,
  type ReadyImageCacheWindow,
  type ReadyImagePageReadMode,
  type ReadyImageWindowDependencies
} from "./ordered-window.ts";
import { releaseReadyImageRequestIndex } from "./indexes/filter-store.ts";
import { sampleResolvedReadyImageIndex } from "./random-sampler.ts";
import { readReadyImageRandomMembers } from "./random-window.ts";

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
  if (!item
    || (expectedMember && readyImageMember(item.id) !== expectedMember)) {
    throw new ReadyImageCoreCacheError("Ready-image cache returned a corrupt core item");
  }
  return item;
}

function reportFilterResolutionFailure(
  error: unknown,
  signature: string,
  kind: "filter" | "random"
) {
  if (isReadyImageCoreCacheError(error)) {
    reportReadyImageCacheFailure(error);
    return;
  }
  const failure = kind === "filter"
    ? {
        code: "derived_filter_resolution_failed",
        event: "ready_image_derived_filter_resolution_failed"
      } as const
    : {
        code: "derived_random_resolution_failed",
        event: "ready_image_derived_random_resolution_failed"
      } as const;
  recordReadyImageCacheError("derived", failure.code, error);
  logger.warn(failure.event, { signature, error });
}

async function readCache<T>(
  work: () => Promise<T>,
  index?: ReadyImageFilterIndex,
  signal?: AbortSignal
): Promise<ReadyImageCacheResult<T>> {
  try {
    const lease = await withReadyImageCacheRead(work);
    return lease.acquired
      ? { cached: true, value: lease.value }
      : { cached: false };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (isRedisUnavailableError(error)) throw error;
    if (!index || index.kind === "core" || isReadyImageCoreCacheError(error)) {
      reportReadyImageCacheFailure(error);
    } else {
      recordReadyImageCacheError("derived", "derived_read_failed", error);
      await discardReadyImageQueryIndex(index).catch(() => undefined);
      logger.warn("ready_image_derived_cache_read_failed", {
        error: error
      });
    }
    return { cached: false };
  }
}

function discardReadyImageQueryIndex(index: ReadyImageFilterIndex) {
  if (index.kind === "core") return Promise.resolve();
  if (index.temporaryToken) return releaseReadyImageRequestIndex(index);
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
    throw new ReadyImageCoreCacheError("Ready-image core item consistency could not be read", {
      cause
    });
  }
  const expected = cacheItemCount();
  const itemCount = Number(results[0]?.[1] ?? -1);
  const allCount = Number(results[1]?.[1] ?? -1);
  const allScores = (results[2]?.[1] as Array<string | null>) ?? [];
  if (
    itemCount !== expected ||
    allCount !== expected ||
    allScores.length !== missingMembers.length ||
    allScores.some((score) => score !== null)
  ) {
    throw new ReadyImageCoreCacheError("Ready-image core items and index are inconsistent");
  }
  throw new Error("Ready-image derived index references a missing item");
}

export async function readReadyImageById(
  id: string
): Promise<ReadyImageCacheResult<ReadyImageCacheItem | null>> {
  const member = readyImageMember(id);
  return readCache(async () => {
    const raw = await redis.hget(READY_IMAGE_ITEMS_KEY, member);
    if (!raw) {
      if ((await redis.hlen(READY_IMAGE_ITEMS_KEY)) !== cacheItemCount()) {
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
  decoded: ImageBrowsePosition | undefined,
  order: PublicImageOrder,
  mode: ReadyImagePageReadMode
) {
  if (decoded === undefined) return 0;
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
  return Number.isSafeInteger(score) &&
    score === decoded.sortScore &&
    Number.isSafeInteger(rank) &&
    rank >= 0
    ? rank + 1
    : null;
}

function readyImageWindowDependencies(order: PublicImageOrder): ReadyImageWindowDependencies {
  return {
    validate: validateReadyImageFilterIndex,
    members: (index, start, stop) =>
      order === "oldest"
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
    const result = await readCache(
      async () => {
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
      },
      index
    );
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
        error
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
  access: ReadyImageIndexReadAccess,
  read?: (index: ReadyImageFilterIndex) => Promise<ReadyImagePageReadResult<T>>
): Promise<ReadyImagePageReadResult<T>> {
  try {
    const index =
      access.mode === "required"
        ? await resolveReadyImageFilterIndexForRequiredRead(plan)
        : await resolveReadyImageFilterIndex(plan, access.signal);
    if (!index) return { status: "fallback" };
    if (read) return await read(index);
    return readPageFromIndex(
      index,
      (readMode) => locate(index, readMode),
      limit,
      order,
      access.mode
    );
  } catch (error) {
    if (access.mode === "fallback" && access.signal.aborted) {
      throw access.signal.reason ?? error;
    }
    if (isRedisUnavailableError(error)) {
      return {
        status: "redis_unavailable",
        error
      };
    }
    reportFilterResolutionFailure(error, plan.signature, "filter");
    return { status: "fallback" };
  }
}

async function readRandomWindowFromIndex(
  index: ReadyImageFilterIndex,
  context: Pick<ImageBrowseContext, "start">,
  position: ImageBrowsePosition | undefined,
  limit: number,
  signal: AbortSignal
) {
  return readCache(
    async () => {
      if (!readyImageWindowIndexIsValid(index, await validateReadyImageFilterIndex(index)))
        return null;
      const members = await readReadyImageRandomMembers(
        index,
        context,
        position,
        limit,
        cacheItemCount(),
        signal
      );
      if (!members) return null;
      const visible = members.slice(0, limit);
      const raws = visible.length ? await readCoreItems(visible) : [];
      if (raws.length !== visible.length) {
        throw new ReadyImageCoreCacheError("Ready-image cache returned incomplete core items");
      }
      if (index.kind !== "core" && visible.length) {
        await assertDerivedMissingItemsAreNotCore(visible, raws);
      }
      const items = raws.map((raw, offset) => parsedItem(raw, visible[offset]));
      if (!readyImageWindowIndexIsValid(index, await validateReadyImageFilterIndex(index)))
        return null;
      return { items, total: index.count ?? items.length, hasMore: members.length > limit };
    },
    index,
    signal
  );
}

export function readReadyImageCursorPage(
  plan: ImageFilterPlan,
  limit: number,
  context: ImageBrowseContext,
  position: ImageBrowsePosition | undefined,
  signal: AbortSignal
): Promise<ReadyImagePageReadResult<ReadyImageCachePage>> {
  return resolvedReadyImagePage<ReadyImageCachePage>(
    plan,
    async (index, mode) => {
      const start = await cursorWindowStart(index, position, context.order, mode);
      if (start === null) return null;
      return {
        start,
        present: (window) => {
          const last = window.items.at(-1);
          return {
            ...window,
            nextCursor:
              start + window.items.length < window.total && last
                ? encodeImageCursor(
                    {
                      sort_score: last.sort_score,
                      id: last.id
                    },
                    context
                  )
                : null
          };
        }
      };
    },
    limit,
    context.order,
    { mode: "fallback", signal },
    context.order === "random"
      ? async (index) => {
          const result = await readRandomWindowFromIndex(index, context, position, limit, signal);
          if (!result.cached || result.value === null) return { status: "fallback" };
          const { items, total, hasMore } = result.value;
          const last = items.at(-1);
          return {
            status: "hit",
            value: {
              items,
              total,
              nextCursor:
                hasMore && last
                  ? encodeImageCursor({ id: last.id, sort_score: last.sort_score }, context)
                  : null
            }
          };
        }
      : undefined
  );
}

export function readReadyImagePageWindow(
  plan: ImageFilterPlan,
  window: PageWindow,
  order: AdminImageSort["order"] = "latest"
): Promise<ReadyImagePageReadResult<ReadyImageCacheWindow>> {
  return resolvedReadyImagePage(
    plan,
    async () => ({
      start: window.start,
      present: (value) => value
    }),
    window.limit,
    order,
    { mode: "required" }
  );
}

export async function sampleReadyImages(
  plan: ImageFilterPlan,
  limit: number,
  recent: ReadonlySet<string>,
  signal: AbortSignal,
  seededStart?: number
): Promise<ReadyImageCacheResult<ReadyImageCacheItem[]>> {
  let index: ReadyImageFilterIndex | null = null;
  try {
    index = await resolveReadyImageFilterIndex(plan, signal);
    if (!index) return { cached: false };
    if (seededStart !== undefined) {
      const result = await readRandomWindowFromIndex(
        index,
        { start: seededStart },
        undefined,
        limit,
        signal
      );
      return result.cached && result.value !== null
        ? { cached: true, value: result.value.items }
        : { cached: false };
    }
    const result = await readCache(
      () => sampleResolvedReadyImageIndex(
        index!,
        limit,
        recent
      ),
      index,
      signal
    );
    if (!result.cached || result.value === null) return { cached: false };
    return { cached: true, value: result.value };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    reportFilterResolutionFailure(error, plan.signature, "random");
    return { cached: false };
  } finally {
    await releaseReadyImageRequestIndex(index);
  }
}
