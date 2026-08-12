import {
  completeReadyImageCacheMutation,
  getReadyImageCacheCoordinatorStatus
} from "./coordinator.ts";
import {
  getRedisConnectionState,
  redis
} from "../../core/redis-client.ts";
import {
  applyReadyImageCacheDelta,
  readPreviousReadyImageCacheItems
} from "./incremental-projection.ts";
import {
  readReadyImageCacheMeta,
  writeReadyImageCacheMeta
} from "./meta.ts";
import {
  READY_IMAGE_INCREMENTAL_LIMIT,
  type ReadyImageCacheMeta
} from "./model.ts";
import {
  compareReadyImageRevisions,
  getReadyImageRevision
} from "./revision.ts";
import { readReadyImageSourceItems } from "./source.ts";
import {
  publishReadyImageStatsIntegrity,
  validateReadyImageStatsIntegrity
} from "./integrity-manifest.ts";

function assertRedisConnectionEpoch(epoch: number) {
  const connection = getRedisConnectionState();
  if (!connection.ready || connection.epoch !== epoch) {
    throw new Error("Redis connection changed during incremental synchronization");
  }
}

function nextMeta(
  previous: ReadyImageCacheMeta,
  revision: string,
  itemCount: number,
  lastUpdatedAt: string
): ReadyImageCacheMeta {
  return {
    ...previous,
    state: "ready",
    appliedRevision: revision,
    itemCount,
    lastUpdatedAt,
    processed: 0,
    total: 0,
    lastError: ""
  };
}

export async function synchronizeReadyImageCacheMutation(
  affectedIds: readonly string[],
  committedRevision: string
) {
  const ids = [...new Set(affectedIds.map((id) => id.toLowerCase()))];
  if (!ids.length) return null;
  const status = getReadyImageCacheCoordinatorStatus();
  if (!status.readable || status.meta?.state !== "ready") {
    throw new Error("Ready-image cache was unavailable before the mutation");
  }
  const connection = getRedisConnectionState();
  if (!connection.ready) {
    throw new Error("Redis connection was unavailable before the mutation");
  }
  const redisConnectionEpoch = connection.epoch;
  const persistedMeta = await readReadyImageCacheMeta();
  if (
    !persistedMeta
    || persistedMeta.state !== "ready"
    || persistedMeta.appliedRevision !== status.meta.appliedRevision
    || compareReadyImageRevisions(
      persistedMeta.appliedRevision,
      committedRevision
    ) >= 0
  ) {
    throw new Error("Ready-image cache revision cannot accept the mutation");
  }
  if ((await getReadyImageRevision()).revision !== committedRevision) {
    throw new Error("PostgreSQL revision changed before Redis synchronization");
  }
  assertRedisConnectionEpoch(redisConnectionEpoch);
  const expectedStats = await validateReadyImageStatsIntegrity(null, redis);
  if (expectedStats.get("total") !== persistedMeta.itemCount) {
    throw new Error("Ready-image cache total statistic differs before mutation");
  }

  let nextItemCount = persistedMeta.itemCount;
  for (
    let offset = 0;
    offset < ids.length;
    offset += READY_IMAGE_INCREMENTAL_LIMIT
  ) {
    const chunk = ids.slice(offset, offset + READY_IMAGE_INCREMENTAL_LIMIT);
    const [previousItems, currentItems] = await Promise.all([
      readPreviousReadyImageCacheItems(chunk),
      readReadyImageSourceItems(chunk)
    ]);
    nextItemCount = nextItemCount
      - previousItems.length
      + currentItems.length;
    if (!Number.isSafeInteger(nextItemCount) || nextItemCount < 0) {
      throw new Error("Ready-image incremental item count is invalid");
    }
    await applyReadyImageCacheDelta(
      previousItems,
      currentItems,
      nextItemCount,
      expectedStats
    );
    assertRedisConnectionEpoch(redisConnectionEpoch);
  }

  await publishReadyImageStatsIntegrity(expectedStats, redis);
  assertRedisConnectionEpoch(redisConnectionEpoch);
  const meta = nextMeta(
    persistedMeta,
    committedRevision,
    nextItemCount,
    new Date().toISOString()
  );
  await writeReadyImageCacheMeta(meta, redis);
  assertRedisConnectionEpoch(redisConnectionEpoch);
  if ((await getReadyImageRevision()).revision !== committedRevision) {
    throw new Error("PostgreSQL revision changed while Redis was publishing");
  }
  completeReadyImageCacheMutation(meta);
  return meta;
}
