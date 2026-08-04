import { coalesce } from "../../core/coalesce.ts";
import { getRedisConnectionState, redis } from "../../core/redis-client.ts";
import { execRedisPipeline } from "../../core/redis-pipeline.ts";
import { randomUuidV7 } from "../../core/uuid.ts";
import {
  getReadyImageCacheCoordinatorStatus,
  readyImageCacheIsReadable
} from "./coordinator.ts";
import {
  registerReadyImageDerivedFilter,
  touchReadyImageDerivedFilter
} from "./derived-cache-policy.ts";
import { withReadyImageCacheWriteFence } from "./fence.ts";
import type { ReadyImageFilterPlan, ReadyImageSelectorGroup } from "./filters.ts";
import { validateReadyImageIndexSources } from "./integrity-manifest.ts";
import {
  handleReadyImageDerivedCacheError,
  readyImageDerivedCacheHasHeadroom
} from "./memory-pressure.ts";
import {
  READY_IMAGE_ALL_INDEX_KEY,
  READY_IMAGE_CACHE_PREFIX,
  READY_IMAGE_INTEGRITY_KEY,
  readyImageAuthorIndexKey,
  readyImageAxisIndexKey,
  readyImageFilterKey,
  readyImageFilterMetaKey,
  readyImageTagIndexKey,
  readyImageThemeIndexKey
} from "./keys.ts";

const FILTER_TTL_SECONDS = 6 * 60 * 60;
const TEMP_FILTER_TTL_SECONDS = 5 * 60;
const FILTER_BUILD_MAX_CONCURRENCY = 4;
let activeFilterBuilds = 0;

export type ReadyImageFilterIndex = {
  key: string;
  revision: string;
  count: number | null;
  metaKey: string | null;
};

export type ReadyImageFilterIndexValidation =
  | "valid"
  | "revision_changed"
  | "invalid";

type FilterMeta = {
  revision: string;
  count: number;
};

function currentRevision() {
  const status = getReadyImageCacheCoordinatorStatus();
  return status.readable && status.meta?.state === "ready"
    ? status.meta.appliedRevision
    : null;
}

function parseFilterMeta(raw: Record<string, string>): FilterMeta | null {
  if (
    Object.keys(raw).length !== 3
    || !/^\d+$/.test(raw.applied_revision ?? "")
    || !/^\d+$/.test(raw.count ?? "")
    || !Number.isFinite(Date.parse(raw.built_at ?? ""))
  ) {
    return null;
  }
  const count = Number(raw.count);
  if (!Number.isSafeInteger(count)) return null;
  return { revision: raw.applied_revision, count };
}

async function readCachedFilter(
  plan: ReadyImageFilterPlan,
  revision: string
): Promise<ReadyImageFilterIndex | null> {
  const key = readyImageFilterKey(plan.signature);
  const metaKey = readyImageFilterMetaKey(plan.signature);
  const transaction = redis.multi();
  transaction.hgetall(metaKey);
  transaction.zcard(key);
  transaction.expire(metaKey, FILTER_TTL_SECONDS);
  transaction.expire(key, FILTER_TTL_SECONDS);
  const results = await execRedisPipeline(transaction);
  const meta = parseFilterMeta(
    results[0]?.[1] as Record<string, string> ?? {}
  );
  const cardinality = Number(results[1]?.[1] ?? 0);
  if (
    !meta
    || meta.revision !== revision
    || cardinality !== meta.count
  ) {
    return null;
  }
  await touchReadyImageDerivedFilter(key);
  return { key, revision, count: meta.count, metaKey };
}

function selectorComponents(
  group: ReadyImageSelectorGroup,
  key: (value: string) => string
) {
  return {
    include: group.include.map(key),
    exclude: group.exclude.map(key)
  };
}

