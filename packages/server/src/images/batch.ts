import { indexKey } from "@imageshow/shared";
import { cleanupEmptyCategories, pool } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { invalidateImageReadCaches, invalidateMd5Caches, bumpFolder } from "../core/redis.js";
import { enqueueMany } from "../jobs/tasks.js";
import type { ImageRecord } from "./presenter.js";

export async function batchDeleteImages(ids: string[]) {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (uniqueIds.some((id) => !uuidPattern.test(id))) {
    throw new ApiError(400, "validation_error", "Validation failed", { ids: "ids must be UUID strings" });
  }
  if (!uniqueIds.length) return { deleted: 0, ignored: 0 };
  const readyRows = (await pool.query(
    "SELECT id, category_key FROM metadata WHERE id = ANY($1::uuid[]) AND status='ready' ORDER BY category_key, id",
    [uniqueIds]
  )).rows as Array<{ id: string; category_key: string }>;
  const groups = new Map<string, string[]>();
  for (const row of readyRows) {
    const list = groups.get(row.category_key) ?? [];
    list.push(row.id);
    groups.set(row.category_key, list);
  }
  let deleted = 0;
  const deletedTargets: ImageRecord[] = [];
  for (const [category, groupIds] of groups) {
    const targets = await deleteCategoryGroup(category, groupIds);
    deletedTargets.push(...targets);
    await bumpFolder(category, -targets.length);
    deleted += targets.length;
  }
  await enqueueMany("delete.finalize", deletedTargets.map((target) => target.id));
  await invalidateMd5Caches(deletedTargets.map((target) => target.md5 ?? ""));
  await cleanupEmptyCategories();
  if (deleted) await invalidateImageReadCaches();
  return { deleted, ignored: uniqueIds.length - deleted };
}

async function deleteCategoryGroup(category: string, groupIds: string[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const targets = (await client.query(
      "SELECT * FROM metadata WHERE id = ANY($1::uuid[]) AND status='ready' AND category_key=$2 ORDER BY id FOR UPDATE",
      [groupIds, category]
    )).rows as ImageRecord[];
    if (!targets.length) {
      await client.query("ROLLBACK");
      return [];
    }
    const cat = (await client.query("SELECT * FROM category WHERE category_key=$1 FOR UPDATE", [category])).rows[0];
    const count = Number(cat.count);
    const targetIds = targets.map((row) => row.id);
    const newCount = count - targets.length;
    const holes = targets
      .map((row) => Number(row.category_index))
      .filter((index) => index <= newCount)
      .sort((a, b) => a - b);
    const fillers = holes.length
      ? (await client.query(
        `SELECT id, category_index
         FROM metadata
         WHERE category_key=$1
           AND status='ready'
           AND NOT (id = ANY($2::uuid[]))
           AND category_index > $3
         ORDER BY category_index DESC
         LIMIT $4
         FOR UPDATE`,
        [category, targetIds, newCount, holes.length]
      )).rows
      : [];
    await client.query("UPDATE metadata SET status='deleted', deleted_at=now(), updated_at=now() WHERE id = ANY($1::uuid[])", [targetIds]);
    for (let i = 0; i < holes.length; i += 1) {
      const filler = fillers[i];
      if (filler) {
        await client.query(
          "UPDATE metadata SET category_index=$2, index_key=$3, updated_at=now() WHERE id=$1",
          [filler.id, holes[i], indexKey(category, holes[i])]
        );
      }
    }
    await client.query("UPDATE category SET count=$2, updated_at=now() WHERE category_key=$1", [category, Math.max(0, newCount)]);
    await client.query("COMMIT");
    return targets;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
