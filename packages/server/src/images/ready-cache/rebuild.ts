import type { Redis } from "ioredis";
import { errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import { redis } from "../../core/redis-client.ts";
import { withReadyImageCacheWriteFence } from "./fence.ts";
import { READY_IMAGE_META_KEY } from "./keys.ts";
import {
  buildReadyImageCardinalities,
  validateBuiltReadyImageCache,
  writeReadyImageStatsAndIntegrity,
  type ReadyImageCardinalities,
  type ReadyImageStats
} from "./integrity.ts";
import {
  readReadyImageCacheMeta,
  rebuildingReadyImageCacheMeta,
  writeReadyImageCacheMeta
} from "./meta.ts";
import {
  READY_IMAGE_CACHE_SCHEMA,
  READY_IMAGE_REBUILD_MAX_ATTEMPTS,
  READY_IMAGE_REBUILD_QUIET_MS,
  type ReadyImageCacheItem,
  type ReadyImageCacheMeta
} from "./model.ts";
import {
  clearReadyImageCacheData,
  estimateReadyImageCacheMemory,
  writeReadyImageCacheBatch
} from "./redis-writer.ts";
import {
  compareReadyImageRevisions,
  getReadyImageRevision
} from "./revision.ts";
import { readReadyImageSourceSnapshot } from "./source.ts";
import { markReadyImageCacheLastUpdated } from "./last-updated.ts";

const SAMPLE_SIZE = 32;

async function observeReadyImageCacheMemory(
  client: Redis,
  signal?: AbortSignal
) {
  try {
    return await estimateReadyImageCacheMemory(client, signal);
  } catch (error) {
    signal?.throwIfAborted();
    logger.warn("ready_image_cache_memory_observation_failed", {
      error: errorMessage(error)
    });
    return null;
  }
}

async function clearReadyImageCacheForRebuild(
  client: Redis,
  signal?: AbortSignal
) {
  await clearReadyImageCacheData(client, signal);
}

function wait(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

function addSamples(
  samples: ReadyImageCacheItem[],
  items: ReadyImageCacheItem[],
  firstPosition: number,
  total: number
) {
  const interval = Math.max(1, Math.floor(total / SAMPLE_SIZE));
  for (let index = 0; index < items.length; index += 1) {
    const position = firstPosition + index;
    const item = items[index];
    if (
      item
      && samples.length < SAMPLE_SIZE
      && (
        position === 0
        || position === total - 1
        || position % interval === 0
      )
    ) {
      samples.push(item);
    }
  }
}

async function buildAttempt(
  previousRevision: string,
  client: Redis,
  signal?: AbortSignal
): Promise<{ changed: true } | { changed: false; meta: ReadyImageCacheMeta }> {
  const startedAt = new Date().toISOString();
  let progress = rebuildingReadyImageCacheMeta(previousRevision, startedAt);
  await withReadyImageCacheWriteFence(async () => {
    await writeReadyImageCacheMeta(progress, client, {
      lastUpdatedAt: startedAt
    });
    await clearReadyImageCacheForRebuild(client, signal);
    await writeReadyImageCacheMeta(progress, client, {
      lastUpdatedAt: new Date().toISOString()
    });
  });

  let cardinalities: ReadyImageCardinalities = buildReadyImageCardinalities(0);
  const stats: ReadyImageStats = new Map([["total", 0]]);
  const samples: ReadyImageCacheItem[] = [];
  const snapshot = await readReadyImageSourceSnapshot(
    async ({ revision, total }) => {
      cardinalities = buildReadyImageCardinalities(total);
      progress = {
        ...progress,
        appliedRevision: revision,
        total
      };
      await writeReadyImageCacheMeta(progress, client, {
        lastUpdatedAt: new Date().toISOString()
      });
    },
    async (items, state) => {
      addSamples(samples, items, state.processed - items.length, state.total);
      await writeReadyImageCacheBatch(
        items,
        cardinalities,
        stats,
        client,
        signal
      );
      progress = { ...progress, processed: state.processed };
      await client.hset(READY_IMAGE_META_KEY, {
        processed: String(state.processed)
      });
      await markReadyImageCacheLastUpdated(client);
    },
    signal
  );
  if (stats.get("total") !== snapshot.total) {
    throw new Error("Ready-image cache statistics differ from the source");
  }

  const expected = await writeReadyImageStatsAndIntegrity(
    stats,
    cardinalities,
    client,
    signal
  );
  const memoryBytes = await observeReadyImageCacheMemory(client, signal);
  await validateBuiltReadyImageCache(
    expected,
    stats,
    samples,
    client,
    signal
  );
  signal?.throwIfAborted();

  return withReadyImageCacheWriteFence(async () => {
    signal?.throwIfAborted();
    const beforePublish = (await getReadyImageRevision()).revision;
    if (compareReadyImageRevisions(snapshot.revision, beforePublish) !== 0) {
      return { changed: true };
    }
    const meta: ReadyImageCacheMeta = {
      schema: READY_IMAGE_CACHE_SCHEMA,
      state: "ready",
      appliedRevision: snapshot.revision,
      itemCount: snapshot.total,
      builtAt: new Date().toISOString(),
      startedAt,
      processed: snapshot.total,
      total: snapshot.total,
      memoryBytes,
      lastError: ""
    };
    await writeReadyImageCacheMeta(meta, client, {
      lastUpdatedAt: meta.builtAt
    });
    // Production mutations hold the same fence from before BEGIN through
    // exact Redis sync. This second read also catches direct/unfenced test or
    // operator writes that commit during the cross-system publish itself.
    const afterPublish = (await getReadyImageRevision()).revision;
    if (compareReadyImageRevisions(snapshot.revision, afterPublish) !== 0) {
      await writeReadyImageCacheMeta({
        ...progress,
        appliedRevision: afterPublish,
        lastError: "PostgreSQL changed while the cache was being published"
      }, client, { lastUpdatedAt: new Date().toISOString() });
      return { changed: true };
    }
    return { changed: false, meta };
  });
}

async function discardFailedBuild(error: unknown, client: Redis) {
  try {
    await withReadyImageCacheWriteFence(async () => {
      const current = await readReadyImageCacheMeta(client).catch(() => null);
      const fallback = current ?? rebuildingReadyImageCacheMeta("0");
      const cleanupErrors: unknown[] = [];
      try {
        // A failed fixed-namespace build is never readable. Release its memory
        // before publishing the degraded marker so no partial projection remains
        // for sessions, limits, and the next rebuild attempt.
        await clearReadyImageCacheForRebuild(client);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      try {
        const failedAt = new Date().toISOString();
        await writeReadyImageCacheMeta({
          ...fallback,
          state: "degraded",
          builtAt: failedAt,
          itemCount: 0,
          memoryBytes: null,
          lastError: errorMessage(error)
        }, client, { lastUpdatedAt: failedAt });
      } catch (metaError) {
        cleanupErrors.push(metaError);
      }
      if (cleanupErrors.length) {
        throw new AggregateError(
          cleanupErrors,
          "Failed to discard an incomplete ready-image cache build"
        );
      }
    });
  } catch (cleanupError) {
    logger.error("ready_image_cache_failed_build_cleanup_failed", {
      rebuild_error: errorMessage(error),
      cleanup_error: errorMessage(cleanupError)
    });
  }
}

export async function rebuildReadyImageCache(
  options: { signal?: AbortSignal; client?: Redis } = {}
): Promise<ReadyImageCacheMeta> {
  const client = options.client ?? redis;
  let previousRevision = (await readReadyImageCacheMeta(client).catch(() => null))
    ?.appliedRevision ?? "0";
  try {
    for (let attempt = 0; attempt < READY_IMAGE_REBUILD_MAX_ATTEMPTS; attempt += 1) {
      options.signal?.throwIfAborted();
      const result = await buildAttempt(previousRevision, client, options.signal);
      if (!result.changed) return result.meta;
      previousRevision = (await getReadyImageRevision()).revision;
      if (attempt + 1 < READY_IMAGE_REBUILD_MAX_ATTEMPTS) {
        await wait(READY_IMAGE_REBUILD_QUIET_MS, options.signal);
      }
    }
    throw new Error("Ready-image cache rebuild could not reach a stable revision");
  } catch (error) {
    await discardFailedBuild(error, client);
    throw error;
  }
}
