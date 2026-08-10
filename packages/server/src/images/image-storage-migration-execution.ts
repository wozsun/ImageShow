import type {
  ImageStorageMigrationItemResultDto
} from "@imageshow/shared/browser";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import type {
  StorageMigrationImageRecord,
  StorageMigrationResult
} from "../storage/image-storage-migration.ts";

type ImageStorageMigrationExecutor = (
  row: StorageMigrationImageRecord,
  target: string
) => Promise<StorageMigrationResult>;

export async function executeImageStorageMigrationItems(
  ids: string[],
  rows: StorageMigrationImageRecord[],
  target: string,
  concurrency: number,
  migrate: ImageStorageMigrationExecutor
) {
  const rowsById = new Map(
    rows.map((row) => [row.id.toLowerCase(), row])
  );
  let maxImageDurationMs = 0;
  const results = await mapWithWorkerPool(ids, concurrency, async (id) => {
    const row = rowsById.get(id.toLowerCase());
    if (!row) {
      return {
        id,
        status: "failed",
        code: "not_found",
        message: "Image not found"
      } satisfies ImageStorageMigrationItemResultDto;
    }
    const imageStartedAt = performance.now();
    try {
      const result = await migrate(row, target);
      if (result === "missing") {
        return {
          id,
          status: "failed",
          code: "source_missing",
          message: "Image storage source is missing"
        } satisfies ImageStorageMigrationItemResultDto;
      }
      return { id, status: result } satisfies ImageStorageMigrationItemResultDto;
    } catch {
      return {
        id,
        status: "failed",
        code: "storage_migration_failed",
        message: "Image storage migration failed"
      } satisfies ImageStorageMigrationItemResultDto;
    } finally {
      maxImageDurationMs = Math.max(
        maxImageDurationMs,
        performance.now() - imageStartedAt
      );
    }
  });
  const migrated = results.filter(
    (result) => result.status === "migrated"
  ).length;
  const failed = results.filter(
    (result) => result.status === "failed"
  ).length;
  return { failed, maxImageDurationMs, migrated, results };
}
