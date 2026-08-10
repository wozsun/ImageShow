import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { pool } from "../core/database-pools.ts";
import {
  migrateImageStorageBackend,
  type StorageMigrationImageRecord
} from "../storage/image-storage-migration.ts";
import { assertStorageWriteTarget } from "../storage/backend-registry.ts";
import {
  executeImageStorageMigrationItems
} from "./image-storage-migration-execution.ts";
import { withPlannedImageMutation } from "./mutation-sync.ts";

type ImageStorageMigrationMetrics = {
  maxImageDurationMs: number;
};

type ImageStorageMigrationOptions = {
  onMetrics?: (metrics: ImageStorageMigrationMetrics) => void;
};

export async function migrateImagesStorage(
  ids: string[],
  target: string,
  options: ImageStorageMigrationOptions = {}
) {
  const execute = async () => {
    const rows = (await pool.query(
      `SELECT id, object_key, ext, storage_slug, device, brightness,
              theme, md5
         FROM metadata
        WHERE id = ANY($1::uuid[])`,
      [ids]
    )).rows as StorageMigrationImageRecord[];
    if (rows.some((row) => row.storage_slug !== target)) {
      await assertStorageWriteTarget(target);
    }
    const concurrency = getRuntimeConfig().background_job.migrate_concurrency;
    const execution = await executeImageStorageMigrationItems(
      ids,
      rows,
      target,
      concurrency,
      migrateImageStorageBackend
    );

    options.onMetrics?.({
      maxImageDurationMs: execution.maxImageDurationMs
    });
    return {
      requested: ids.length,
      migrated: execution.migrated,
      succeeded: ids.length - execution.failed,
      failed: execution.failed,
      results: execution.results
    };
  };

  const affectedCount = new Set(ids.map((id) => id.toLowerCase())).size;
  return withPlannedImageMutation(affectedCount, execute);
}
