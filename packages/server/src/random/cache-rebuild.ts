import type { PoolClient } from "pg";
import { pool } from "../core/db.ts";
import { redis } from "../core/redis-client.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import { coalesce } from "../core/coalesce.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import { logger } from "../core/logger.ts";
import {
  createRandomRebuildBatchStore,
  type RandomRebuildBatchStore
} from "./rebuild-spool.ts";
import {
  GALLERY_FILTER_OPTIONS_KEY,
  RANDOM_CACHE_NAMESPACE,
  RANDOM_CLEANUP_BATCH_SIZE,
  RANDOM_CURRENT_KEY,
  RANDOM_GENERATION_PUBLISH_SCRIPT,
  RANDOM_MUTATION_REVISION_KEY,
  RANDOM_OLD_GENERATION_TTL_SECONDS,
  RANDOM_REBUILD_BATCH_SIZE,
  RANDOM_REBUILD_COMPLETED_KEY,
  RANDOM_REBUILD_WAIT_ATTEMPTS,
  RANDOM_REBUILD_WAIT_INTERVAL_MS,
  adjustCategoryCounts,
  chunks,
  collectMembership,
  filterOptionsFromCategoryCounts,
  mapRandomItems,
  queueMembershipMap,
  queueSnapshot,
  randomItemKey,
  randomKey,
  randomManifestKey,
  redisRevision,
  redisUnavailable,
  registerRandomKeys,
  type RandomCategoryCounts,
  type RandomPoolItem,
  type RandomPoolSnapshot
} from "./cache-schema.ts";
import {
  acquireRandomRebuildLock,
  startRandomRebuildLockRenewal
} from "./cache-lock.ts";

async function readyRandomItemBatch(
  client: PoolClient,
  afterId: string | null
): Promise<RandomPoolItem[]> {
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
  return mapRandomItems(rows);
}

async function cleanupFailedGeneration(
  generation: string,
  knownKeys: Set<string>,
  mode: "delete" | "expire" = "delete"
) {
  let current: string | null;
  try {
    current = await redis.get(RANDOM_CURRENT_KEY);
  } catch {
    // 发布结果未知时宁可保留临时键，也不能误删正在服务的 generation。
    return;
  }
  if (current === generation) return;

  const manifest = randomManifestKey(generation);
  const manifestKeys = await redis.smembers(manifest).catch(() => []);
  const prefix = randomKey(generation, "");
  const keys = [...new Set([
    ...knownKeys,
    ...manifestKeys.filter((key) => key.startsWith(prefix)),
    manifest
  ])].filter((key) => key.startsWith(prefix));
  if (!keys.length) return;

  if (mode === "expire") {
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.expire(key, RANDOM_OLD_GENERATION_TTL_SECONDS);
    }
    await execRedisPipeline(pipeline).catch(() => undefined);
    return;
  }

  try {
    for (const batch of chunks(keys, RANDOM_CLEANUP_BATCH_SIZE)) {
      await redis.unlink(...batch);
    }
  } catch {
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.expire(key, RANDOM_OLD_GENERATION_TTL_SECONDS);
    }
    await execRedisPipeline(pipeline).catch(() => undefined);
  }
}

async function writeRandomGenerationBatch(
  generation: string,
  items: RandomPoolItem[],
  categoryCounts: RandomCategoryCounts,
  keys: Set<string>
) {
  if (!items.length) return;
  const memberships = new Map<string, string[]>();
  const itemValues: string[] = [];
  for (const item of items) {
    adjustCategoryCounts(categoryCounts, item, 1);
    itemValues.push(item.id, JSON.stringify(item));
    collectMembership(memberships, generation, item, keys);
  }
  const pipeline = redis.pipeline();
  pipeline.hset(randomItemKey(generation), ...itemValues);
  queueMembershipMap(pipeline, "sadd", memberships);
  await execRedisPipeline(pipeline);
}

