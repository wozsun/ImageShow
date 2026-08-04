import { redis } from "../../core/redis-client.ts";
import {
  getReadyImageCacheCoordinatorStatus,
  reportReadyImageCacheFailure,
  withReadyImageCacheRead
} from "./coordinator.ts";
import {
  discardReadyImageStatsResult,
  storeReadyImageStatsResult,
  touchReadyImageStatsResult
} from "./derived-cache-policy.ts";
import {
  handleReadyImageDerivedCacheError,
  readyImageDerivedCacheHasHeadroom
} from "./memory-pressure.ts";
import { withReadyImageCacheWriteFence } from "./fence.ts";
import {
  readyImageFilterPlanWithout,
  type ReadyImageFilterPlan
} from "./filters.ts";
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
  resolveReadyImageCountIndexes
} from "./filtered-counts.ts";

export type { ReadyImageCountSnapshot } from "./count-model.ts";

const STATS_RESULT_TTL_SECONDS = 24 * 60 * 60;

async function readCachedCountSnapshot(
  key: string,
  revision: string,
  expectedTotal: number
) {
  const lease = await withReadyImageCacheRead(async () => {
    if (
      getReadyImageCacheCoordinatorStatus().meta?.appliedRevision !== revision
    ) {
      return null;
    }
    const raw = await redis.getex(
      key,
      "EX",
      STATS_RESULT_TTL_SECONDS
    );
    const cached = parseCachedReadyImageCountSnapshot(raw);
    if (
      !cached
      || cached.revision !== revision
      || cached.value.total !== expectedTotal
      || cached.value.matching > expectedTotal
    ) {
      if (raw !== null) await discardReadyImageStatsResult(key);
      return null;
    }
    await touchReadyImageStatsResult(key);
    return cached.value;
  });
  return lease.acquired ? lease.value : null;
}

export async function readReadyImageCountSnapshot(
  plan: ReadyImageFilterPlan
): Promise<ReadyImageCacheResult<ReadyImageCountSnapshot>> {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
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

      const plans = [
        plan,
        readyImageFilterPlanWithout(plan, "device"),
        readyImageFilterPlanWithout(plan, "brightness"),
        readyImageFilterPlanWithout(plan, "theme"),
        readyImageFilterPlanWithout(plan, "tag"),
        readyImageFilterPlanWithout(plan, "author")
      ];
      const indexes = await resolveReadyImageCountIndexes(plans);
      if (!indexes) return { cached: false };
      const lease = await withReadyImageCacheRead(async () => {
        const current = getReadyImageCacheCoordinatorStatus();
        if (current.meta?.appliedRevision !== revision) return null;
        const stats = parseReadyImageGlobalStats(
          await redis.hgetall(READY_IMAGE_STATS_KEY),
          current.meta.itemCount
        );
        const value = isUnfilteredReadyImagePlan(plan)
          ? readyImageSnapshotFromGlobalStats(stats)
          : await buildFilteredReadyImageCountSnapshot(plan, indexes, stats);
        if (!value) return null;
        return value;
      });
      if (lease.acquired && lease.value) {
        const value = lease.value;
        if (await readyImageDerivedCacheHasHeadroom()) {
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
              STATS_RESULT_TTL_SECONDS
            );
          });
        }
        return { cached: true, value };
      }
    }
    return { cached: false };
  } catch (error) {
    if (await handleReadyImageDerivedCacheError(error)) {
      return { cached: false };
    }
    reportReadyImageCacheFailure(error);
    return { cached: false };
  }
}
