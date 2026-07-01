import { pool } from "../core/db.js";
import { errorMessage } from "../core/http.js";
import { invalidateImageReadCaches } from "../core/redis.js";
import { listStorageKeys, pruneEmptyStorageDirs, removeObject, type StoragePrefix } from "../storage/storage.js";
import { expectedThumbs, storageBackends, type StorageRow } from "./storage-common.js";

// The image id embedded in an object key (<device>-<brightness>/<theme>/<id>.<ext>): its
// last path segment without the extension.
function objectKeyId(key: string) {
  return key.split("/").pop()?.replace(/\.[^./]+$/, "") ?? "";
}

// Removes storage objects unreferenced within their own backend (orphan objects / thumbs /
// link, plus abandoned upload staging files), keeping live images, recycle-bin originals and
// thumbnails, and in-flight uploads intact, then prunes the now-empty directories the removals
// leave behind (e.g. a deleted theme's folder).
export async function cleanupStorage() {
  const rows = (await pool.query("SELECT id, object_key, status, storage_slug, is_link, device, brightness, theme FROM metadata")).rows as StorageRow[];
  // Only protect uploads that could still legitimately finalize: a session within its TTL. A
  // 'finalizing' session past expires_at is a crashed finalize (finalize takes seconds, the TTL
  // minutes), so its final object is a true orphan and must not be protected here.
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
  for (const backend of backends) {
    try {
      const ready = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "ready").map((row) => row.object_key));
      const deleted = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "deleted").map((row) => row.object_key));
      // Defense in depth: never delete an original whose id the DB still maps to THIS backend,
      // whatever its status or exact stored path. Scoped per-backend so a stale leftover on a
      // backend the image has since migrated off stays reclaimable (its id is known elsewhere).
      const knownOnBackend = new Set(rows.filter((row) => row.storage_slug === backend).map((row) => String(row.id)));
      const readyThumbs = expected.thumbs.get(backend) ?? new Set<string>();
      const linkThumbs = expected.link.get(backend) ?? new Set<string>();
      const candidates: Array<readonly [StoragePrefix, string]> = [
        // Recycle-bin images keep their original (objects/) and thumbnail (thumbs/) until purge,
        // so exclude `deleted` originals and rely on expectedThumbs (which includes deleted rows)
        // for thumbs. finalizingObjects protects an in-flight upload's final object; knownOnBackend
        // is the id-level backstop that refuses to delete any original the DB still maps here.
        ...(await listStorageKeys("objects", backend)).filter((key) => !ready.has(key) && !deleted.has(key) && !finalizingObjects.has(key) && !knownOnBackend.has(objectKeyId(key))).map((key) => ["objects", key] as const),
        ...(await listStorageKeys("thumbs", backend)).filter((key) => !readyThumbs.has(key)).map((key) => ["thumbs", key] as const),
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
      prunedDirs += await pruneEmptyStorageDirs(backend);
    } catch (error) {
      failures.push({ prefix: "*", key: "*", backend, error: errorMessage(error) });
    }
  }
  await invalidateImageReadCaches();
  return { removed, candidates: candidateCount, pruned_dirs: prunedDirs, failures };
}