async function expireOldGeneration(generation: string | null) {
  if (!generation) return;
  const manifest = randomManifestKey(generation);
  const keys = await redis.smembers(manifest).catch(() => []);
  if (!keys.length) return;
  const pipeline = redis.pipeline();
  const generationPrefix = randomKey(generation, "");
  for (const key of keys) {
    if (key.startsWith(generationPrefix)) {
      pipeline.expire(key, RANDOM_OLD_GENERATION_TTL_SECONDS);
    }
  }
  pipeline.expire(manifest, RANDOM_OLD_GENERATION_TTL_SECONDS);
  await execRedisPipeline(pipeline);
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

async function readReadyRandomItemBatches(): Promise<
  RandomRebuildBatchStore<RandomPoolItem>
> {
  const batchStore = createRandomRebuildBatchStore({
    validateBatch: validateRandomPoolItemBatch
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    let afterId: string | null = null;
    for (;;) {
      const items = await readyRandomItemBatch(client, afterId);
      if (!items.length) break;
      await batchStore.append(items);
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

async function performRandomPoolRebuild(targetRevision: number): Promise<{
  published: boolean;
  snapshot: RandomPoolSnapshot;
}> {
  const generation = randomUuidV7();
  const categoryCounts: RandomCategoryCounts = {};
  const keys = new Set<string>();
  registerRandomKeys(generation, keys);
  let publicationAttempted = false;
  try {
    // PostgreSQL 快照只覆盖数据库读取；COMMIT 后才开始向 Redis 写 generation。
    const itemBatches = await readReadyRandomItemBatches();
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
        await writeRandomGenerationBatch(
          generation,
          items,
          categoryCounts,
          keys
        );
      }
    } finally {
      await itemBatches.cleanup();
    }

    const finalPipeline = redis.pipeline();
    queueSnapshot(finalPipeline, generation, categoryCounts, false);
    for (const batch of chunks([...keys], RANDOM_CLEANUP_BATCH_SIZE)) {
      finalPipeline.sadd(randomManifestKey(generation), ...batch);
    }
    await execRedisPipeline(finalPipeline);

    const themes = filterOptionsFromCategoryCounts(categoryCounts).themes;
    const snapshot = { generation, categoryCounts, themes };
    publicationAttempted = true;
    const publication = await redis.eval(
      RANDOM_GENERATION_PUBLISH_SCRIPT,
      4,
      RANDOM_CURRENT_KEY,
      RANDOM_MUTATION_REVISION_KEY,
      RANDOM_REBUILD_COMPLETED_KEY,
      GALLERY_FILTER_OPTIONS_KEY,
      String(targetRevision),
      generation,
      JSON.stringify(filterOptionsFromCategoryCounts(categoryCounts))
    ) as [number, string];
    const published = Number(publication[0]) === 1;
    if (published) {
      await expireOldGeneration(publication[1] || null).catch(() => undefined);
    } else {
      await cleanupFailedGeneration(generation, keys);
    }
    return { published, snapshot };
  } catch (error) {
    await cleanupFailedGeneration(
      generation,
      keys,
      publicationAttempted ? "expire" : "delete"
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

async function rebuildRandomPoolWhileLocked(token: string) {
  const stopRenewal = startRandomRebuildLockRenewal(token);
  try {
    for (;;) {
      const targetRevision = redisRevision(
        await redis.get(RANDOM_MUTATION_REVISION_KEY)
      );
      const rebuilt = await performRandomPoolRebuild(targetRevision);
      if (rebuilt.published) return rebuilt.snapshot;
    }
  } finally {
    await stopRenewal();
  }
}

async function processPendingRandomPoolRebuilds() {
  for (
    let attempt = 0;
    attempt < RANDOM_REBUILD_WAIT_ATTEMPTS;
    attempt += 1
  ) {
    const [snapshot, requestedRaw, completedRaw] = await Promise.all([
      readRandomPoolSnapshot().catch(() => null),
      redis.get(RANDOM_MUTATION_REVISION_KEY),
      redis.get(RANDOM_REBUILD_COMPLETED_KEY)
    ]);
    const requestedRevision = redisRevision(requestedRaw);
    const completedRevision = redisRevision(completedRaw);
    if (snapshot && completedRevision >= requestedRevision) {
      return await readRandomPoolSnapshot() ?? snapshot;
    }

    const token = await acquireRandomRebuildLock();
    if (token) return rebuildRandomPoolWhileLocked(token);
    await new Promise((resolve) => {
      setTimeout(resolve, RANDOM_REBUILD_WAIT_INTERVAL_MS);
    });
  }

  await scheduleRandomRebuild();
  throw redisUnavailable();
}

export async function rebuildRandomPool(
  options: { requireFresh?: boolean } = {}
): Promise<RandomPoolSnapshot> {
  const requireFresh = options.requireFresh ?? true;
  const requiredRevision = requireFresh
    ? await redis.incr(RANDOM_MUTATION_REVISION_KEY)
    : redisRevision(await redis.get(RANDOM_MUTATION_REVISION_KEY));

  for (;;) {
    const snapshot = await coalesce(
      "random-pool-rebuild",
      processPendingRandomPoolRebuilds
    );
    if (!requireFresh) return snapshot;
    const completedRevision = redisRevision(
      await redis.get(RANDOM_REBUILD_COMPLETED_KEY)
    );
    if (completedRevision >= requiredRevision) {
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
