import { redis } from "../../core/redis-client.ts";
import { logger } from "../../core/logger.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import {
  getReadyImageCacheCoordinatorStatus,
  reportReadyImageCacheFailure,
  withReadyImageCacheRead
} from "./coordinator.ts";
import {
  discardReadyImageDerivedResult,
  storeReadyImageStatsResult,
  touchReadyImageStatsResult
} from "./derived-cache-lifecycle.ts";
import {
  READY_IMAGE_DERIVED_CACHE_POLICY
} from "./derived-cache-policy.ts";
import {
  ReadyImageCoreCacheError,
  isReadyImageCoreCacheError
} from "./cache-errors.ts";
import { withReadyImageCacheWriteFence } from "./fence.ts";
import {
  ensureReadyImageAttributeIndexes,
  readReadyImageSourceIndexStates
} from "./attribute-index.ts";
import type { ImageFilterPlan } from "../filter-plan.ts";
import {
  READY_IMAGE_STATS_KEY,
  readyImageStatsResultKey
} from "./keys.ts";
import type { ReadyImageCacheResult } from "./model.ts";
import {
  isUnfilteredReadyImagePlan,
  parseCachedReadyImageCountSnapshot,
  parseReadyImageGlobalStats,
  readyImageSnapshotFromGlobalStats,
  type CachedReadyImageCountSnapshot,
  type ReadyImageCountSnapshot
} from "./count-model.ts";
import {
  buildFilteredReadyImageCountSnapshot,
  preflightReadyImageCountSnapshotWork,
  resolveReadyImageCountIndexes
} from "./filtered-counts.ts";
import { recordReadyImageCacheError } from "./status-observability.ts";

export type { ReadyImageCountSnapshot } from "./count-model.ts";

async function readCachedCountSnapshot(
  key: string,
  revision: string,
  expectedTotal: number
) {
  try {
    const lease = await withReadyImageCacheRead(async () => {
      if (
        getReadyImageCacheCoordinatorStatus().meta?.appliedRevision !== revision
      ) {
        return null;
      }
      const pipeline = redis.pipeline();
      pipeline.get(key);
      pipeline.ttl(key);
      const results = await execRedisPipeline(pipeline);
      const raw = results[0]?.[1] as string | null ?? null;
      const ttl = Number(results[1]?.[1] ?? -2);
      if (
        raw !== null
        && Buffer.byteLength(raw, "utf8")
          > READY_IMAGE_DERIVED_CACHE_POLICY.maxStatsResultBytes
      ) {
        await discardReadyImageDerivedResult(key, "stats-result");
        return null;
      }
      const cached = parseCachedReadyImageCountSnapshot(raw);
      if (
        !cached
        || !Number.isSafeInteger(ttl)
        || ttl <= 0
        || cached.revision !== revision
        || cached.value.total !== expectedTotal
        || cached.value.matching > expectedTotal
      ) {
        await discardReadyImageDerivedResult(key, "stats-result");
        return null;
      }
      if (!await touchReadyImageStatsResult(key, raw!, expectedTotal)) {
        await discardReadyImageDerivedResult(key, "stats-result");
        return null;
      }
      return cached.value;
    });
    return lease.acquired ? lease.value : null;
  } catch (error) {
    recordReadyImageCacheError(
      "derived",
      "derived_stats_result_read_failed",
      error
    );
    await discardReadyImageDerivedResult(key, "stats-result")
      .catch(() => undefined);
    logger.warn("ready_image_derived_stats_result_discarded", {
      key,
      error: error instanceof Error ? error.message : String(error)
    });
    return null;
  }
}

function parseCoreStats(raw: Record<string, string>, expectedTotal: number) {
  try {
    return parseReadyImageGlobalStats(raw, expectedTotal);
  } catch (cause) {
    throw new ReadyImageCoreCacheError(
      "Ready-image core statistics are invalid",
      { cause }
    );
  }
}

async function readCoreStats(expectedTotal: number) {
  try {
    return parseCoreStats(
      await redis.hgetall(READY_IMAGE_STATS_KEY),
      expectedTotal
    );
  } catch (cause) {
    if (isReadyImageCoreCacheError(cause)) throw cause;
    throw new ReadyImageCoreCacheError(
      "Ready-image core statistics could not be read",
      { cause }
    );
  }
}

