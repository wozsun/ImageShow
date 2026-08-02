import type { PoolClient } from "pg";
import { pool } from "../core/db.ts";
import { redis } from "../core/redis-client.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import { logger } from "../core/logger.ts";
import { runSharedRandomBuild } from "./build-lifecycle.ts";
import {
  createRandomRebuildBatchStore,
  type RandomRebuildBatchStore
} from "./rebuild-spool.ts";
import {
  GALLERY_FILTER_OPTIONS_KEY,
  RANDOM_CACHE_NAMESPACE,
  RANDOM_COLD_BUILD_WINDOW_PREFIX,
  RANDOM_CURRENT_KEY,
  RANDOM_MUTATION_REVISION_KEY,
  RANDOM_REBUILD_COMPLETED_KEY,
  RANDOM_REBUILD_LOCK_KEY,
  RANDOM_RETIRED_GENERATIONS_KEY,
  RANDOM_UPDATE_LOCK_KEY,
  randomGenerationPrefix,
  randomItemKey,
  randomManifestKey,
  randomSnapshotKey
} from "./cache-keys.ts";
import {
  adjustCategoryCounts,
  filterOptionsFromCategoryCounts,
  randomPoolItemsFromRows,
  type RandomCategoryCounts,
  type RandomPoolItem,
  type RandomPoolSnapshot
} from "./cache-model.ts";
import {
  RANDOM_CLEANUP_BATCH_SIZE,
  RANDOM_BUILD_GENERATION_TTL_SECONDS,
  RANDOM_COLD_BUILD_LIMIT,
  RANDOM_COLD_BUILD_WINDOW_SECONDS,
  RANDOM_GENERATION_PERSIST_WAIT_MS,
  RANDOM_OLD_GENERATION_TTL_SECONDS,
  RANDOM_REBUILD_BATCH_SIZE,
  RANDOM_REBUILD_WAIT_ATTEMPTS,
  RANDOM_REBUILD_WAIT_INTERVAL_MS,
  randomColdBuildRateLimited,
  redisRevision,
  redisUnavailable
} from "./cache-policy.ts";
import {
  RANDOM_COLD_BUILD_RATE_LIMIT_SCRIPT,
  RANDOM_GENERATION_PERSIST_SCRIPT,
  RANDOM_GENERATION_PUBLISH_SCRIPT
} from "./cache-scripts.ts";
import {
  collectRandomMemberships,
  queueRandomMemberships,
  queueRandomSnapshot,
  registerRandomGenerationKeys
} from "./cache-writes.ts";
import {
  acquireRandomRebuildLock,
  startRandomRebuildLockRenewal
} from "./cache-lock.ts";

function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function readyRandomItemBatch(
  client: PoolClient,
  afterId: string | null,
  signal?: AbortSignal
): Promise<RandomPoolItem[]> {
  signal?.throwIfAborted();
  const rows = (await client.query(
    `WITH ready AS (
       SELECT m.id, m.object_key, m.ext, m.device, m.brightness, m.theme,
              m.storage_slug, m.author
         FROM metadata m
        WHERE m.status='ready'
          AND ($1::uuid IS NULL OR m.id > $1::uuid)
        ORDER BY m.id
        LIMIT $2
     )
     SELECT ready.id, ready.object_key, ready.ext, ready.device, ready.brightness,
            ready.theme, ready.storage_slug,
            COALESCE(ready.author, '') AS author,
            COALESCE(array_remove(array_agg(it.tag_slug ORDER BY it.tag_slug), NULL), '{}') AS tags
       FROM ready
       LEFT JOIN image_tag it ON it.image_id = ready.id
      GROUP BY ready.id, ready.object_key, ready.ext, ready.device, ready.brightness,
               ready.theme, ready.storage_slug, ready.author
      ORDER BY ready.id`,
    [afterId, RANDOM_REBUILD_BATCH_SIZE]
  )).rows;
  signal?.throwIfAborted();
  return randomPoolItemsFromRows(rows);
}

