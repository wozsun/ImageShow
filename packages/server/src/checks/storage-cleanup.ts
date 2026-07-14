import { pool } from "../core/db.ts";
import { errorMessage } from "../core/http.ts";
import { listStorageKeys, pruneEmptyStorageDirs, removeObject, type StoragePrefix } from "../storage/storage.ts";
import { withStorageMaintenanceLock } from "../storage/maintenance-lock.ts";
import { expectedThumbs, storageBackends, type StorageRow } from "./storage-common.ts";

function objectKeyId(key: string) {
  return key.split("/").pop()?.replace(/\.[^./]+$/, "") ?? "";
}

function stagingSessionKey(key: string) {
  return key.replace(/\.(?:image|thumb)\.webp$/, "");
}

async function cleanupStorageUnderLock() {
  const rows = (await pool.query("SELECT id, object_key, status, storage_slug, is_link, device, brightness, theme FROM metadata")).rows as StorageRow[];

  const uploadRows = (await pool.query(
    "SELECT id, final_object_key, storage_slug FROM import_session WHERE status IN ('created','receiving','preparing','ready','committing') AND expires_at >= now()"
  )).rows as Array<{ id: string; final_object_key: string | null; storage_slug: string }>;
  const activeUploads = new Map<string, Set<string>>();
  const committingObjects = new Map<string, Set<string>>();
  for (const row of uploadRows) {
    let staging = activeUploads.get(row.storage_slug);
    if (!staging) { staging = new Set<string>(); activeUploads.set(row.storage_slug, staging); }
    staging.add(String(row.id));
    if (row.final_object_key) {
      let committing = committingObjects.get(row.storage_slug);
      if (!committing) { committing = new Set<string>(); committingObjects.set(row.storage_slug, committing); }
      committing.add(row.final_object_key);
    }
  }
  const { backends } = await storageBackends();
  const expected = expectedThumbs(rows);
  const failures: Array<{ prefix: string; key: string; backend: string; error: string }> = [];
  let removed = 0;
  let candidateCount = 0;
  let prunedDirs = 0;
  for (const backend of backends) {
    try {
      const ready = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "ready").map((row) => row.object_key));
      const deleted = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "deleted").map((row) => row.object_key));

      const knownOnBackend = new Set(rows.filter((row) => row.storage_slug === backend).map((row) => String(row.id)));
      const activeUploadsOnBackend = activeUploads.get(backend) ?? new Set<string>();
      const committingOnBackend = committingObjects.get(backend) ?? new Set<string>();
      const readyThumbs = expected.thumbs.get(backend) ?? new Set<string>();
      const linkThumbs = expected.link.get(backend) ?? new Set<string>();
      const candidates: Array<readonly [StoragePrefix, string]> = [
        ...(await listStorageKeys("media", backend)).filter((key) => !ready.has(key) && !deleted.has(key) && !committingOnBackend.has(key) && !knownOnBackend.has(objectKeyId(key))).map((key) => ["media", key] as const),
        ...(await listStorageKeys("thumbs", backend)).filter((key) => !readyThumbs.has(key)).map((key) => ["thumbs", key] as const),
        ...(await listStorageKeys("link", backend)).filter((key) => !linkThumbs.has(key)).map((key) => ["link", key] as const),
        ...(await listStorageKeys("_uploads", backend)).filter((key) => !activeUploadsOnBackend.has(stagingSessionKey(key))).map((key) => ["_uploads", key] as const)
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
  return { removed, candidates: candidateCount, pruned_dirs: prunedDirs, failures };
}

export function cleanupStorage() {
  return withStorageMaintenanceLock(cleanupStorageUnderLock);
}
