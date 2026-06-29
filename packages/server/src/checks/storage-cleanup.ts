import { pool } from "../core/db.js";
import { errorMessage } from "../core/http.js";
import { invalidateImageReadCaches } from "../core/redis.js";
import { listStorageKeys, pruneEmptyStorageDirs, removeObject } from "../storage/storage.js";
import { expectedThumbs, storageBackends, type StorageRow } from "./storage-common.js";

// Removes storage objects unreferenced within their own backend (orphan
// objects/thumbs/trash/link and abandoned upload staging files), keeping live and
// in-flight uploads intact, then prunes the now-empty directories (e.g. a deleted theme's
// folder) the removals leave behind.
export async function cleanupStorage() {
  const rows = (await pool.query("SELECT id, object_key, status, storage_slug, is_link, device, brightness, theme FROM metadata")).rows as StorageRow[];
  // Only protect the objects of uploads that could still legitimately finalize: a
  // session still within its TTL. A 'finalizing' session past expires_at is a crashed
  // finalize (finalize runs in seconds, the TTL is minutes) — its final object is a true
  // orphan, so it must NOT be protected here, or cleanup can never remove it (the bug
  // where checkStorage reports an orphan that 清理无效存储 refuses to clean).
  const uploadRows = (await pool.query(
    "SELECT staging_object_key, final_object_key FROM upload_session WHERE status IN ('finalizing','created') AND expires_at >= now()"
  )).rows as Array<{ staging_object_key: string; final_object_key: string | null }>;
  const activeUploads = new Set(uploadRows.map((row) => String(row.staging_object_key)));
  const finalizingObjects = new Set(uploadRows.map((row) => row.final_object_key).filter((key): key is string => Boolean(key)));
  const { defaultBackend, backends } = await storageBackends();
  const expected = expectedThumbs(rows);
  const failures: Array<{ prefix: string; key: string; backend: string; error: string }> = [];
  let removed = 0;
  let candidateCount = 0;
  let prunedDirs = 0;
  // Only objects unreferenced within their own backend are removed.
  for (const backend of backends) {
    try {
      const ready = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "ready").map((row) => row.object_key));
      const deleted = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "deleted").map((row) => row.object_key));
      const readyThumbs = expected.thumbs.get(backend) ?? new Set<string>();
      const linkThumbs = expected.link.get(backend) ?? new Set<string>();
      const candidates: Array<readonly ["objects" | "thumbs" | "trash" | "_uploads" | "link", string]> = [
        // A soft-deleted image's original sits in objects/ (status='deleted') until its async
        // delete.finalize moves it to trash/. During that window the key is in neither `ready`
        // nor `finalizingObjects`, so guard it with `deleted` too — otherwise a cleanup racing a
        // (possibly slow, batched) finalize destroys the original and leaves the trashed image
        // unrestorable. Once finalized the object is in trash/, so this guard then no-ops.
        ...(await listStorageKeys("objects", backend)).filter((key) => !ready.has(key) && !finalizingObjects.has(key) && !deleted.has(key)).map((key) => ["objects", key] as const),
        ...(await listStorageKeys("thumbs", backend)).filter((key) => !readyThumbs.has(key)).map((key) => ["thumbs", key] as const),
        ...(await listStorageKeys("trash", backend)).filter((key) => !deleted.has(key)).map((key) => ["trash", key] as const),
        ...(await listStorageKeys("link", backend)).filter((key) => !linkThumbs.has(key)).map((key) => ["link", key] as const),
        ...(backend === defaultBackend ? (await listStorageKeys("_uploads", backend)).filter((key) => !activeUploads.has(key.replace(/\.part$/, ""))).map((key) => ["_uploads", key] as const) : [])
      ];
      candidateCount += candidates.length;
      for (const [prefix, key] of candidates) {
        try {
          await removeObject(prefix, key, backend);
          removed += 1;
        } catch (error) {
          failures.push({ prefix, key, backend, error: errorMessage(error) });
        }
      }
      // Drop the directories the removals (and any prior theme moves) left empty.
      prunedDirs += await pruneEmptyStorageDirs(backend);
    } catch (error) {
      failures.push({ prefix: "*", key: "*", backend, error: errorMessage(error) });
    }
  }
  await invalidateImageReadCaches();
  return { removed, candidates: candidateCount, pruned_dirs: prunedDirs, failures };
}
