import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { Brightness, Device } from "@imageshow/shared";
import { pool } from "../core/db.ts";
import { redis } from "../core/redis-client.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import { coalesce } from "../core/coalesce.ts";
import { randomUuidV7 } from "../core/uuid.ts";

export const RANDOM_CURRENT_KEY = "imageshow:random:current";
const RANDOM_MUTATION_REVISION_KEY = "imageshow:random:version";
const RANDOM_UPDATE_LOCK_KEY = "imageshow:random:update_lock";
const RANDOM_REBUILD_LOCK_KEY = "imageshow:random:rebuild_lock";
const RANDOM_REBUILD_COMPLETED_KEY = "imageshow:random:rebuild_completed";
const RANDOM_REBUILD_LOCK_TTL_MS = 120_000;
const RANDOM_REBUILD_WAIT_INTERVAL_MS = 100;
const RANDOM_REBUILD_WAIT_ATTEMPTS = RANDOM_REBUILD_LOCK_TTL_MS / RANDOM_REBUILD_WAIT_INTERVAL_MS;
export const GALLERY_FILTER_OPTIONS_KEY = "imageshow:gallery_filter_options";
const RANDOM_OLD_GENERATION_TTL_SECONDS = 60 * 60;
const RANDOM_FILTER_TTL_SECONDS = 90;

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

function randomManifestKey(generation: string) {
  return randomKey(generation, "keys");
}

export function randomItemKey(generation: string) {
  return randomKey(generation, "item");
}

export function randomCountsKey(generation: string) {
  return randomKey(generation, "counts");
}

export function randomSnapshotKey(generation: string) {
  return randomKey(generation, "snapshot");
}

