import type { Redis } from "ioredis";
import { errorMessage } from "../../../core/api-error.ts";
import { redis } from "../../../core/redis/client.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_STATS_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY
} from "../keys.ts";
import { readReadyImageCacheMeta } from "../meta.ts";
import {
  type ReadyImageCacheItem,
  type ReadyImageCacheMeta
} from "../model.ts";
import {
  readReadyImageIntegrity,
  sameReadyImageCardinalities,
  validateReadyImageCardinalities,
  validateReadyImageStatsIntegrity,
  writeReadyImageStatsAndIntegrity,
  type ReadyImageCardinalities,
  type ReadyImageStats
} from "./manifest.ts";
import {
  validatePersistedReadyImageSamples,
  validateReadyImageSamples
} from "./samples.ts";
import { compareReadyImageRevisions } from "../revision.ts";

export type ReadyImageCacheStartupValidation =
  | { valid: true; meta: ReadyImageCacheMeta }
  | { valid: false; reason: string; meta: ReadyImageCacheMeta | null };

export {
  validateReadyImageSamples,
  writeReadyImageStatsAndIntegrity,
  type ReadyImageCardinalities,
  type ReadyImageStats
};

export function incrementReadyImageCount(
  map: Map<string, number>,
  key: string
) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function initialReadyImageCardinalities(
  itemCount: number
): ReadyImageCardinalities {
  return new Map([
    [READY_IMAGE_ITEMS_KEY, itemCount],
    [READY_IMAGE_ALL_INDEX_KEY, itemCount],
    [READY_IMAGE_OBJECT_LOOKUP_KEY, itemCount],
    [READY_IMAGE_THUMB_LOOKUP_KEY, itemCount],
    [READY_IMAGE_ID_SUFFIX_LOOKUP_KEY, itemCount]
  ]);
}

export function buildReadyImageCardinalities(
  itemCount: number
): ReadyImageCardinalities {
  const cardinalities = initialReadyImageCardinalities(itemCount);
  cardinalities.set(READY_IMAGE_ALL_INDEX_KEY, 0);
  return cardinalities;
}

export async function validateBuiltReadyImageCache(
  expected: ReadyImageCardinalities,
  stats: ReadyImageStats,
  samples: ReadyImageCacheItem[],
  client: Redis,
  signal?: AbortSignal
) {
  const persisted = await readReadyImageIntegrity(client);
  if (!sameReadyImageCardinalities(persisted, expected)) {
    throw new Error("Ready-image cache integrity manifest differs from the build");
  }
  await validateReadyImageCardinalities(expected, client, signal);
  await validateReadyImageStatsIntegrity(stats, client);
  await validateReadyImageSamples(samples, client);
}

export async function validateReadyImageCacheAtStartup(
  postgresRevision: string,
  client: Redis = redis
): Promise<ReadyImageCacheStartupValidation> {
  let meta: ReadyImageCacheMeta | null = null;
  try {
    meta = await readReadyImageCacheMeta(client);
    if (!meta) return { valid: false, reason: "meta_missing", meta };
    if (meta.state !== "ready") {
      return { valid: false, reason: `state_${meta.state}`, meta };
    }
    if (compareReadyImageRevisions(meta.appliedRevision, postgresRevision) !== 0) {
      return { valid: false, reason: "revision_mismatch", meta };
    }
    const integrity = await readReadyImageIntegrity(client);
    const core = initialReadyImageCardinalities(meta.itemCount);
    if (integrity.size !== core.size + 1) {
      return { valid: false, reason: "integrity_core_mismatch", meta };
    }
    for (const [key, count] of core) {
      if (integrity.get(key) !== count) {
        return { valid: false, reason: "integrity_core_mismatch", meta };
      }
    }
    const stats = await validateReadyImageStatsIntegrity(null, client);
    if (
      integrity.get(READY_IMAGE_STATS_KEY) !== stats.size
      || stats.get("total") !== meta.itemCount
    ) {
      return { valid: false, reason: "integrity_stats_mismatch", meta };
    }
    await validateReadyImageCardinalities(integrity, client);
    await validatePersistedReadyImageSamples(meta.itemCount, client);
    return { valid: true, meta };
  } catch (error) {
    return {
      valid: false,
      reason: `validation_error:${errorMessage(error)}`,
      meta
    };
  }
}
