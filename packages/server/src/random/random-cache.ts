import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { PoolClient } from "pg";
import type { Brightness, Device } from "@imageshow/shared";
import { pool } from "../core/db.ts";
import { redis } from "../core/redis-client.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import { coalesce } from "../core/coalesce.ts";
import { randomUuidV7 } from "../core/uuid.ts";
import { logger } from "../core/logger.ts";
import {
  createRandomRebuildBatchStore,
  type RandomRebuildBatchStore,
} from "./rebuild-spool.ts";

export const RANDOM_CURRENT_KEY = "imageshow:random:current";
export const RANDOM_MUTATION_REVISION_KEY = "imageshow:random:version";
/** @internal Exported only for lock ownership verification. */
export const RANDOM_UPDATE_LOCK_KEY = "imageshow:random:update_lock";
const RANDOM_REBUILD_LOCK_KEY = "imageshow:random:rebuild_lock";
export const RANDOM_REBUILD_COMPLETED_KEY = "imageshow:random:rebuild_completed";
/** @internal Exported only for lock renewal verification. */
export const RANDOM_UPDATE_LOCK_TTL_MS = 30_000;
const RANDOM_UPDATE_LOCK_RENEW_INTERVAL_MS = 10_000;
const RANDOM_REBUILD_LOCK_TTL_MS = 120_000;
const RANDOM_REBUILD_WAIT_INTERVAL_MS = 100;
const RANDOM_REBUILD_WAIT_ATTEMPTS = RANDOM_REBUILD_LOCK_TTL_MS / RANDOM_REBUILD_WAIT_INTERVAL_MS;
export const GALLERY_FILTER_OPTIONS_KEY = "imageshow:gallery_filter_options";
const RANDOM_OLD_GENERATION_TTL_SECONDS = 60 * 60;
const RANDOM_FILTER_TTL_SECONDS = 90;
const RANDOM_FILTER_BUILD_MAX_ATTEMPTS = 8;
const RANDOM_FILTER_BUILD_RETRY_INTERVAL_MS = 25;
const RANDOM_REBUILD_BATCH_SIZE = 500;
const RANDOM_CLEANUP_BATCH_SIZE = 500;

/** @internal Exported only for atomic generation publication verification. */
export const RANDOM_GENERATION_PUBLISH_SCRIPT = `
  local currentRevision = tonumber(redis.call("GET", KEYS[2]) or "0")
  if currentRevision ~= tonumber(ARGV[1]) then return { 0, "" } end
  local previousGeneration = redis.call("GET", KEYS[1]) or ""
  redis.call("SET", KEYS[1], ARGV[2])
  redis.call("SET", KEYS[3], ARGV[1])
  redis.call("SET", KEYS[4], ARGV[3])
  return { 1, previousGeneration }
`;

/** @internal Exported only for mutation revision consistency verification. */
export const RANDOM_INCREMENTAL_COMPLETE_SCRIPT = `
  local currentGeneration = redis.call("GET", KEYS[1]) or ""
  local currentRevision = tonumber(redis.call("GET", KEYS[2]) or "0")
  local currentToken = redis.call("GET", KEYS[4]) or ""
  if currentGeneration ~= ARGV[1]
    or currentRevision ~= tonumber(ARGV[2])
    or currentToken ~= ARGV[3] then
    return 0
  end
  redis.call("SET", KEYS[3], ARGV[2])
  return 1
`;