export function randomThemesKey(generation: string) {
  return randomKey(generation, "themes");
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
  pruneEmptyCategoryCounts(counts);
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

function redisCountsFromCategoryCounts(categoryCounts: RandomCategoryCounts): Record<string, number> {
  const redisCounts: Record<string, number> = {};
  for (const [device, deviceMap] of Object.entries(categoryCounts)) {
    for (const [brightness, brightnessMap] of Object.entries(deviceMap)) {
      let axisCount = 0;
      for (const [theme, rawCount] of Object.entries(brightnessMap)) {
        const count = Number(rawCount);
        if (!Number.isFinite(count) || count <= 0) continue;
        axisCount += count;
        redisCounts[`cat:${device}:${brightness}:${theme}`] = count;
      }
      if (axisCount > 0) redisCounts[`axis:${device}:${brightness}`] = axisCount;
    }
  }
  return redisCounts;
}

async function readyRandomItems(ids?: string[]): Promise<RandomPoolItem[]> {
  const params: unknown[] = [];
  const idFilter = ids?.length ? "AND m.id = ANY($1::uuid[])" : "";
  if (ids?.length) params.push(ids);
  const rows = (await pool.query(
    `SELECT m.id, m.object_key, m.ext, m.device, m.brightness, m.theme,
            m.storage_slug, m.is_link, COALESCE(m.author, '') AS author,
            COALESCE(array_remove(array_agg(it.tag_slug ORDER BY it.tag_slug), NULL), '{}') AS tags
     FROM metadata m
     LEFT JOIN image_tag it ON it.image_id = m.id
     WHERE m.status='ready' ${idFilter}
     GROUP BY m.id
     ORDER BY m.id`,
    params
  )).rows;
  return rows.map((row) => ({
    id: row.id,
    object_key: row.object_key,
    ext: row.ext,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    storage_slug: row.storage_slug,
    is_link: Boolean(row.is_link),
    author: row.author ?? "",
    tags: row.tags ?? []
  }));
}

function registerRandomKeys(generation: string, keys: Set<string>) {
  keys.add(randomManifestKey(generation));
  keys.add(randomItemKey(generation));
  keys.add(randomCountsKey(generation));
  keys.add(randomSnapshotKey(generation));
  keys.add(randomThemesKey(generation));
}

function queuePoolMembership(
  pipeline: ReturnType<Redis["pipeline"]>,
  generation: string,
  item: RandomPoolItem,
  add: boolean,
  keys?: Set<string>
) {
  const axisKey = randomAxisSetKey(generation, item.device, item.brightness);
  const catKey = randomCategorySetKey(generation, item.device, item.brightness, item.theme);
  if (add) {
    pipeline.sadd(axisKey, item.id);
    pipeline.sadd(catKey, item.id);
  } else {
    pipeline.srem(axisKey, item.id);
    pipeline.srem(catKey, item.id);
  }
  keys?.add(axisKey);
  keys?.add(catKey);
  for (const tag of item.tags) {
    const key = randomTagSetKey(generation, tag);
    if (add) pipeline.sadd(key, item.id);
    else pipeline.srem(key, item.id);
    keys?.add(key);
  }
  if (item.author) {
    const key = randomAuthorSetKey(generation, item.author);
    if (add) pipeline.sadd(key, item.id);
    else pipeline.srem(key, item.id);
    keys?.add(key);
  }
}

function queueSnapshot(
  pipeline: ReturnType<Redis["pipeline"]>,
  generation: string,
  categoryCounts: RandomCategoryCounts,
  updateGalleryOptions = true
) {
  const filterOptions = filterOptionsFromCategoryCounts(categoryCounts);
  const redisCounts = redisCountsFromCategoryCounts(categoryCounts);
  pipeline.set(
    randomSnapshotKey(generation),
    JSON.stringify({ categoryCounts, themes: filterOptions.themes })
  );
  pipeline.del(randomCountsKey(generation));
  const countEntries = Object.entries(redisCounts).flatMap(([key, value]) => [key, String(value)]);
  if (countEntries.length) pipeline.hset(randomCountsKey(generation), ...countEntries);
  pipeline.del(randomThemesKey(generation));
  if (filterOptions.themes.length) pipeline.sadd(randomThemesKey(generation), ...filterOptions.themes);
  if (updateGalleryOptions) {
    pipeline.set(GALLERY_FILTER_OPTIONS_KEY, JSON.stringify(filterOptions));
  }
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

async function performRandomPoolRebuild(targetRevision: number): Promise<{
  published: boolean;
  snapshot: RandomPoolSnapshot;
}> {
  const generation = randomUuidV7();
  const items = await readyRandomItems();
  const categoryCounts: RandomCategoryCounts = {};
  const keys = new Set<string>();
  registerRandomKeys(generation, keys);
  const pipeline = redis.pipeline();
  if (items.length) {
    const itemValues: Record<string, string> = {};
    for (const item of items) {
      adjustCategoryCounts(categoryCounts, item, 1);
      itemValues[item.id] = JSON.stringify(item);
      queuePoolMembership(pipeline, generation, item, true, keys);
    }
    pipeline.hset(randomItemKey(generation), ...Object.entries(itemValues).flatMap(([key, value]) => [key, value]));
  }
  queueSnapshot(pipeline, generation, categoryCounts, false);
  pipeline.sadd(randomManifestKey(generation), ...keys);
  await execRedisPipeline(pipeline);
  const themes = filterOptionsFromCategoryCounts(categoryCounts).themes;
  const snapshot = { generation, categoryCounts, themes };
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
  await expireOldGeneration(published ? publication[1] || null : generation);
  return { published, snapshot };
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
    const parsed = JSON.parse(raw) as { categoryCounts?: RandomCategoryCounts; themes?: string[] };
    if (!parsed.categoryCounts || !Array.isArray(parsed.themes)) return null;
    return { generation, categoryCounts: parsed.categoryCounts, themes: parsed.themes };
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
  const locked = await redis.set(RANDOM_UPDATE_LOCK_KEY, token, "PX", 10_000, "NX");
  return locked ? token : "";
}

async function releaseRandomUpdateLock(token: string) {
  await releaseOwnedLock(RANDOM_UPDATE_LOCK_KEY, token);
}

export async function syncRandomImages(ids: string[]) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return;
  try {
    // 数据库变更已提交后先登记 mutation；任何正在构建的 generation 都会在发布前
    // 看到 revision 变化并重读 PostgreSQL，避免覆盖这次增量更新。
    await redis.incr(RANDOM_MUTATION_REVISION_KEY);
    let generation = await redis.get(RANDOM_CURRENT_KEY);
    if (!generation) {
      await rebuildRandomPool({ requireFresh: false });
      return;
    }
    const token = await acquireRandomUpdateLock();
    if (!token) {
      await scheduleRandomRebuild();
      return;
    }
    try {
      generation = await redis.get(RANDOM_CURRENT_KEY);
      if (!generation) {
        await rebuildRandomPool({ requireFresh: false });
        return;
      }
      const [snapshotRaw, oldItemsRaw, currentItems] = await Promise.all([
        redis.get(randomSnapshotKey(generation)),
        redis.hmget(randomItemKey(generation), ...uniqueIds),
        readyRandomItems(uniqueIds)
      ]);
      if (!snapshotRaw) {
        await rebuildRandomPool({ requireFresh: false });
        return;
      }
      const snapshot = JSON.parse(snapshotRaw) as {
        categoryCounts?: RandomCategoryCounts;
      };
      if (!snapshot.categoryCounts) {
        await rebuildRandomPool({ requireFresh: false });
        return;
      }
      const categoryCounts = snapshot.categoryCounts;
      const currentById = new Map(currentItems.map((item) => [item.id, item]));
      const pipeline = redis.pipeline();
      const touchedKeys = new Set<string>();
      for (let index = 0; index < uniqueIds.length; index += 1) {
        const id = uniqueIds[index];
        const oldItem = parseRandomItem(oldItemsRaw[index]);
        const currentItem = currentById.get(id);
        if (oldItem) {
          queuePoolMembership(pipeline, generation, oldItem, false, touchedKeys);
          adjustCategoryCounts(categoryCounts, oldItem, -1);
        }
        if (currentItem) {
          pipeline.hset(randomItemKey(generation), currentItem.id, JSON.stringify(currentItem));
          queuePoolMembership(pipeline, generation, currentItem, true, touchedKeys);
          adjustCategoryCounts(categoryCounts, currentItem, 1);
        } else {
          pipeline.hdel(randomItemKey(generation), id);
        }
      }
      queueSnapshot(pipeline, generation, categoryCounts);
      if (touchedKeys.size) pipeline.sadd(randomManifestKey(generation), ...touchedKeys);
      await execRedisPipeline(pipeline);
    } finally {
      await releaseRandomUpdateLock(token);
    }
  } catch {
    await scheduleRandomRebuild();
  }
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
  const revision = await redis.get(RANDOM_MUTATION_REVISION_KEY).catch(() => "0") ?? "0";
  const signature = `${input.signature}|r=${revision}`;
  const finalKey = randomFilterKey(input.generation, signature, "final");
  const cachedCount = Number(await redis.eval(
    `if redis.call("EXISTS", KEYS[1]) == 0 then return -1 end
     local count = redis.call("SCARD", KEYS[1])
     redis.call("EXPIRE", KEYS[1], ARGV[1])
     return count`,
    1,
    finalKey,
    RANDOM_FILTER_TTL_SECONDS
  ));
  if (cachedCount >= 0) return { key: finalKey, count: cachedCount };

  const tempKeys: string[] = [];
  let current = randomFilterKey(input.generation, signature, "base");
  tempKeys.push(current);
  if (!input.baseSetKeys.length) await redis.del(current);
  else if (input.baseSetKeys.length === 1) await redis.sunionstore(current, input.baseSetKeys[0]);
  else await redis.sunionstore(current, ...input.baseSetKeys);

  const applyUnion = async (kind: "tag" | "author", values: string[], suffix: string) => {
    if (!values.length) return "";
    const key = randomFilterKey(input.generation, signature, suffix);
    const sourceKeys = values.map((value) => kind === "tag" ? randomTagSetKey(input.generation, value) : randomAuthorSetKey(input.generation, value));
    await redis.sunionstore(key, ...sourceKeys);
    tempKeys.push(key);
    return key;
  };

  const intersectWith = async (source: string, suffix: string) => {
    if (!source) return;
    const next = randomFilterKey(input.generation, signature, suffix);
    await redis.sinterstore(next, current, source);
    tempKeys.push(next);
    current = next;
  };

  const diffWith = async (source: string, suffix: string) => {
    if (!source) return;
    const next = randomFilterKey(input.generation, signature, suffix);
    await redis.sdiffstore(next, current, source);
    tempKeys.push(next);
    current = next;
  };

  await intersectWith(await applyUnion("tag", input.tagInclude, "tag-include"), "after-tag-include");
  await diffWith(await applyUnion("tag", input.tagExclude, "tag-exclude"), "after-tag-exclude");
  await intersectWith(await applyUnion("author", input.authorInclude, "author-include"), "after-author-include");
  await diffWith(await applyUnion("author", input.authorExclude, "author-exclude"), "after-author-exclude");

  if (current !== finalKey) {
    await redis.sunionstore(finalKey, current);
  }
  const count = await redis.scard(finalKey);
  const pipeline = redis.pipeline();
  for (const key of tempKeys) pipeline.expire(key, RANDOM_FILTER_TTL_SECONDS);
  pipeline.expire(finalKey, RANDOM_FILTER_TTL_SECONDS);
  await execRedisPipeline(pipeline);
  return { key: finalKey, count };
}
