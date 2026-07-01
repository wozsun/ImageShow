import { pool } from "../core/db.js";
import { errorMessage } from "../core/http.js";
import { thumbnailObjectKey, thumbnailRef } from "./image-paths.js";
import { assertStorageWritable, getStorageBackend } from "../config/settings.js";
import { createThumbnail } from "../images/processing.js";
import {
  contentType,
  readStorageBufferWithConfig,
  removeObject,
  storageExistsWithConfig,
  writeStorageBufferWithConfig
} from "./storage.js";

export type MigrateRecord = { id: string; object_key: string; ext: string; status: string; storage_slug: string; is_link: boolean; device: string; brightness: string; theme: string };
type MigrateResult = "migrated" | "unchanged" | "missing";

// Moves one image's object (and thumbnail) from its current backend to `target`
// (a backend slug), flips metadata.storage_slug, then best-effort deletes the source
// copy. The DB flip is optimistic (guarded on the old slug) so concurrent migrations
// don't double-apply; leftover source objects are caught by storage cleanup.
export async function migrateImageStorage(row: MigrateRecord, target: string): Promise<MigrateResult> {
  if (row.storage_slug === target) return "unchanged";
  const source = await getStorageBackend(row.storage_slug);
  const dest = await assertStorageWritable(target); // validates target credentials
  // Link images keep no original bytes of ours (object_key is an external URL); "migrating" a
  // link just moves its stored thumbnail — which lives under the dedicated "link" prefix, kept
  // separate from regular thumbs — to the target backend, then flips storage_slug. Status
  // doesn't matter (a link keeps its thumbnail even while in the recycle bin).
  if (row.is_link) {
    const thumb = thumbnailRef(row);
    if (!(await storageExistsWithConfig(source, thumb.prefix, thumb.key))) return "missing";
    if (!(await storageExistsWithConfig(dest, thumb.prefix, thumb.key))) {
      await writeStorageBufferWithConfig(dest, thumb.prefix, thumb.key, await readStorageBufferWithConfig(source, thumb.prefix, thumb.key), "image/webp");
    }
    const moved = await pool.query(
      "UPDATE metadata SET storage_slug=$2, updated_at=now() WHERE id=$1 AND storage_slug=$3",
      [row.id, target, row.storage_slug]
    );
    if (!moved.rowCount) return "unchanged";
    await removeObject(thumb.prefix, thumb.key, row.storage_slug).catch(() => undefined);
    return "migrated";
  }
  // Recycle-bin images keep their original (objects/) and thumbnail (thumbs/) just like ready
  // ones, so a migrate moves both regardless of status.
  if (!(await storageExistsWithConfig(source, "objects", row.object_key))) return "missing";
  if (!(await storageExistsWithConfig(dest, "objects", row.object_key))) {
    await writeStorageBufferWithConfig(
      dest,
      "objects",
      row.object_key,
      await readStorageBufferWithConfig(source, "objects", row.object_key),
      contentType(row.ext)
    );
  }
  const thumbKey = thumbnailObjectKey(row.object_key);
  if (!(await storageExistsWithConfig(dest, "thumbs", thumbKey))) {
    const thumb = await storageExistsWithConfig(source, "thumbs", thumbKey)
      ? await readStorageBufferWithConfig(source, "thumbs", thumbKey)
      : await createThumbnail(await readStorageBufferWithConfig(source, "objects", row.object_key));
    await writeStorageBufferWithConfig(dest, "thumbs", thumbKey, thumb, "image/webp");
  }
  const updated = await pool.query(
    "UPDATE metadata SET storage_slug=$2, updated_at=now() WHERE id=$1 AND storage_slug=$3",
    [row.id, target, row.storage_slug]
  );
  if (!updated.rowCount) return "unchanged";
  await removeObject("objects", row.object_key, row.storage_slug).catch(() => undefined);
  await removeObject("thumbs", thumbKey, row.storage_slug).catch(() => undefined);
  return "migrated";
}

// Migrates every image currently on `sourceSlug` to `targetSlug` and updates each
// row's storage_slug (the check page's wholesale "migrate storage backend").
export async function migrateStorageBackend(sourceSlug: string, targetSlug: string, entries: MigrateRecord[]) {
  let migrated = 0;
  let unchanged = 0;
  let missing = 0;
  const errors: Array<Record<string, unknown>> = [];
  for (const entry of entries) {
    if (entry.storage_slug !== sourceSlug) {
      unchanged += 1;
      continue;
    }
    try {
      const result = await migrateImageStorage(entry, targetSlug);
      if (result === "migrated") migrated += 1;
      else if (result === "missing") {
        missing += 1;
        errors.push({ id: entry.id, object_key: entry.object_key, reason: "source_object_missing" });
      } else {
        unchanged += 1;
      }
    } catch (error) {
      errors.push({ id: entry.id, object_key: entry.object_key, reason: errorMessage(error) });
    }
  }
  return { source: sourceSlug, target: targetSlug, migrated, unchanged, missing, errors: errors.slice(0, 100), error_count: errors.length };
}