/** @internal Exported only for lock renewal verification. */
export const RANDOM_UPDATE_LOCK_RENEW_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("PEXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;

/** @internal Exported only for filtered-set revision verification. */
export const RANDOM_FILTER_CACHE_READ_SCRIPT = `
  if redis.call("EXISTS", KEYS[5]) == 1 then return -2 end
  local currentRevision = redis.call("GET", KEYS[3]) or "0"
  local completedRevision = tonumber(redis.call("GET", KEYS[4]) or "0")
  if currentRevision ~= ARGV[1]
    or completedRevision < tonumber(currentRevision) then
    return -2
  end
  if redis.call("EXISTS", KEYS[1]) == 1 then
    local count = redis.call("SCARD", KEYS[1])
    redis.call("EXPIRE", KEYS[1], ARGV[2])
    return count
  end
  if redis.call("EXISTS", KEYS[2]) == 1 then
    redis.call("EXPIRE", KEYS[2], ARGV[2])
    return 0
  end
  return -1
`;

/** @internal Exported only for filtered-set revision verification. */
export const RANDOM_FILTER_PUBLISH_SCRIPT = `
  if redis.call("EXISTS", KEYS[6]) == 1 then
    redis.call("UNLINK", KEYS[3])
    return { 0, 0 }
  end
  local currentRevision = redis.call("GET", KEYS[4]) or "0"
  local completedRevision = tonumber(redis.call("GET", KEYS[5]) or "0")
  if currentRevision ~= ARGV[1]
    or completedRevision < tonumber(currentRevision) then
    redis.call("UNLINK", KEYS[3])
    return { 0, 0 }
  end
  local count = redis.call("SCARD", KEYS[3])
  if count == 0 then
    redis.call("UNLINK", KEYS[1])
    redis.call("SET", KEYS[2], "1", "EX", ARGV[2])
    redis.call("UNLINK", KEYS[3])
  else
    redis.call("RENAME", KEYS[3], KEYS[1])
    redis.call("EXPIRE", KEYS[1], ARGV[2])
    redis.call("UNLINK", KEYS[2])
  end
  return { 1, count }
`;

export type RandomCategoryCounts = Record<string, Record<string, Record<string, number>>>;
export type GalleryFilterOptions = { devices: string[]; brightnesses: string[]; themes: string[] };
export type RandomPoolSnapshot = {
  generation: string;
  categoryCounts: RandomCategoryCounts;
  themes: string[];
};
export type RandomPoolItem = {
  id: string;
  object_key: string;
  ext: string;
  device: Device;
  brightness: Brightness;
  theme: string;
  storage_slug: string;
  is_link: boolean;
  author: string;
  tags: string[];
};

function redisUnavailable(): Error {
  const error = new Error("Redis unavailable");
  error.name = "redis_unavailable";
  return error;
}

function randomKey(generation: string, ...parts: string[]) {
  return ["imageshow:random", generation, ...parts].join(":");
}

export function randomManifestKey(generation: string) {
  return randomKey(generation, "keys");
}

export function randomItemKey(generation: string) {
  return randomKey(generation, "item");
}

export function randomSnapshotKey(generation: string) {
  return randomKey(generation, "snapshot");
}

export function randomAxisSetKey(generation: string, device: string, brightness: string) {
  return randomKey(generation, "axis", device, brightness);
}

export function randomCategorySetKey(generation: string, device: string, brightness: string, theme: string) {
  return randomKey(generation, "cat", device, brightness, theme);
}

function randomTagSetKey(generation: string, tag: string) {
  return randomKey(generation, "tag", tag);
}

function randomAuthorSetKey(generation: string, author: string) {
  return randomKey(generation, "author", author);
}

function randomFilterKey(generation: string, signature: string, suffix: string) {
  const hash = createHash("sha1").update(signature).digest("hex");
  return randomKey(generation, "filter", hash, suffix);
}

function parseRandomItem(raw: string | null): RandomPoolItem | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RandomPoolItem;
  } catch {
    return null;
  }
}

function adjustCategoryCounts(
  counts: RandomCategoryCounts,
  item: Pick<RandomPoolItem, "device" | "brightness" | "theme">,
  delta: number
) {
  counts[item.device] ??= {};
  counts[item.device][item.brightness] ??= {};
  counts[item.device][item.brightness][item.theme] = Math.max(
    0,
    Number(counts[item.device][item.brightness][item.theme] ?? 0) + delta
  );
  if (delta < 0) pruneEmptyCategoryCounts(counts);
}

