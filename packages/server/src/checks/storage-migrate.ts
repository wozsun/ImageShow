import { pool } from "../core/db.ts";
import { ApiError } from "../core/api-error.ts";
import { invalidateImageCaches } from "../images/image-cache.ts";
import { rebuildRandomPool } from "../random/cache-rebuild.ts";
import { migrateStorageBackend, type MigrateRecord } from "../storage/migration.ts";
import {
  assertStorageWritable,
  getStorageBackend
} from "../storage/backend-registry.ts";

export async function migrateStorageLocation(input: { source?: unknown; target?: unknown }) {
  const source = typeof input?.source === "string" ? input.source : "";
  const target = typeof input?.target === "string" ? input.target : "";
  if (!source || !target || source === target) throw new ApiError(400, "validation_error", "Invalid migration source/target");
  await getStorageBackend(source);
  const rows = (await pool.query(
    `SELECT id, object_key, ext, status, storage_slug, device, brightness,
            theme, md5
       FROM metadata
      WHERE storage_slug=$1
      ORDER BY created_at ASC`,
    [source]
  )).rows as MigrateRecord[];
  if (rows.length) await assertStorageWritable(target);
  const { migratedEntries, ...migration } = await migrateStorageBackend(source, target, rows);
  if (migration.migrated) {
    await rebuildRandomPool();
    await invalidateImageCaches({
      lookupEntries: migratedEntries,
      facets: false
    });
  }
  return { migration };
}