async function cleanupFailedGeneration(
  generation: string,
  knownKeys: Set<string>,
  mode: "delete" | "expire" = "delete",
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  let current: string | null;
  try {
    current = await redis.get(RANDOM_CURRENT_KEY);
  } catch {
    // 发布结果未知时宁可保留临时键，也不能误删正在服务的 generation。
    return;
  }
  if (current === generation) return;

  const manifest = randomManifestKey(generation);
  const prefix = randomGenerationPrefix(generation);
  let cleanupMode = mode;
  const cleanBatch = async (keys: string[]) => {
    if (!keys.length) return;
    signal?.throwIfAborted();
    if (cleanupMode === "delete") {
      try {
        await redis.unlink(...keys);
        signal?.throwIfAborted();
        return;
      } catch {
        cleanupMode = "expire";
      }
    }
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.expire(key, RANDOM_OLD_GENERATION_TTL_SECONDS);
    }
    await execRedisPipeline(pipeline).catch(() => undefined);
    signal?.throwIfAborted();
  };

  let knownBatch: string[] = [];
  for (const key of knownKeys) {
    if (key === manifest || !key.startsWith(prefix)) continue;
    knownBatch.push(key);
    if (knownBatch.length < RANDOM_CLEANUP_BATCH_SIZE) continue;
    await cleanBatch(knownBatch);
    knownBatch = [];
  }
  await cleanBatch(knownBatch);

  let cursor = "0";
  do {
    signal?.throwIfAborted();
    let scan: [string, string[]];
    try {
      scan = await redis.sscan(
        manifest,
        cursor,
        "COUNT",
        RANDOM_CLEANUP_BATCH_SIZE
      );
    } catch {
      break;
    }
    cursor = scan[0];
    const keys = [...new Set(scan[1])].filter((key) => (
      key !== manifest
      && key.startsWith(prefix)
      && !knownKeys.has(key)
    ));
    for (const batch of chunkArray(keys, RANDOM_CLEANUP_BATCH_SIZE)) {
      await cleanBatch(batch);
    }
  } while (cursor !== "0");

  await cleanBatch([manifest]);
}

async function writeRandomGenerationBatch(
  generation: string,
  items: RandomPoolItem[],
  categoryCounts: RandomCategoryCounts,
  keys: Set<string>,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  if (!items.length) return;
  keys.add(randomItemKey(generation));
  const memberships = new Map<string, string[]>();
  const itemValues: string[] = [];
  for (const item of items) {
    adjustCategoryCounts(categoryCounts, item, 1);
    itemValues.push(item.id, JSON.stringify(item));
    collectRandomMemberships(memberships, generation, item, keys);
  }
  const transaction = redis.multi();
  transaction.hset(randomItemKey(generation), ...itemValues);
  queueRandomMemberships(transaction, "sadd", memberships);
  transaction.expire(
    randomItemKey(generation),
    RANDOM_BUILD_GENERATION_TTL_SECONDS
  );
  for (const key of memberships.keys()) {
    transaction.expire(key, RANDOM_BUILD_GENERATION_TTL_SECONDS);
  }
  await execRedisPipeline(transaction);
  signal?.throwIfAborted();
}

async function finalizeRandomGeneration(
  generation: string,
  categoryCounts: RandomCategoryCounts,
  keys: Set<string>,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const snapshot = redis.multi();
  queueRandomSnapshot(snapshot, generation, categoryCounts);
  snapshot.expire(
    randomSnapshotKey(generation),
    RANDOM_BUILD_GENERATION_TTL_SECONDS
  );
  await execRedisPipeline(snapshot);

  const manifest = randomManifestKey(generation);
  let batch: string[] = [];
  const writeBatch = async () => {
    if (!batch.length) return;
    signal?.throwIfAborted();
    const transaction = redis.multi();
    transaction.sadd(manifest, ...batch);
    for (const key of batch) {
      transaction.expire(key, RANDOM_BUILD_GENERATION_TTL_SECONDS);
    }
    transaction.expire(manifest, RANDOM_BUILD_GENERATION_TTL_SECONDS);
    await execRedisPipeline(transaction);
    signal?.throwIfAborted();
    batch = [];
  };
  for (const key of keys) {
    batch.push(key);
    if (batch.length >= RANDOM_CLEANUP_BATCH_SIZE) await writeBatch();
  }
  await writeBatch();
}

