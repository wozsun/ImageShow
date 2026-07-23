import { pool } from "../core/db.ts";
import { redis } from "../core/redis-client.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import {
  acquireRandomUpdateLock,
  releaseRandomUpdateLock,
  startRandomUpdateLockRenewal
} from "./cache-lock.ts";
import { rebuildRandomPool, scheduleRandomRebuild } from "./cache-rebuild.ts";
import {
  RANDOM_CURRENT_KEY,
  RANDOM_MUTATION_REVISION_KEY,
  RANDOM_REBUILD_COMPLETED_KEY,
  RANDOM_UPDATE_LOCK_KEY,
  randomItemKey,
  randomManifestKey,
  randomSnapshotKey
} from "./cache-keys.ts";
import {
  adjustCategoryCounts,
  parseRandomPoolItem,
  randomPoolItemsFromRows,
  type RandomCategoryCounts,
  type RandomPoolItem
} from "./cache-model.ts";
import { RANDOM_INCREMENTAL_COMPLETE_SCRIPT } from "./cache-scripts.ts";
import {
  collectRandomMemberships,
  queueRandomMemberships,
  queueRandomSnapshot
} from "./cache-writes.ts";

async function readyRandomItems(ids: string[]): Promise<RandomPoolItem[]> {
  const rows = (await pool.query(
    `SELECT m.id, m.object_key, m.ext, m.device, m.brightness, m.theme,
            m.storage_slug,
            COALESCE(m.author, '') AS author,
            COALESCE(array_remove(array_agg(it.tag_slug ORDER BY it.tag_slug), NULL), '{}') AS tags
       FROM metadata m
       LEFT JOIN image_tag it ON it.image_id = m.id
      WHERE m.status='ready' AND m.id = ANY($1::uuid[])
      GROUP BY m.id
      ORDER BY m.id`,
    [ids]
  )).rows;
  return randomPoolItemsFromRows(rows);
}

type RandomSyncResult = {
  fullRebuildTriggered: boolean;
};

export async function syncRandomImages(
  ids: string[]
): Promise<RandomSyncResult> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return { fullRebuildTriggered: false };
  let fullRebuildTriggered = false;
  try {
    const token = await acquireRandomUpdateLock();
    if (!token) {
      // 先推进 revision，防止正在构建的旧数据库快照被发布。
      await redis.incr(RANDOM_MUTATION_REVISION_KEY);
      fullRebuildTriggered = true;
      await scheduleRandomRebuild();
      return { fullRebuildTriggered };
    }
    const lockRenewal = startRandomUpdateLockRenewal(token);
    try {
      const mutationRevision = await redis.incr(
        RANDOM_MUTATION_REVISION_KEY
      );
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
      const snapshot = JSON.parse(snapshotRaw) as {
        categoryCounts?: RandomCategoryCounts;
      };
      if (!snapshot.categoryCounts) {
        fullRebuildTriggered = true;
        await rebuildRandomPool({ requireFresh: false });
        return { fullRebuildTriggered };
      }

      const categoryCounts = snapshot.categoryCounts;
      const currentById = new Map(
        currentItems.map((item) => [item.id, item])
      );
      const pipeline = redis.pipeline();
      const touchedKeys = new Set<string>();
      const removals = new Map<string, string[]>();
      const additions = new Map<string, string[]>();
      const itemValues: string[] = [];
      const removedIds: string[] = [];

      for (let index = 0; index < uniqueIds.length; index += 1) {
        const id = uniqueIds[index];
        const oldItem = parseRandomPoolItem(oldItemsRaw[index]);
        const currentItem = currentById.get(id);
        if (oldItem) {
          collectRandomMemberships(removals, generation, oldItem, touchedKeys);
          adjustCategoryCounts(categoryCounts, oldItem, -1);
        }
        if (currentItem) {
          itemValues.push(currentItem.id, JSON.stringify(currentItem));
          collectRandomMemberships(additions, generation, currentItem, touchedKeys);
          adjustCategoryCounts(categoryCounts, currentItem, 1);
        } else {
          removedIds.push(id);
        }
      }

      queueRandomMemberships(pipeline, "srem", removals);
      queueRandomMemberships(pipeline, "sadd", additions);
      if (itemValues.length) {
        pipeline.hset(randomItemKey(generation), ...itemValues);
      }
      if (removedIds.length) {
        pipeline.hdel(randomItemKey(generation), ...removedIds);
      }
      queueRandomSnapshot(pipeline, generation, categoryCounts);
      if (touchedKeys.size) {
        pipeline.sadd(randomManifestKey(generation), ...touchedKeys);
      }
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
            token
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
