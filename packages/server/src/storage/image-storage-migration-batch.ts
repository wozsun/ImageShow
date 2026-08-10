import { errorMessage } from "../core/api-error.ts";
import {
  migrateImageStorageBackend,
  type StorageMigrationImageRecord
} from "./image-storage-migration.ts";

export async function migrateStorageBackendImages(
  sourceSlug: string,
  targetSlug: string,
  entries:
    | Iterable<StorageMigrationImageRecord>
    | AsyncIterable<StorageMigrationImageRecord>
) {
  let migrated = 0;
  let unchanged = 0;
  let missing = 0;
  let errorCount = 0;
  const errors: Array<Record<string, unknown>> = [];
  const recordError = (error: Record<string, unknown>) => {
    errorCount += 1;
    if (errors.length < 100) errors.push(error);
  };
  for await (const entry of entries) {
    if (entry.storage_slug !== sourceSlug) {
      unchanged += 1;
      continue;
    }
    try {
      const result = await migrateImageStorageBackend(entry, targetSlug, {
        expectedSource: sourceSlug
      });
      if (result === "migrated") {
        migrated += 1;
      } else if (result === "missing") {
        missing += 1;
        recordError({
          id: entry.id,
          object_key: entry.object_key,
          reason: "source_object_missing"
        });
      } else {
        unchanged += 1;
      }
    } catch (error) {
      recordError({
        id: entry.id,
        object_key: entry.object_key,
        reason: errorMessage(error)
      });
    }
  }
  return {
    source: sourceSlug,
    target: targetSlug,
    migrated,
    unchanged,
    missing,
    errors,
    error_count: errorCount
  };
}