type GenerationPersistenceResult = "persisted" | "changed" | "updating";

async function persistGenerationKeys(
  generation: string,
  manifest: string,
  keys: string[]
): Promise<GenerationPersistenceResult> {
  const persisted = Number(await redis.eval(
    RANDOM_GENERATION_PERSIST_SCRIPT,
    keys.length + 4,
    RANDOM_CURRENT_KEY,
    RANDOM_RETIRED_GENERATIONS_KEY,
    RANDOM_UPDATE_LOCK_KEY,
    manifest,
    ...keys,
    generation
  ));
  if (persisted === -1) return "changed";
  if (persisted === -3) return "updating";
  if (persisted === -2) {
    throw new Error("Published random generation contains a missing key");
  }
  return "persisted";
}

async function persistPublishedGenerationOnce(
  generation: string,
  signal?: AbortSignal
): Promise<GenerationPersistenceResult> {
  signal?.throwIfAborted();
  const manifest = randomManifestKey(generation);
  // Make the ownership manifest durable first. If this process stops midway,
  // the next startup can finish the current generation without losing the
  // bounded list needed to expire it after a later publication.
  let result = await persistGenerationKeys(generation, manifest, []);
  if (result !== "persisted") return result;

  const prefix = randomGenerationPrefix(generation);
  let cursor = "0";
  do {
    signal?.throwIfAborted();
    const scan = await redis.sscan(
      manifest,
      cursor,
      "COUNT",
      RANDOM_CLEANUP_BATCH_SIZE
    );
    cursor = scan[0];
    const keys = [...new Set(scan[1])];
    if (keys.some((key) => !key.startsWith(prefix))) {
      throw new Error("Published random generation manifest contains a foreign key");
    }
    for (const batch of chunkArray(keys, RANDOM_CLEANUP_BATCH_SIZE)) {
      signal?.throwIfAborted();
      result = await persistGenerationKeys(generation, manifest, batch);
      if (result !== "persisted") return result;
    }
  } while (cursor !== "0");
  return "persisted";
}

async function persistPublishedGeneration(
  generation: string,
  signal?: AbortSignal
) {
  const deadline = Date.now() + RANDOM_GENERATION_PERSIST_WAIT_MS;
  for (;;) {
    signal?.throwIfAborted();
    const result = await persistPublishedGenerationOnce(generation, signal);
    if (result === "persisted") return true;
    if (result === "changed") return false;
    if (Date.now() >= deadline) break;
    await waitForRandomRebuild(signal);
  }
  throw new Error("Random generation persistence remained blocked by updates");
}

function validRandomGeneration(generation: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(generation);
}

async function expireRetiredGeneration(
  generation: string,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  if (!validRandomGeneration(generation)) {
    await redis.srem(RANDOM_RETIRED_GENERATIONS_KEY, generation);
    return;
  }
  if (await redis.get(RANDOM_CURRENT_KEY) === generation) return;

  const manifest = randomManifestKey(generation);
  const prefix = randomGenerationPrefix(generation);
  if (await redis.exists(manifest)) {
    let cursor = "0";
    do {
      signal?.throwIfAborted();
      const scan = await redis.sscan(
        manifest,
        cursor,
        "COUNT",
        RANDOM_CLEANUP_BATCH_SIZE
      );
      cursor = scan[0];
      const keys = [...new Set(scan[1])].filter((key) => (
        key !== manifest && key.startsWith(prefix)
      ));
      for (const batch of chunkArray(keys, RANDOM_CLEANUP_BATCH_SIZE)) {
        signal?.throwIfAborted();
        const pipeline = redis.pipeline();
        for (const key of batch) {
          pipeline.expire(key, RANDOM_OLD_GENERATION_TTL_SECONDS);
        }
        await execRedisPipeline(pipeline);
      }
    } while (cursor !== "0");
  } else {
    let cursor = "0";
    do {
      signal?.throwIfAborted();
      const scan = await redis.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        RANDOM_CLEANUP_BATCH_SIZE
      );
      cursor = scan[0];
      for (const batch of chunkArray(scan[1], RANDOM_CLEANUP_BATCH_SIZE)) {
        signal?.throwIfAborted();
        const pipeline = redis.pipeline();
        for (const key of batch) {
          pipeline.expire(key, RANDOM_OLD_GENERATION_TTL_SECONDS);
        }
        await execRedisPipeline(pipeline);
      }
    } while (cursor !== "0");
  }

  const final = redis.multi();
  final.expire(manifest, RANDOM_OLD_GENERATION_TTL_SECONDS);
  final.srem(RANDOM_RETIRED_GENERATIONS_KEY, generation);
  await execRedisPipeline(final);
}

