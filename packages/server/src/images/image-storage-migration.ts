import type {
  ImageStorageMigrationItemResultDto
} from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import { pool } from "../core/database-pools.ts";
import {
  migrateImageStorage,
  type StorageMigrationImageRecord
} from "../storage/image-storage-migration.ts";
import { assertStorageWriteTarget } from "../storage/backend-registry.ts";
import { withPlannedImageMutation } from "./mutation-sync.ts";

type ImageStorageMigrationMetrics = {
  maxImageDurationMs: number;
};

type ImageStorageMigrationOptions = {
  onMetrics?: (metrics: ImageStorageMigrationMetrics) => void;
  signal?: AbortSignal;
};

export async function migrateImagesStorage(
  ids: string[],
  target: string,
  options: ImageStorageMigrationOptions = {}
) {
  const execute = async () => {
    options.signal?.throwIfAborted();
    const rows = (await pool.query(
      `SELECT id, object_key, ext, storage_slug, md5
         FROM metadata
        WHERE id = ANY($1::uuid[])`,
      [ids]
    )).rows as StorageMigrationImageRecord[];
    options.signal?.throwIfAborted();
    if (rows.some((row) => row.storage_slug !== target)) {
      await assertStorageWriteTarget(target);
      options.signal?.throwIfAborted();
    }
    const concurrency = getRuntimeConfig().background_job.migrate_concurrency;
    const rowsById = new Map(
      rows.map((row) => [row.id.toLowerCase(), row])
    );
    let maxImageDurationMs = 0;
    const results = await mapWithWorkerPool(
      ids,
      concurrency,
      async (id) => {
        const row = rowsById.get(id.toLowerCase());
        if (!row) {
          return {
            id,
            status: "failed",
            code: "not_found",
            message: "Image not found"
          } satisfies ImageStorageMigrationItemResultDto;
        }
        const startedAt = performance.now();
        try {
          const result = await migrateImageStorage(row, target, {
            signal: options.signal
          });
          if (result === "missing") {
            return {
              id,
              status: "failed",
              code: "source_missing",
              message: "Image storage source is missing"
            } satisfies ImageStorageMigrationItemResultDto;
          }
          return {
            id,
            status: result
          } satisfies ImageStorageMigrationItemResultDto;
        } catch (error) {
          if (
            error instanceof ApiError
            && error.status >= 400
            && error.status < 500
          ) {
            return {
              id,
              status: "failed",
              code: error.code,
              message: error.message
            } satisfies ImageStorageMigrationItemResultDto;
          }
          return {
            id,
            status: "failed",
            code: "storage_migration_failed",
            message: "Image storage migration failed"
          } satisfies ImageStorageMigrationItemResultDto;
        } finally {
          maxImageDurationMs = Math.max(
            maxImageDurationMs,
            performance.now() - startedAt
          );
        }
      },
      { signal: options.signal }
    );
    const migrated = results.filter(
      (result) => result.status === "migrated"
    ).length;
    const failed = results.filter(
      (result) => result.status === "failed"
    ).length;

    options.onMetrics?.({
      maxImageDurationMs
    });
    return {
      requested: ids.length,
      migrated,
      succeeded: ids.length - failed,
      failed,
      results
    };
  };

  const affectedCount = new Set(ids.map((id) => id.toLowerCase())).size;
  options.signal?.throwIfAborted();
  return withPlannedImageMutation(affectedCount, execute);
}
