import type { Redis } from "ioredis";
import { errorMessage } from "../../core/api-error.ts";
import { redis } from "../../core/redis-client.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_CACHE_PREFIX,
  READY_IMAGE_ID_SUFFIX_LOOKUP_KEY,
  READY_IMAGE_ITEMS_KEY,
  READY_IMAGE_OBJECT_LOOKUP_KEY,
  READY_IMAGE_STATS_KEY,
  READY_IMAGE_THUMB_LOOKUP_KEY
} from "./keys.ts";
import { readReadyImageCacheMeta } from "./meta.ts";
import {
  READY_IMAGE_CACHE_SCHEMA,
  type ReadyImageCacheItem,
  type ReadyImageCacheMeta
} from "./model.ts";
import {
  readReadyImageIntegrity,
  sameReadyImageCardinalities,
  validateReadyImageCardinalities,
  writeReadyImageStatsAndIntegrity,
  type ReadyImageCardinalities,
  type ReadyImageStats
} from "./integrity-manifest.ts";
import { validateReadyImageSamples } from "./integrity-samples.ts";
import { compareReadyImageRevisions } from "./revision.ts";

const SCAN_COUNT = 1_000;

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

function expectedStatsFromCardinalities(
  cardinalities: ReadyImageCardinalities,
  itemCount: number
) {
  const stats: ReadyImageStats = new Map([["total", itemCount]]);
  const axisCounts = new Map<string, number>();
  for (const [key, count] of cardinalities) {
    const prefix = `${READY_IMAGE_CACHE_PREFIX}index:`;
    if (!key.startsWith(prefix) || key === READY_IMAGE_ALL_INDEX_KEY) continue;
    const field = key.slice(prefix.length);
    stats.set(field, count);
    if (field.startsWith("axis:")) axisCounts.set(field, count);
  }
  for (const device of ["pc", "mb"]) {
    const count = [...axisCounts]
      .filter(([field]) => field.startsWith(`axis:${device}:`))
      .reduce((sum, [, value]) => sum + value, 0);
    if (count) stats.set(`device:${device}`, count);
  }
  for (const brightness of ["dark", "light"]) {
    const count = [...axisCounts]
      .filter(([field]) => field.endsWith(`:${brightness}`))
      .reduce((sum, [, value]) => sum + value, 0);
    if (count) stats.set(`brightness:${brightness}`, count);
  }
  return stats;
}

async function validateReadyImageStats(
  expected: ReadyImageStats,
  client: Redis
) {
  const seen = new Map<string, string>();
  let cursor = "0";
  do {
    const [next, fields] = await client.hscan(
      READY_IMAGE_STATS_KEY,
      cursor,
      "COUNT",
      SCAN_COUNT
    );
    cursor = next;
    for (let index = 0; index < fields.length; index += 2) {
      const field = fields[index];
      const value = fields[index + 1];
      if (field && value !== undefined) seen.set(field, value);
    }
  } while (cursor !== "0");
  if (
    seen.size !== expected.size
    || [...expected].some(([field, count]) => seen.get(field) !== String(count))
  ) {
    throw new Error("Ready-image cache statistics failed validation");
  }
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
  await validateReadyImageStats(stats, client);
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
    if (meta.schema !== READY_IMAGE_CACHE_SCHEMA) {
      return { valid: false, reason: "schema_mismatch", meta };
    }
    if (meta.state !== "ready") {
      return { valid: false, reason: `state_${meta.state}`, meta };
    }
    if (compareReadyImageRevisions(meta.appliedRevision, postgresRevision) !== 0) {
      return { valid: false, reason: "revision_mismatch", meta };
    }
    const integrity = await readReadyImageIntegrity(client);
    const core = initialReadyImageCardinalities(meta.itemCount);
    for (const [key, count] of core) {
      if (integrity.get(key) !== count) {
        return { valid: false, reason: "integrity_core_mismatch", meta };
      }
    }
    const expectedStats = expectedStatsFromCardinalities(
      integrity,
      meta.itemCount
    );
    if (integrity.get(READY_IMAGE_STATS_KEY) !== expectedStats.size) {
      return { valid: false, reason: "integrity_stats_mismatch", meta };
    }
    await validateReadyImageCardinalities(integrity, client);
    await validateReadyImageStats(expectedStats, client);
    return { valid: true, meta };
  } catch (error) {
    return {
      valid: false,
      reason: `validation_error:${errorMessage(error)}`,
      meta
    };
  }
}