async function drainRetiredRandomGenerations(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const generations = await redis.srandmember(
    RANDOM_RETIRED_GENERATIONS_KEY,
    RANDOM_CLEANUP_BATCH_SIZE
  );
  for (const generation of generations) {
    await expireRetiredGeneration(generation, signal);
  }
}

async function finishPublishedGeneration(
  generation: string,
  signal?: AbortSignal
) {
  try {
    if (await persistPublishedGeneration(generation, signal)) {
      await drainRetiredRandomGenerations(signal).catch((error) => {
        if (!signal?.aborted) {
          logger.warn("retired random generation cleanup deferred", error);
        }
      });
      signal?.throwIfAborted();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.warn("random pool generation persistence failed", error);
    await scheduleRandomRebuild();
    throw redisUnavailable();
  }
}

function validateRandomPoolItemBatch(value: unknown): RandomPoolItem[] {
  if (
    !Array.isArray(value)
    || !value.length
    || value.length > RANDOM_REBUILD_BATCH_SIZE
  ) {
    throw new Error("Invalid random rebuild batch");
  }
  for (const item of value) {
    if (
      !item
      || typeof item !== "object"
      || typeof item.id !== "string"
      || typeof item.object_key !== "string"
      || typeof item.ext !== "string"
      || !["pc", "mb"].includes(String(item.device))
      || !["dark", "light"].includes(String(item.brightness))
      || typeof item.theme !== "string"
      || typeof item.storage_slug !== "string"
      || typeof item.author !== "string"
      || !Array.isArray(item.tags)
      || item.tags.length > 50
      || item.tags.some((tag: unknown) => typeof tag !== "string")
    ) {
      throw new Error("Invalid random rebuild item");
    }
  }
  return value as RandomPoolItem[];
}

async function readReadyRandomItemBatches(signal?: AbortSignal): Promise<
  RandomRebuildBatchStore<RandomPoolItem>
> {
  signal?.throwIfAborted();
  const batchStore = createRandomRebuildBatchStore({
    validateBatch: validateRandomPoolItemBatch
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let afterId: string | null = null;
    for (;;) {
      signal?.throwIfAborted();
      const items = await readyRandomItemBatch(client, afterId, signal);
      if (!items.length) break;
      await batchStore.append(items);
      signal?.throwIfAborted();
      afterId = items.at(-1)?.id ?? null;
      if (items.length < RANDOM_REBUILD_BATCH_SIZE) break;
    }
    await client.query("COMMIT");
    await batchStore.seal();
    return batchStore;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    await batchStore.cleanup();
    throw error;
  } finally {
    client.release();
  }
}

async function performRandomPoolRebuild(
  targetRevision: number,
  token: string,
  confirmOwnership: () => Promise<boolean>,
  signal?: AbortSignal
): Promise<{
  published: boolean;
  snapshot: RandomPoolSnapshot;
}> {
  const generation = randomUuidV7();
  const categoryCounts: RandomCategoryCounts = {};
  const keys = new Set<string>();
  registerRandomGenerationKeys(generation, keys);
  let publicationAttempted = false;
  try {
    signal?.throwIfAborted();
    // PostgreSQL 快照只覆盖数据库读取；COMMIT 后才开始向 Redis 写 generation。
    const itemBatches = await readReadyRandomItemBatches(signal);
    try {
      const sourceStats = itemBatches.stats();
      logger.info("random_pool_rebuild_source_ready", {
        item_count: sourceStats.itemCount,
        batch_count: sourceStats.batchCount,
        serialized_bytes: sourceStats.serializedBytes,
        peak_memory_payload_bytes: sourceStats.peakMemoryPayloadBytes,
        source_storage: sourceStats.storage,
        spool_bytes: sourceStats.spoolBytes
      });
      for await (const items of itemBatches.batches()) {
        signal?.throwIfAborted();
        await writeRandomGenerationBatch(
          generation,
          items,
          categoryCounts,
          keys,
          signal
        );
      }
    } finally {
      await itemBatches.cleanup();
    }

    await finalizeRandomGeneration(generation, categoryCounts, keys, signal);

    const themes = filterOptionsFromCategoryCounts(categoryCounts).themes;
    const snapshot = { generation, categoryCounts, themes };
    signal?.throwIfAborted();
    if (!await confirmOwnership()) {
      throw new Error("Random rebuild lock ownership was lost");
    }
    signal?.throwIfAborted();
    publicationAttempted = true;
    const publication = await redis.eval(
      RANDOM_GENERATION_PUBLISH_SCRIPT,
      7,
      RANDOM_CURRENT_KEY,
      RANDOM_MUTATION_REVISION_KEY,
      RANDOM_REBUILD_COMPLETED_KEY,
      GALLERY_FILTER_OPTIONS_KEY,
      RANDOM_REBUILD_LOCK_KEY,
      RANDOM_RETIRED_GENERATIONS_KEY,
      RANDOM_UPDATE_LOCK_KEY,
      String(targetRevision),
      generation,
      JSON.stringify(filterOptionsFromCategoryCounts(categoryCounts)),
      token
    ) as [number, string];
    const publicationStatus = Number(publication[0]);
    if (publicationStatus < 0) {
      throw new Error("Random rebuild lock ownership was lost");
    }
    const published = publicationStatus === 1;
    if (published) {
      await finishPublishedGeneration(generation, signal);
    } else {
      await cleanupFailedGeneration(generation, keys, "delete", signal);
    }
    signal?.throwIfAborted();
    return { published, snapshot };
  } catch (error) {
    await cleanupFailedGeneration(
      generation,
      keys,
      publicationAttempted ? "expire" : "delete",
      signal
    );
    throw error;
  }
}

export async function readRandomPoolSnapshot(): Promise<
  RandomPoolSnapshot | null
> {
  const result = await redis.eval(
    `local generation = redis.call("GET", KEYS[1])
     if not generation then return {} end
     local raw = redis.call("GET", ARGV[1] .. generation .. ARGV[2])
     if not raw then return { generation } end
     return { generation, raw }`,
    1,
    RANDOM_CURRENT_KEY,
    `${RANDOM_CACHE_NAMESPACE}:`,
    ":snapshot"
  ) as string[];
  const [generation, raw] = result;
  if (!generation || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as {
      categoryCounts?: RandomCategoryCounts;
    };
    if (!parsed.categoryCounts) return null;
    return {
      generation,
      categoryCounts: parsed.categoryCounts,
      themes: filterOptionsFromCategoryCounts(parsed.categoryCounts).themes
    };
  } catch {
    return null;
  }
}

async function rebuildRandomPoolWhileLocked(
  token: string,
  signal: AbortSignal
) {
  const lockRenewal = startRandomRebuildLockRenewal(token);
  const buildSignal = AbortSignal.any([signal, lockRenewal.signal]);
  try {
    for (;;) {
      buildSignal.throwIfAborted();
      const targetRevision = redisRevision(
        await redis.get(RANDOM_MUTATION_REVISION_KEY)
      );
      buildSignal.throwIfAborted();
      const rebuilt = await performRandomPoolRebuild(
        targetRevision,
        token,
        lockRenewal.renewNow,
        buildSignal
      );
      if (rebuilt.published) return rebuilt.snapshot;
    }
  } finally {
    await lockRenewal.stop();
  }
}

function waitForRandomRebuild(signal?: AbortSignal) {
  if (!signal) {
    return new Promise<void>((resolve) => {
      setTimeout(resolve, RANDOM_REBUILD_WAIT_INTERVAL_MS);
    });
  }
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, RANDOM_REBUILD_WAIT_INTERVAL_MS);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}

async function assertRandomColdBuildAllowed() {
  const result = await redis.eval(
    RANDOM_COLD_BUILD_RATE_LIMIT_SCRIPT,
    1,
    RANDOM_COLD_BUILD_WINDOW_PREFIX,
    RANDOM_COLD_BUILD_WINDOW_SECONDS,
    RANDOM_COLD_BUILD_LIMIT
  ) as [number, number];
  if (Number(result[0]) !== 1) {
    throw randomColdBuildRateLimited(Number(result[1]));
  }
}

async function processPendingRandomPoolRebuilds(signal: AbortSignal) {
  let coldBuildAuthorized = false;
  for (
    let attempt = 0;
    attempt < RANDOM_REBUILD_WAIT_ATTEMPTS;
    attempt += 1
  ) {
    signal.throwIfAborted();
    const [snapshot, requestedRaw, completedRaw] = await Promise.all([
      readRandomPoolSnapshot().catch(() => null),
      redis.get(RANDOM_MUTATION_REVISION_KEY),
      redis.get(RANDOM_REBUILD_COMPLETED_KEY)
    ]);
    const requestedRevision = redisRevision(requestedRaw);
    const completedRevision = redisRevision(completedRaw);
    if (snapshot && completedRevision >= requestedRevision) {
      await finishPublishedGeneration(snapshot.generation, signal);
      return await readRandomPoolSnapshot() ?? snapshot;
    }

    if (!snapshot && !coldBuildAuthorized) {
      await assertRandomColdBuildAllowed();
      coldBuildAuthorized = true;
    }

    signal.throwIfAborted();
    const token = await acquireRandomRebuildLock();
    if (token) return rebuildRandomPoolWhileLocked(token, signal);
    signal.throwIfAborted();
    await waitForRandomRebuild(signal);
  }

  signal.throwIfAborted();
  await scheduleRandomRebuild();
  throw redisUnavailable();
}

export async function rebuildRandomPool(
  options: { requireFresh?: boolean; signal?: AbortSignal } = {}
): Promise<RandomPoolSnapshot> {
  const { signal } = options;
  signal?.throwIfAborted();
  const requireFresh = options.requireFresh ?? true;
  const requiredRevision = requireFresh
    ? await redis.incr(RANDOM_MUTATION_REVISION_KEY)
    : redisRevision(await redis.get(RANDOM_MUTATION_REVISION_KEY));
  signal?.throwIfAborted();

  for (;;) {
    const snapshot = await runSharedRandomBuild(
      "random-pool-rebuild",
      processPendingRandomPoolRebuilds,
      signal
    );
    signal?.throwIfAborted();
    if (!requireFresh) return snapshot;
    const completedRevision = redisRevision(
      await redis.get(RANDOM_REBUILD_COMPLETED_KEY)
    );
    if (completedRevision >= requiredRevision) {
      signal?.throwIfAborted();
      return await readRandomPoolSnapshot() ?? snapshot;
    }
  }
}

export async function scheduleRandomRebuild() {
  await pool.query(
    `INSERT INTO background_job(id, type, status)
     SELECT $1, 'cache.rebuild', 'pending'
     WHERE NOT EXISTS (
       SELECT 1 FROM background_job
       WHERE type='cache.rebuild' AND status IN ('pending', 'running')
     )`,
    [randomUuidV7()]
  ).catch(() => undefined);
}
