import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import { pool } from "../core/db.ts";
import {
  migrateImageStorageBackend,
  type StorageMigrationImageRecord
} from "../storage/migration.ts";
import { assertStorageWriteTarget } from "../storage/backend-registry.ts";

type BatchStorageMigrationMetrics = {
  maxImageDurationMs: number;
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
    `SELECT id, object_key, ext, storage_slug, device, brightness,
            theme, md5
       FROM metadata
      WHERE id = ANY($1::uuid[])`,
    [ids]
  )).rows;
  let migrated = 0;
  let unchanged = 0;
  let failed = ids.length - rows.length;
  let maxImageDurationMs = 0;

  if (rows.some((row) => row.storage_slug !== target)) {
    await assertStorageWriteTarget(target);
  }
  const concurrency = getRuntimeConfig().background_job.migrate_concurrency;
  await mapWithWorkerPool(rows, concurrency, async (row) => {
    const imageStartedAt = performance.now();
    try {
      const result = await migrateImageStorageBackend(
        row as StorageMigrationImageRecord,
        target
      );
      if (result === "migrated") {
        migrated += 1;
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

  options.onMetrics?.({
    maxImageDurationMs
  });
  return {
    requested: ids.length,
    migrated,
    succeeded: migrated + unchanged,
    failed
  };
}