function pruneEmptyCategoryCounts(counts: RandomCategoryCounts) {
  for (const [device, deviceMap] of Object.entries(counts)) {
    for (const [brightness, brightnessMap] of Object.entries(deviceMap)) {
      for (const [theme, count] of Object.entries(brightnessMap)) {
        if (!Number.isFinite(Number(count)) || Number(count) <= 0) delete brightnessMap[theme];
      }
      if (!Object.keys(brightnessMap).length) delete deviceMap[brightness];
    }
    if (!Object.keys(deviceMap).length) delete counts[device];
  }
}

function filterOptionsFromCategoryCounts(counts: RandomCategoryCounts): GalleryFilterOptions {
  const themes = new Set<string>();
  for (const device of Object.values(counts)) {
    for (const brightness of Object.values(device)) {
      for (const theme of Object.keys(brightness)) themes.add(theme);
    }
  }
  return { devices: ["pc", "mb"], brightnesses: ["light", "dark"], themes: [...themes].sort() };
}

function mapRandomItems(rows: Array<Record<string, unknown>>): RandomPoolItem[] {
  return rows.map((row) => ({
    id: String(row.id),
    object_key: String(row.object_key),
    ext: String(row.ext),
    device: row.device as Device,
    brightness: row.brightness as Brightness,
    theme: String(row.theme),
    storage_slug: String(row.storage_slug),
    is_link: Boolean(row.is_link),
    author: typeof row.author === "string" ? row.author : "",
    tags: Array.isArray(row.tags) ? row.tags as string[] : []
  }));
}

async function readyRandomItems(ids?: string[]): Promise<RandomPoolItem[]> {
  const params: unknown[] = [];
  const idFilter = ids?.length ? "AND m.id = ANY($1::uuid[])" : "";
  if (ids?.length) params.push(ids);
  const rows = (await pool.query(
    `SELECT m.id, m.object_key, m.ext, m.device, m.brightness, m.theme,
            m.storage_slug, m.is_link,
            COALESCE(m.author, '') AS author,
            COALESCE(array_remove(array_agg(it.tag_slug ORDER BY it.tag_slug), NULL), '{}') AS tags
     FROM metadata m
     LEFT JOIN image_tag it ON it.image_id = m.id
     WHERE m.status='ready' ${idFilter}
     GROUP BY m.id
     ORDER BY m.id`,
    params
  )).rows;
  return mapRandomItems(rows);
}

async function readyRandomItemBatch(
  client: PoolClient,
  afterId: string | null
): Promise<RandomPoolItem[]> {
  const rows = (await client.query(
    `WITH ready AS (
       SELECT m.id, m.object_key, m.ext, m.device, m.brightness, m.theme,
              m.storage_slug, m.is_link, m.author
         FROM metadata m
        WHERE m.status='ready'
          AND ($1::uuid IS NULL OR m.id > $1::uuid)
        ORDER BY m.id
        LIMIT $2
     )
     SELECT ready.id, ready.object_key, ready.ext, ready.device, ready.brightness,
            ready.theme, ready.storage_slug, ready.is_link,
            COALESCE(ready.author, '') AS author,
            COALESCE(array_remove(array_agg(it.tag_slug ORDER BY it.tag_slug), NULL), '{}') AS tags
       FROM ready
       LEFT JOIN image_tag it ON it.image_id = ready.id
      GROUP BY ready.id, ready.object_key, ready.ext, ready.device, ready.brightness,
               ready.theme, ready.storage_slug, ready.is_link, ready.author
      ORDER BY ready.id`,
    [afterId, RANDOM_REBUILD_BATCH_SIZE]
  )).rows;
  return mapRandomItems(rows);
}

function registerRandomKeys(generation: string, keys: Set<string>) {
  keys.add(randomManifestKey(generation));
  keys.add(randomItemKey(generation));
  keys.add(randomSnapshotKey(generation));
}