async function readGlobalStats(revision: string, expectedTotal: number) {
  const lease = await withReadyImageCacheRead(async () => {
    const current = getReadyImageCacheCoordinatorStatus();
    if (current.meta?.appliedRevision !== revision) return null;
    return readCoreStats(expectedTotal);
  });
  return lease.acquired ? lease.value : null;
}

export async function readReadyImageCountSnapshot(
  plan: ImageFilterPlan,
  signal?: AbortSignal
): Promise<ReadyImageCacheResult<ReadyImageCountSnapshot>> {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal?.throwIfAborted();
      const status = getReadyImageCacheCoordinatorStatus();
      const meta = status.readable && status.meta?.state === "ready"
        ? status.meta
        : null;
      if (!meta) return { cached: false };
      const revision = meta.appliedRevision;
      const key = readyImageStatsResultKey(plan.signature);
      const cached = await readCachedCountSnapshot(
        key,
        revision,
        meta.itemCount
      );
      if (cached) return { cached: true, value: cached };

      const initialStats = await readGlobalStats(revision, meta.itemCount);
      if (!initialStats) continue;
      if (isUnfilteredReadyImagePlan(plan)) {
        const value = readyImageSnapshotFromGlobalStats(initialStats);
        await storeCountSnapshot(key, revision, value);
        return { cached: true, value };
      }

      const preflight = preflightReadyImageCountSnapshotWork(
        plan,
        initialStats
      );
      if (!("candidates" in preflight)) {
        logger.debug("ready_image_stats_work_rejected", {
          signature: plan.signature,
          phase: "preflight",
          reason: preflight.admission.reason,
          ...preflight.admission.estimate
        });
        return { cached: false };
      }
      const candidateKeys = preflight.candidates.all;
      if (!await ensureReadyImageAttributeIndexes(
        candidateKeys,
        revision,
        signal
      )) {
        return { cached: false };
      }

      const plans = Object.values(preflight.plans);
      const indexes = await resolveReadyImageCountIndexes(plans, signal);
      if (!indexes) return { cached: false };
      const lease = await withReadyImageCacheRead(async () => {
        const current = getReadyImageCacheCoordinatorStatus();
        if (current.meta?.appliedRevision !== revision) return null;
        const stats = await readCoreStats(current.meta.itemCount);
        const sourceStates = await readReadyImageSourceIndexStates(
          candidateKeys,
          revision
        );
        if (!sourceStates) {
          return null;
        }
        const value = await buildFilteredReadyImageCountSnapshot(
          plan,
          indexes,
          stats,
          sourceStates
        );
        if (!value) return null;
        const currentStates = await readReadyImageSourceIndexStates(
          candidateKeys,
          revision
        );
        if (
          !currentStates
          || [...sourceStates].some(([sourceKey, sourceState]) => (
            currentStates.get(sourceKey)?.count !== sourceState.count
            || currentStates.get(sourceKey)?.instanceToken
              !== sourceState.instanceToken
          ))
        ) {
          return null;
        }
        return value;
      });
      if (!lease.acquired || !lease.value) return { cached: false };
      const value = lease.value;
      await storeCountSnapshot(key, revision, value);
      return { cached: true, value };
    }
    return { cached: false };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (isReadyImageCoreCacheError(error)) {
      reportReadyImageCacheFailure(error);
    } else {
      recordReadyImageCacheError(
        "derived",
        "derived_stats_build_failed",
        error
      );
      logger.warn("ready_image_derived_stats_failed", {
        signature: plan.signature,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return { cached: false };
  }
}

async function storeCountSnapshot(
  key: string,
  revision: string,
  value: ReadyImageCountSnapshot
) {
  await withReadyImageCacheWriteFence(async () => {
    const current = getReadyImageCacheCoordinatorStatus();
    if (
      !current.readable
      || current.meta?.state !== "ready"
      || current.meta.appliedRevision !== revision
    ) {
      return;
    }
    await storeReadyImageStatsResult(
      key,
      JSON.stringify({
        revision,
        value
      } satisfies CachedReadyImageCountSnapshot),
      current.meta.itemCount
    );
  });
}