function filterComponents(plan: ReadyImageFilterPlan) {
  const positive: string[][] = [];
  if (plan.axes.length < 4) {
    positive.push(plan.axes.map((axis) => (
      readyImageAxisIndexKey(axis.device, axis.brightness)
    )));
  }
  const theme = selectorComponents(plan.theme, readyImageThemeIndexKey);
  const tag = selectorComponents(plan.tag, readyImageTagIndexKey);
  const author = selectorComponents(plan.author, readyImageAuthorIndexKey);
  for (const keys of [theme.include, tag.include, author.include]) {
    if (keys.length) positive.push(keys);
  }
  return {
    positive,
    exclusions: [theme.exclude, tag.exclude, author.exclude]
  };
}

function directFilterKey(plan: ReadyImageFilterPlan) {
  const { positive, exclusions } = filterComponents(plan);
  if (exclusions.some((keys) => keys.length)) return null;
  if (!positive.length) return READY_IMAGE_ALL_INDEX_KEY;
  if (positive.length === 1 && positive[0]?.length === 1) {
    return positive[0][0] ?? null;
  }
  return null;
}

async function storeSetOperation(
  command: "zunionstore" | "zinterstore" | "zdiffstore",
  destination: string,
  sources: string[]
) {
  const transaction = redis.multi();
  if (command === "zdiffstore") {
    transaction.call(
      "ZDIFFSTORE",
      destination,
      String(sources.length),
      ...sources
    );
  } else {
    transaction.call(
      command.toUpperCase(),
      destination,
      String(sources.length),
      ...sources,
      "AGGREGATE",
      "MAX"
    );
  }
  transaction.expire(destination, TEMP_FILTER_TTL_SECONDS);
  await execRedisPipeline(transaction);
}

async function buildFilterWithSlot(
  plan: ReadyImageFilterPlan,
  revision: string
): Promise<ReadyImageFilterIndex | null> {
  if (!await readyImageDerivedCacheHasHeadroom()) return null;
  const startingStatus = getReadyImageCacheCoordinatorStatus();
  const startingMeta = startingStatus.meta;
  const startingConnection = getRedisConnectionState();
  if (
    !startingStatus.readable
    || startingMeta?.state !== "ready"
    || startingMeta.appliedRevision !== revision
    || !startingConnection.ready
  ) {
    return null;
  }
  const finalKey = readyImageFilterKey(plan.signature);
  const metaKey = readyImageFilterMetaKey(plan.signature);
  const token = randomUuidV7().replaceAll("-", "");
  const temporaryKeys: string[] = [];
  let sequence = 0;
  const temporaryKey = () => {
    const key = `${READY_IMAGE_CACHE_PREFIX}filter-temp:${token}:${sequence}`;
    sequence += 1;
    temporaryKeys.push(key);
    return key;
  };
  const releaseTemporaryKeys = async (...keys: string[]) => {
    const releasable = [...new Set(keys)].filter((key) => (
      temporaryKeys.includes(key)
    ));
    if (!releasable.length) return;
    await redis.unlink(...releasable);
    for (const key of releasable) {
      temporaryKeys.splice(temporaryKeys.indexOf(key), 1);
    }
  };
  const { positive, exclusions } = filterComponents(plan);
  const sourceCounts = await validateReadyImageIndexSources([
    ...positive.flat(),
    ...exclusions.flat(),
    ...(positive.length ? [] : [READY_IMAGE_ALL_INDEX_KEY])
  ], redis);
  const union = async (keys: string[]) => {
    const activeKeys = keys.filter((key) => (sourceCounts.get(key) ?? 0) > 0);
    if (!activeKeys.length) return keys[0]!;
    if (activeKeys.length === 1) return activeKeys[0]!;
    const destination = temporaryKey();
    await storeSetOperation("zunionstore", destination, activeKeys);
    return destination;
  };

  try {
    let current = "";
    for (const keys of positive) {
      const component = await union(keys);
      if (!current) {
        current = component;
        continue;
      }
      const destination = temporaryKey();
      await storeSetOperation("zinterstore", destination, [current, component]);
      await releaseTemporaryKeys(current, component);
      current = destination;
    }
    if (!current) current = READY_IMAGE_ALL_INDEX_KEY;

    for (const keys of exclusions) {
      const activeKeys = keys.filter(
        (key) => (sourceCounts.get(key) ?? 0) > 0
      );
      if (!activeKeys.length) continue;
      const excluded = await union(activeKeys);
      const destination = temporaryKey();
      await storeSetOperation("zdiffstore", destination, [current, excluded]);
      await releaseTemporaryKeys(current, excluded);
      current = destination;
    }

    if (!temporaryKeys.includes(current)) {
      return { key: current, revision, count: null, metaKey: null };
    }
    const count = await redis.zcard(current);
    const published = await withReadyImageCacheWriteFence(async () => {
      const status = getReadyImageCacheCoordinatorStatus();
      const connection = getRedisConnectionState();
      if (
        !status.readable
        || status.meta?.state !== "ready"
        || status.meta !== startingMeta
        || status.meta.appliedRevision !== revision
        || !connection.ready
        || connection.epoch !== startingConnection.epoch
      ) {
        return false;
      }
      const transaction = redis.multi();
      transaction.del(finalKey, metaKey);
      if (count > 0) {
        transaction.rename(current, finalKey);
        transaction.expire(finalKey, FILTER_TTL_SECONDS);
      }
      transaction.hset(metaKey, {
        applied_revision: revision,
        count: String(count),
        built_at: new Date().toISOString()
      });
      transaction.expire(metaKey, FILTER_TTL_SECONDS);
      await execRedisPipeline(transaction);
      await registerReadyImageDerivedFilter(
        finalKey,
        count,
        status.meta.itemCount
      );
      return currentRevision() === revision;
    });
    if (!published) return null;
    return { key: finalKey, revision, count, metaKey };
  } finally {
    if (temporaryKeys.length) {
      await redis.unlink(...temporaryKeys).catch(() => undefined);
    }
  }
}

