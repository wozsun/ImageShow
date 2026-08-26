import { redis } from "../../../core/redis/client.ts";
import {
  READY_IMAGE_DERIVED_INDEX_META_PREFIX,
  READY_IMAGE_DERIVED_INDEX_PREFIX,
  READY_IMAGE_DERIVED_PREFIX,
  READY_IMAGE_FILTER_KEY_PREFIX,
  READY_IMAGE_FILTER_META_KEY_PREFIX,
  READY_IMAGE_STATS_RESULT_KEY_PREFIX,
  assertReadyImageDerivedCacheKey
} from "../keys.ts";

const SCAN_COUNT = 1_000;

async function clearPattern(pattern: string) {
  let removedInPass: number;
  let removed = 0;
  do {
    let cursor = "0";
    removedInPass = 0;
    do {
      const [next, keys] = await redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        SCAN_COUNT
      );
      cursor = next;
      keys.forEach(assertReadyImageDerivedCacheKey);
      if (keys.length) removedInPass += await redis.unlink(...keys);
    } while (cursor !== "0");
    removed += removedInPass;
  } while (removedInPass > 0);
  return removed;
}

/**
 * Drops only published reproducible query products while preserving gallery
 * core data. Builder-owned temporary keys expire independently and are never
 * removed from under an active filter construction.
 */
export async function clearReadyImageDisposableCachesUnchecked() {
  const removed = await Promise.all([
    clearPattern(`${READY_IMAGE_DERIVED_INDEX_PREFIX}*`),
    clearPattern(`${READY_IMAGE_DERIVED_INDEX_META_PREFIX}*`),
    clearPattern(`${READY_IMAGE_FILTER_KEY_PREFIX}*`),
    clearPattern(`${READY_IMAGE_FILTER_META_KEY_PREFIX}*`),
    clearPattern(`${READY_IMAGE_STATS_RESULT_KEY_PREFIX}*`),
    clearPattern(`${READY_IMAGE_DERIVED_PREFIX}registry:*`)
  ]);
  return removed.some((count) => count > 0);
}