function membershipKeys(
  generation: string,
  item: RandomPoolItem
): string[] {
  const keys = [
    randomAxisSetKey(generation, item.device, item.brightness),
    randomCategorySetKey(generation, item.device, item.brightness, item.theme)
  ];
  for (const tag of item.tags) {
    keys.push(randomTagSetKey(generation, tag));
  }
  if (item.author) keys.push(randomAuthorSetKey(generation, item.author));
  return keys;
}

function collectMembership(
  target: Map<string, string[]>,
  generation: string,
  item: RandomPoolItem,
  keys?: Set<string>
) {
  for (const key of membershipKeys(generation, item)) {
    const ids = target.get(key);
    if (ids) ids.push(item.id);
    else target.set(key, [item.id]);
    keys?.add(key);
  }
}

function queueMembershipMap(
  pipeline: ReturnType<Redis["pipeline"]>,
  command: "sadd" | "srem",
  memberships: Map<string, string[]>
) {
  for (const [key, ids] of memberships) pipeline[command](key, ...ids);
}

function queueSnapshot(
  pipeline: ReturnType<Redis["pipeline"]>,
  generation: string,
  categoryCounts: RandomCategoryCounts,
  updateGalleryOptions = true
) {
  pipeline.set(
    randomSnapshotKey(generation),
    JSON.stringify({ categoryCounts })
  );
  if (updateGalleryOptions) {
    const filterOptions = filterOptionsFromCategoryCounts(categoryCounts);
    pipeline.set(GALLERY_FILTER_OPTIONS_KEY, JSON.stringify(filterOptions));
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
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
    // Publication may have succeeded even if its response was lost. Without a
    // reliable current-generation read, cleanup must prefer leaking temporary
    // keys over deleting a generation that is already serving traffic.
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
    for (const key of keys) pipeline.expire(key, RANDOM_OLD_GENERATION_TTL_SECONDS);
    await execRedisPipeline(pipeline).catch(() => undefined);
    return;
  }

  try {
    for (const batch of chunks(keys, RANDOM_CLEANUP_BATCH_SIZE)) {
      await redis.unlink(...batch);
    }
  } catch {
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.expire(key, RANDOM_OLD_GENERATION_TTL_SECONDS);
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
    if (key.startsWith(generationPrefix)) pipeline.expire(key, RANDOM_OLD_GENERATION_TTL_SECONDS);
  }
  pipeline.expire(manifest, RANDOM_OLD_GENERATION_TTL_SECONDS);
  await execRedisPipeline(pipeline);
}

