import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import { pool } from "../core/db.ts";
import { syncRandomImages } from "../random/cache-sync.ts";
import {
  migrateImageStorage,
  type MigrateRecord
} from "../storage/migration.ts";
import { invalidateImageCaches } from "./image-cache.ts";

type BatchStorageMigrationMetrics = {
  maxImageDurationMs: number;
  randomPoolFullRebuildTriggered: boolean;
};

type BatchStorageMigrationOptions = {
  onMetrics?: (metrics: BatchStorageMigrationMetrics) => void;
};

export async function migrateImageBatchStorage(
  ids: string[],
  target: string,
  options: BatchStorageMigrationOptions = {}
) {
  const rows = (await pool.query(
    `SELECT id, object_key, ext, status, storage_slug, device, brightness,
            theme, md5
       FROM metadata
      WHERE id = ANY($1::uuid[])`,
    [ids]
  )).rows;
  let migrated = 0;
  let unchanged = 0;
  let failed = ids.length - rows.length;
  const migratedIds: string[] = [];
  let maxImageDurationMs = 0;
  let randomPoolFullRebuildTriggered = false;

  const concurrency = getRuntimeConfig().background_job.migrate_concurrency;
  await mapWithWorkerPool(rows, concurrency, async (row) => {
    const imageStartedAt = performance.now();
    try {
      const result = await migrateImageStorage(row as MigrateRecord, target);
      if (result === "migrated") {
        migrated += 1;
        migratedIds.push(row.id);
      } else if (result === "missing") {
        failed += 1;
      } else {
        unchanged += 1;
      }
    } catch {
      failed += 1;
    } finally {
      maxImageDurationMs = Math.max(
        maxImageDurationMs,
        performance.now() - imageStartedAt
      );
    }
  });

  if (migratedIds.length) {
    const migratedIdSet = new Set(migratedIds);
    const randomSync = await syncRandomImages(migratedIds);
    randomPoolFullRebuildTriggered = randomSync.fullRebuildTriggered;
    await invalidateImageCaches({
      lookupEntries: rows
        .filter((row) => migratedIdSet.has(row.id))
        .map((row) => ({ id: row.id, object_key: row.object_key }))
    });
  }
  options.onMetrics?.({
    maxImageDurationMs,
    randomPoolFullRebuildTriggered
  });
  return {
    requested: ids.length,
    migrated,
    unchanged,
    failed
  };
}
