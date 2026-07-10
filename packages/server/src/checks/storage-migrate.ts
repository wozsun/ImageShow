import { pool } from "../core/db.ts";
import { ApiError } from "../core/http.ts";
import { invalidateImageReadCaches } from "../images/image-cache.ts";
import { rebuildRandomPool } from "../random/random-cache.ts";
import { migrateStorageBackend, type MigrateRecord } from "../storage/migration.ts";

export async function migrateStorageLocation(input: { source?: unknown; target?: unknown }) {
  const source = typeof input?.source === "string" ? input.source : "";
  const target = typeof input?.target === "string" ? input.target : "";
  if (!source || !target || source === target) throw new ApiError(400, "validation_error", "Invalid migration source/target");
  const rows = (await pool.query("SELECT id, object_key, ext, status, storage_slug, is_link, device, brightness, theme FROM metadata ORDER BY created_at ASC")).rows as MigrateRecord[];
  const migration = await migrateStorageBackend(source, target, rows);
  if (migration.migrated) await rebuildRandomPool();
  await invalidateImageReadCaches();
  return { migration };
}
