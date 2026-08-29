import type {
  ImageStorageMigrationItemResultDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import { pool } from "../core/database/pools.ts";
import {
  migrateImageToStorageBackend,
  type ImageStorageMigrationRecord
} from "../storage/migration/image.ts";
import { assertStorageWriteTarget } from "../storage/backends/registry.ts";
import { STORAGE_MIGRATION_CONCURRENCY } from "../storage/migration/admission.ts";
import { withPlannedImageMutation } from "./mutation-sync.ts";

type SelectedImageStorageMigrationMetrics = {
  maxImageDurationMs: number;
};

type SelectedImageStorageMigrationOptions = {
  onMetrics?: (metrics: SelectedImageStorageMigrationMetrics) => void;
  signal?: AbortSignal;
};

export async function migrateSelectedImagesToStorageBackend(
  ids: string[],
  target: string,
  options: SelectedImageStorageMigrationOptions = {}
) {
  const execute = async () => {
    options.signal?.throwIfAborted();
    const rows = (await pool.query(
      `SELECT id, object_key, ext, storage_slug, md5,
              image_size, thumbnail_size
         FROM metadata
        WHERE id = ANY($1::uuid[])`,
      [ids]
    )).rows as ImageStorageMigrationRecord[];
    options.signal?.throwIfAborted();
    if (rows.some((row) => row.storage_slug !== target)) {
      await assertStorageWriteTarget(target);
      options.signal?.throwIfAborted();
    }
    const rowsById = new Map(
      rows.map((row) => [row.id.toLowerCase(), row])
    );
    let maxImageDurationMs = 0;
    const results = await mapWithWorkerPool(
      ids,
      STORAGE_MIGRATION_CONCURRENCY,
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
          const result = await migrateImageToStorageBackend(row, target, {
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