function validateRandomPoolItemBatch(value: unknown): RandomPoolItem[] {
  if (!Array.isArray(value) || !value.length || value.length > RANDOM_REBUILD_BATCH_SIZE) {
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
      || typeof item.is_link !== "boolean"
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

async function readReadyRandomItemBatches(): Promise<RandomRebuildBatchStore<RandomPoolItem>> {
  const batchStore = createRandomRebuildBatchStore({
    validateBatch: validateRandomPoolItemBatch,
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
    // PostgreSQL snapshot lifetime covers database reads only. Redis generation
    // writes begin after COMMIT, so a slow Redis cannot pin the database snapshot.
    const itemBatches = await readReadyRandomItemBatches();
    try {
      const sourceStats = itemBatches.stats();
      logger.info("random_pool_rebuild_source_ready", {
        item_count: sourceStats.itemCount,
        batch_count: sourceStats.batchCount,
        serialized_bytes: sourceStats.serializedBytes,
        peak_memory_payload_bytes: sourceStats.peakMemoryPayloadBytes,
        source_storage: sourceStats.storage,
        spool_bytes: sourceStats.spoolBytes,
      });
      for await (const items of itemBatches.batches()) {
        await writeRandomGenerationBatch(generation, items, categoryCounts, keys);
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
    }
    else await cleanupFailedGeneration(generation, keys);
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

async function releaseOwnedLock(key: string, token: string) {
  const script = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0
  `;
  await redis.eval(script, 1, key, token).catch(() => undefined);
}

async function readRandomPoolSnapshot(): Promise<RandomPoolSnapshot | null> {
  const result = await redis.eval(
    `local generation = redis.call("GET", KEYS[1])
     if not generation then return {} end
     local raw = redis.call("GET", ARGV[1] .. generation .. ARGV[2])
     if not raw then return { generation } end
     return { generation, raw }`,
    1,
    RANDOM_CURRENT_KEY,
    "imageshow:random:",
    ":snapshot"
  ) as string[];
  const [generation, raw] = result;
  if (!generation || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as { categoryCounts?: RandomCategoryCounts };
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

function redisRevision(raw: string | null) {
  const revision = Number(raw ?? "0");
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
}

async function rebuildRandomPoolWhileLocked(token: string) {
  const renewal = setInterval(() => {
    void redis.eval(
      `if redis.call("GET", KEYS[1]) == ARGV[1] then
         return redis.call("PEXPIRE", KEYS[1], ARGV[2])
       end
       return 0`,
      1,
      RANDOM_REBUILD_LOCK_KEY,
      token,
      RANDOM_REBUILD_LOCK_TTL_MS
    ).catch(() => undefined);
  }, 30_000);
  renewal.unref();

  try {
    for (;;) {
      // 所有全量与增量变更共享同一 revision。构建完成后只有 revision 仍未变化，
      // Lua 才会原子切换 current generation；否则丢弃未发布 generation 并重做。
      const targetRevision = redisRevision(await redis.get(RANDOM_MUTATION_REVISION_KEY));
      const rebuilt = await performRandomPoolRebuild(targetRevision);
      if (rebuilt.published) return rebuilt.snapshot;
    }
  } finally {
    clearInterval(renewal);
    await releaseOwnedLock(RANDOM_REBUILD_LOCK_KEY, token);
  }
}

async function processPendingRandomPoolRebuilds() {
  for (let attempt = 0; attempt < RANDOM_REBUILD_WAIT_ATTEMPTS; attempt += 1) {
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

    const token = randomUuidV7();
    const locked = await redis.set(
      RANDOM_REBUILD_LOCK_KEY,
      token,
      "PX",
      RANDOM_REBUILD_LOCK_TTL_MS,
      "NX"
    );
    if (locked) return rebuildRandomPoolWhileLocked(token);
    await new Promise((resolve) => setTimeout(resolve, RANDOM_REBUILD_WAIT_INTERVAL_MS));
  }

  await scheduleRandomRebuild();
  throw redisUnavailable();
}

export async function rebuildRandomPool(options: { requireFresh?: boolean } = {}): Promise<RandomPoolSnapshot> {
  const requireFresh = options.requireFresh ?? true;
  const requiredRevision = requireFresh
    ? await redis.incr(RANDOM_MUTATION_REVISION_KEY)
    : redisRevision(await redis.get(RANDOM_MUTATION_REVISION_KEY));

  for (;;) {
    const snapshot = await coalesce("random-pool-rebuild", processPendingRandomPoolRebuilds);
    if (!requireFresh) return snapshot;
    const completedRevision = redisRevision(await redis.get(RANDOM_REBUILD_COMPLETED_KEY));
    if (completedRevision >= requiredRevision) return await readRandomPoolSnapshot() ?? snapshot;
  }
}

async function scheduleRandomRebuild() {
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

async function acquireRandomUpdateLock() {
  const token = randomUuidV7();
  const locked = await redis.set(
    RANDOM_UPDATE_LOCK_KEY,
    token,
    "PX",
    RANDOM_UPDATE_LOCK_TTL_MS,
    "NX",
  );
  return locked ? token : "";
}

async function releaseRandomUpdateLock(token: string) {
  await releaseOwnedLock(RANDOM_UPDATE_LOCK_KEY, token);
}

/** @internal Exported only for local ownership and TTL verification. */
export async function renewRandomUpdateLock(token: string) {
  const renewed = await redis.eval(
    RANDOM_UPDATE_LOCK_RENEW_SCRIPT,
    1,
    RANDOM_UPDATE_LOCK_KEY,
    token,
    RANDOM_UPDATE_LOCK_TTL_MS,
  );
  return Number(renewed) === 1;
}

function startRandomUpdateLockRenewal(token: string) {
  let ownershipLost = false;
  let stopped = false;
  let renewalChain = Promise.resolve();

  const renew = async () => {
    if (stopped || ownershipLost) return !ownershipLost;
    try {
      if (!await renewRandomUpdateLock(token)) ownershipLost = true;
    } catch {
      // A failed ownership check is treated conservatively. The incremental
      // update must not publish a completed revision after an uncertain lease.
      ownershipLost = true;
    }
    return !ownershipLost;
  };
  const queueRenewal = () => {
    const result = renewalChain.then(renew);
    renewalChain = result.then(() => undefined, () => undefined);
    return result;
  };
  const timer = setInterval(() => {
    void queueRenewal();
  }, RANDOM_UPDATE_LOCK_RENEW_INTERVAL_MS);
  timer.unref();

  return {
    ownershipLost: () => ownershipLost,
    renewNow: queueRenewal,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await renewalChain;
    },
  };
}

export type RandomSyncResult = {
  fullRebuildTriggered: boolean;
};

export async function syncRandomImages(ids: string[]): Promise<RandomSyncResult> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return { fullRebuildTriggered: false };
  let fullRebuildTriggered = false;
  try {
    const token = await acquireRandomUpdateLock();
    if (!token) {
      // 数据库变更已经提交，必须立即推进 revision，防止正在重建的旧快照发布。
      // completed revision 会保持落后，使筛选集合在全量重建追平前拒绝物化。
      await redis.incr(RANDOM_MUTATION_REVISION_KEY);
      fullRebuildTriggered = true;
      await scheduleRandomRebuild();
      return { fullRebuildTriggered };
    }
    const lockRenewal = startRandomUpdateLockRenewal(token);
    try {
      // 在增量锁内登记 mutation，使筛选集合从 revision 变化前一直阻塞到
      // 当前 generation 更新完成并同步推进 completed revision。
      const mutationRevision = await redis.incr(RANDOM_MUTATION_REVISION_KEY);
      const generation = await redis.get(RANDOM_CURRENT_KEY);
      if (!generation) {
        fullRebuildTriggered = true;
        await rebuildRandomPool({ requireFresh: false });
        return { fullRebuildTriggered };
      }
      const [snapshotRaw, oldItemsRaw, currentItems] = await Promise.all([
        redis.get(randomSnapshotKey(generation)),
        redis.hmget(randomItemKey(generation), ...uniqueIds),
        readyRandomItems(uniqueIds)
      ]);
      if (!snapshotRaw) {
        fullRebuildTriggered = true;
        await rebuildRandomPool({ requireFresh: false });
        return { fullRebuildTriggered };
      }
      const snapshot = JSON.parse(snapshotRaw) as { categoryCounts?: RandomCategoryCounts };
      if (!snapshot.categoryCounts) {
        fullRebuildTriggered = true;
        await rebuildRandomPool({ requireFresh: false });
        return { fullRebuildTriggered };
      }
      const categoryCounts = snapshot.categoryCounts;
      const currentById = new Map(currentItems.map((item) => [item.id, item]));
      const pipeline = redis.pipeline();
      const touchedKeys = new Set<string>();
      const removals = new Map<string, string[]>();
      const additions = new Map<string, string[]>();
      const itemValues: string[] = [];
      const removedIds: string[] = [];
      for (let index = 0; index < uniqueIds.length; index += 1) {
        const id = uniqueIds[index];
        const oldItem = parseRandomItem(oldItemsRaw[index]);
        const currentItem = currentById.get(id);
        if (oldItem) {
          collectMembership(removals, generation, oldItem, touchedKeys);
          adjustCategoryCounts(categoryCounts, oldItem, -1);
        }
        if (currentItem) {
          itemValues.push(currentItem.id, JSON.stringify(currentItem));
          collectMembership(additions, generation, currentItem, touchedKeys);
          adjustCategoryCounts(categoryCounts, currentItem, 1);
        } else {
          removedIds.push(id);
        }
      }
      queueMembershipMap(pipeline, "srem", removals);
      queueMembershipMap(pipeline, "sadd", additions);
      if (itemValues.length) pipeline.hset(randomItemKey(generation), ...itemValues);
      if (removedIds.length) pipeline.hdel(randomItemKey(generation), ...removedIds);
      queueSnapshot(pipeline, generation, categoryCounts);
      if (touchedKeys.size) pipeline.sadd(randomManifestKey(generation), ...touchedKeys);
      if (!await lockRenewal.renewNow()) {
        fullRebuildTriggered = true;
        await scheduleRandomRebuild();
        return { fullRebuildTriggered };
      }
      await execRedisPipeline(pipeline);
      const completed = lockRenewal.ownershipLost()
        ? 0
        : Number(await redis.eval(
            RANDOM_INCREMENTAL_COMPLETE_SCRIPT,
            4,
            RANDOM_CURRENT_KEY,
            RANDOM_MUTATION_REVISION_KEY,
            RANDOM_REBUILD_COMPLETED_KEY,
            RANDOM_UPDATE_LOCK_KEY,
            generation,
            String(mutationRevision),
            token,
          ));
      if (!completed) {
        fullRebuildTriggered = true;
        await scheduleRandomRebuild();
      }
    } finally {
      await lockRenewal.stop();
      await releaseRandomUpdateLock(token);
    }
  } catch {
    fullRebuildTriggered = true;
    await scheduleRandomRebuild();
  }
  return { fullRebuildTriggered };
}

export const syncRandomImage = (id: string) => syncRandomImages([id]);

export async function getRandomPoolSnapshot(): Promise<RandomPoolSnapshot> {
  try {
    return await readRandomPoolSnapshot() ?? await rebuildRandomPool({ requireFresh: false });
  } catch {
    throw redisUnavailable();
  }
}

export async function getRandomCategoryCounts() {
  return (await getRandomPoolSnapshot()).categoryCounts;
}

export async function getGalleryFilterOptions() {
  try {
    const raw = await redis.get(GALLERY_FILTER_OPTIONS_KEY);
    if (raw) return JSON.parse(raw) as GalleryFilterOptions;
    return filterOptionsFromCategoryCounts(
      (await getRandomPoolSnapshot()).categoryCounts
    );
  } catch {
    const result = await pool.query(
      "SELECT DISTINCT theme FROM metadata WHERE status='ready' ORDER BY theme"
    );
    return { devices: ["pc", "mb"], brightnesses: ["light", "dark"], themes: result.rows.map((row) => row.theme as string) };
  }
}

export async function sampleRandomPoolItems(setKey: string, count: number, generation: string): Promise<RandomPoolItem[]> {
  const raws = await redis.eval(
    `local ids = redis.call("SRANDMEMBER", KEYS[1], ARGV[1])
     if #ids == 0 then return {} end
     return redis.call("HMGET", KEYS[2], unpack(ids))`,
    2,
    setKey,
    randomItemKey(generation),
    Math.max(1, count)
  ) as Array<string | null>;
  return raws.map(parseRandomItem).filter((item): item is RandomPoolItem => Boolean(item));
}

export async function buildRandomFilterSet(input: {
  generation: string;
  signature: string;
  baseSetKeys: string[];
  tagInclude: string[];
  tagExclude: string[];
  authorInclude: string[];
  authorExclude: string[];
}): Promise<{ key: string; count: number }> {
  for (let attempt = 0; attempt < RANDOM_FILTER_BUILD_MAX_ATTEMPTS; attempt += 1) {
    const revision = await redis.get(RANDOM_MUTATION_REVISION_KEY).catch(() => "0") ?? "0";
    const signature = `${input.signature}|r=${revision}`;
    const finalKey = randomFilterKey(input.generation, signature, "final");
    const emptyKey = randomFilterKey(input.generation, signature, "empty");
    const result = await coalesce(`random-filter:${finalKey}`, async () => {
      const cachedCount = Number(await redis.eval(
        RANDOM_FILTER_CACHE_READ_SCRIPT,
        5,
        finalKey,
        emptyKey,
        RANDOM_MUTATION_REVISION_KEY,
        RANDOM_REBUILD_COMPLETED_KEY,
        RANDOM_UPDATE_LOCK_KEY,
        revision,
        RANDOM_FILTER_TTL_SECONDS
      ));
      if (cachedCount === -2) return null;
      if (cachedCount >= 0) return { key: finalKey, count: cachedCount };

      const tempKeys: string[] = [];
      const buildToken = randomUuidV7();
      let current = randomFilterKey(input.generation, signature, `base-${buildToken}`);
      const candidateKey = randomFilterKey(
        input.generation,
        signature,
        `candidate-${buildToken}`
      );
      tempKeys.push(current);
      try {
        if (!input.baseSetKeys.length) await redis.del(current);
        else if (input.baseSetKeys.length === 1) await redis.sunionstore(current, input.baseSetKeys[0]);
        else await redis.sunionstore(current, ...input.baseSetKeys);

        const applyUnion = async (kind: "tag" | "author", values: string[], suffix: string) => {
          if (!values.length) return "";
          const key = randomFilterKey(input.generation, signature, `${suffix}-${buildToken}`);
          const sourceKeys = values.map((value) => kind === "tag" ? randomTagSetKey(input.generation, value) : randomAuthorSetKey(input.generation, value));
          tempKeys.push(key);
          await redis.sunionstore(key, ...sourceKeys);
          return key;
        };

        const intersectWith = async (source: string, suffix: string) => {
          if (!source) return;
          const next = randomFilterKey(input.generation, signature, `${suffix}-${buildToken}`);
          tempKeys.push(next);
          await redis.sinterstore(next, current, source);
          current = next;
        };

        const diffWith = async (source: string, suffix: string) => {
          if (!source) return;
          const next = randomFilterKey(input.generation, signature, `${suffix}-${buildToken}`);
          tempKeys.push(next);
          await redis.sdiffstore(next, current, source);
          current = next;
        };

        await intersectWith(await applyUnion("tag", input.tagInclude, "tag-include"), "after-tag-include");
        await diffWith(await applyUnion("tag", input.tagExclude, "tag-exclude"), "after-tag-exclude");
        await intersectWith(await applyUnion("author", input.authorInclude, "author-include"), "after-author-include");
        await diffWith(await applyUnion("author", input.authorExclude, "author-exclude"), "after-author-exclude");

        await redis.sunionstore(candidateKey, current);
        const publication = await redis.eval(
          RANDOM_FILTER_PUBLISH_SCRIPT,
          6,
          finalKey,
          emptyKey,
          candidateKey,
          RANDOM_MUTATION_REVISION_KEY,
          RANDOM_REBUILD_COMPLETED_KEY,
          RANDOM_UPDATE_LOCK_KEY,
          revision,
          RANDOM_FILTER_TTL_SECONDS
        ) as [number, number];
        const pipeline = redis.pipeline();
        for (const key of tempKeys) pipeline.expire(key, RANDOM_FILTER_TTL_SECONDS);
        await execRedisPipeline(pipeline);
        if (!Number(publication[0])) return null;
        return { key: finalKey, count: Number(publication[1]) };
      } catch (error) {
        const cleanup = redis.pipeline();
        for (const key of new Set([...tempKeys, candidateKey])) {
          cleanup.expire(key, RANDOM_FILTER_TTL_SECONDS);
        }
        await execRedisPipeline(cleanup).catch(() => undefined);
        throw error;
      }
    });
    if (result) return result;
    if (attempt + 1 < RANDOM_FILTER_BUILD_MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RANDOM_FILTER_BUILD_RETRY_INTERVAL_MS));
    }
  }
  await scheduleRandomRebuild();
  throw redisUnavailable();
}
