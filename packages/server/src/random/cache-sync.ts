import { pool } from "../core/db.ts";
import { redis } from "../core/redis-client.ts";
import {
  acquireRandomUpdateLock,
  releaseRandomUpdateLock,
  startRandomUpdateLockRenewal
} from "./cache-lock.ts";
import { scheduleRandomRebuild } from "./cache-rebuild.ts";
import {
  GALLERY_FILTER_OPTIONS_KEY,
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
  filterOptionsFromCategoryCounts,
  parseRandomPoolItem,
  randomPoolItemsFromRows,
  type RandomCategoryCounts,
  type RandomPoolItem
} from "./cache-model.ts";
import { RANDOM_INCREMENTAL_APPLY_SCRIPT } from "./cache-scripts.ts";
import {
  RANDOM_INCREMENTAL_MAX_IMAGES,
  RANDOM_INCREMENTAL_MAX_MEMBERSHIP_KEYS
} from "./cache-policy.ts";
import { collectRandomMemberships } from "./cache-writes.ts";

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

function indexMembershipChanges(
  changes: Map<string, string[]>,
  keyIndexes: Map<string, number>
) {
  return [...changes].map(([key, ids]) => {
    const keyIndex = keyIndexes.get(key);
    if (keyIndex === undefined) {
      throw new Error("Random membership key was not indexed");
    }
    return [keyIndex, ids] as const;
  });
}

async function applyRandomIncrementalMutation(
  generation: string,
  token: string,
  mutationRevision: number,
  categoryCounts: RandomCategoryCounts,
  itemValues: string[],
  removedIds: string[],
  removals: Map<string, string[]>,
  additions: Map<string, string[]>,
  touchedKeys: Set<string>
) {
  const membershipKeys = [...touchedKeys];
  const keyIndexes = new Map(
    membershipKeys.map((key, index) => [key, index + 1])
  );
  return Number(await redis.eval(
    RANDOM_INCREMENTAL_APPLY_SCRIPT,
    membershipKeys.length + 8,
    RANDOM_CURRENT_KEY,
    RANDOM_MUTATION_REVISION_KEY,
    RANDOM_REBUILD_COMPLETED_KEY,
    RANDOM_UPDATE_LOCK_KEY,
    randomManifestKey(generation),
    randomItemKey(generation),
    randomSnapshotKey(generation),
    GALLERY_FILTER_OPTIONS_KEY,
    ...membershipKeys,
    generation,
    String(mutationRevision),
    token,
    JSON.stringify({
      itemValues,
      removedIds,
      removals: indexMembershipChanges(removals, keyIndexes),
      additions: indexMembershipChanges(additions, keyIndexes)
    }),
    JSON.stringify({ categoryCounts }),
    JSON.stringify(filterOptionsFromCategoryCounts(categoryCounts))
  )) === 1;
}

export async function syncRandomImages(
  ids: string[]
): Promise<RandomSyncResult> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!uniqueIds.length) return { fullRebuildTriggered: false };
  let fullRebuildTriggered = false;
  try {
    if (uniqueIds.length > RANDOM_INCREMENTAL_MAX_IMAGES) {
      await redis.incr(RANDOM_MUTATION_REVISION_KEY);
      await scheduleRandomRebuild();
      return { fullRebuildTriggered: true };
    }
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
        await scheduleRandomRebuild();
        return { fullRebuildTriggered };
      }
      const [snapshotRaw, oldItemsRaw, currentItems] = await Promise.all([
        redis.get(randomSnapshotKey(generation)),
        redis.hmget(randomItemKey(generation), ...uniqueIds),
        readyRandomItems(uniqueIds)
      ]);
      if (!snapshotRaw) {
        fullRebuildTriggered = true;
        await scheduleRandomRebuild();
        return { fullRebuildTriggered };
      }
      const snapshot = JSON.parse(snapshotRaw) as {
        categoryCounts?: RandomCategoryCounts;
      };
      if (!snapshot.categoryCounts) {
        fullRebuildTriggered = true;
        await scheduleRandomRebuild();
        return { fullRebuildTriggered };
      }

      const categoryCounts = snapshot.categoryCounts;
      const currentById = new Map(
        currentItems.map((item) => [item.id, item])
      );
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

      if (touchedKeys.size > RANDOM_INCREMENTAL_MAX_MEMBERSHIP_KEYS) {
        fullRebuildTriggered = true;
        await scheduleRandomRebuild();
        return { fullRebuildTriggered };
      }

      if (!await lockRenewal.renewNow()) {
        fullRebuildTriggered = true;
        await scheduleRandomRebuild();
        return { fullRebuildTriggered };
      }

      const applied = await applyRandomIncrementalMutation(
        generation,
        token,
        mutationRevision,
        categoryCounts,
        itemValues,
        removedIds,
        removals,
        additions,
        touchedKeys
      );
      if (!applied) {
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