async function buildFilter(
  plan: ReadyImageFilterPlan,
  revision: string
) {
  if (activeFilterBuilds >= FILTER_BUILD_MAX_CONCURRENCY) return null;
  activeFilterBuilds += 1;
  try {
    return await buildFilterWithSlot(plan, revision);
  } finally {
    activeFilterBuilds -= 1;
  }
}

export async function resolveReadyImageFilterIndex(
  plan: ReadyImageFilterPlan
): Promise<ReadyImageFilterIndex | null> {
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!readyImageCacheIsReadable()) return null;
      const revision = currentRevision();
      if (!revision) return null;
      const direct = directFilterKey(plan);
      if (direct) {
        return { key: direct, revision, count: null, metaKey: null };
      }
      const cached = await readCachedFilter(plan, revision);
      if (cached) return cached;
      const built = await coalesce(
        `ready-image-filter:${plan.signature}`,
        () => buildFilter(plan, revision)
      );
      if (built) return built;
    }
    return null;
  } catch (error) {
    if (await handleReadyImageDerivedCacheError(error)) return null;
    throw error;
  }
}

export async function validateReadyImageFilterIndex(
  index: ReadyImageFilterIndex
) : Promise<ReadyImageFilterIndexValidation> {
  if (currentRevision() !== index.revision) return "revision_changed";
  if (!index.metaKey) {
    const transaction = redis.pipeline();
    transaction.hget(READY_IMAGE_INTEGRITY_KEY, index.key);
    transaction.zcard(index.key);
    const results = await execRedisPipeline(transaction);
    const expectedRaw = results[0]?.[1];
    const actual = Number(results[1]?.[1] ?? 0);
    if (!Number.isSafeInteger(actual) || actual < 0) return "invalid";
    if (expectedRaw === null) return actual === 0 ? "valid" : "invalid";
    const expected = Number(expectedRaw);
    return Number.isSafeInteger(expected) && expected >= 0 && expected === actual
      ? "valid"
      : "invalid";
  }
  const meta = parseFilterMeta(await redis.hgetall(index.metaKey));
  return (
    meta
    && meta.revision === index.revision
    && meta.count === index.count
    && await redis.zcard(index.key) === meta.count
  ) ? "valid" : "invalid";
}
