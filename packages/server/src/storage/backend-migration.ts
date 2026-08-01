import { pool } from "../core/db.ts";
import { invalidateImageCaches } from "../images/image-cache.ts";
import { rebuildRandomPool } from "../random/cache-rebuild.ts";
import {
  migrateStorageBackendImages,
  type StorageMigrationImageRecord
} from "./migration.ts";
import {
  assertStorageWriteTarget,
  getStorageBackend
} from "./backend-registry.ts";

export async function migrateStorageBackend(source: string, target: string) {
  await getStorageBackend(source);
  await getStorageBackend(target);
  const rows = (await pool.query(
    `SELECT id, object_key, ext, status, storage_slug, device, brightness,
            theme, md5
       FROM metadata
      WHERE storage_slug=$1
      ORDER BY created_at ASC`,
    [source]
  )).rows as StorageMigrationImageRecord[];
  if (rows.length) await assertStorageWriteTarget(target);

  const {
    migratedEntries,
    ...migration
  } = await migrateStorageBackendImages(source, target, rows);
  if (migration.migrated) {
    await rebuildRandomPool();
    await invalidateImageCaches({
      lookupEntries: migratedEntries,
      facets: false
    });
  }
  return { migration };
}
