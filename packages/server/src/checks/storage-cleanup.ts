import { pool } from "../core/db.ts";
import { errorMessage } from "../core/api-error.ts";
import { listStorageKeys, pruneEmptyStorageDirs, removeObject, type StoragePrefix } from "../storage/storage.ts";
import { withStorageMaintenanceLock } from "../storage/maintenance-lock.ts";
import {
  activeImportStorageReferences,
  classifyStagingKeys,
  expectedThumbs,
  importFinalStorageReferences,
  storageBackends,
  type StorageRow
} from "./storage-common.ts";

type ProtectedFinalReferences = Record<"media" | "thumbs" | "link", Set<string>>;

function emptyProtectedFinalReferences(): ProtectedFinalReferences {
  return { media: new Set(), thumbs: new Set(), link: new Set() };
}

function objectKeyId(key: string) {
  return key.split("/").pop()?.replace(/\.[^./]+$/, "") ?? "";
}

async function cleanupStorageUnderLock() {
  const rows = (await pool.query("SELECT id, object_key, status, storage_slug, is_link, device, brightness, theme FROM metadata")).rows as StorageRow[];
  const { rows: uploadRows, sessionsByBackend } = await activeImportStorageReferences();
  const committingReferences = new Map<string, ProtectedFinalReferences>();
  for (const row of uploadRows) {
    const references = importFinalStorageReferences(row);
    if (references.length) {
      let committing = committingReferences.get(row.storage_slug);
      if (!committing) {
        committing = emptyProtectedFinalReferences();
        committingReferences.set(row.storage_slug, committing);
      }
      for (const reference of references) committing[reference.prefix].add(reference.key);
    }
  }
  const { backends } = await storageBackends();
  const expected = expectedThumbs(rows);
  const failures: Array<{ prefix: string; key: string; backend: string; error: string }> = [];
  let removed = 0;
  let candidateCount = 0;
  let prunedDirs = 0;
  const retainedStagingFiles: Array<Record<string, unknown>> = [];
  for (const backend of backends) {
    try {
      const ready = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "ready").map((row) => row.object_key));
      const deleted = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "deleted").map((row) => row.object_key));

      const knownOnBackend = new Set(rows.filter((row) => row.storage_slug === backend).map((row) => String(row.id)));
      const activeUploadsOnBackend = sessionsByBackend.get(backend) ?? new Map();
      const committingOnBackend = committingReferences.get(backend) ?? emptyProtectedFinalReferences();
      const readyThumbs = expected.thumbs.get(backend) ?? new Set<string>();
      const linkThumbs = expected.link.get(backend) ?? new Set<string>();
      const [mediaKeys, thumbKeys, linkKeys, stagingKeys] = await Promise.all([
        listStorageKeys("media", backend),
        listStorageKeys("thumbs", backend),
        listStorageKeys("link", backend),
        listStorageKeys("_uploads", backend)
      ]);
      const staging = classifyStagingKeys(stagingKeys, activeUploadsOnBackend);
      for (const { key, session } of staging.active) {
        retainedStagingFiles.push({
          prefix: "_uploads",
          key,
          backend,
          session_id: session.id,
          status: session.status,
          expires_at: session.expires_at,
          reason: "对应导入会话仍有效，已保留"
        });
      }
      const candidates: Array<readonly [StoragePrefix, string]> = [
        ...mediaKeys.filter((key) => !ready.has(key) && !deleted.has(key) && !committingOnBackend.media.has(key) && !knownOnBackend.has(objectKeyId(key))).map((key) => ["media", key] as const),
        ...thumbKeys.filter((key) => !readyThumbs.has(key) && !committingOnBackend.thumbs.has(key)).map((key) => ["thumbs", key] as const),
        ...linkKeys.filter((key) => !linkThumbs.has(key) && !committingOnBackend.link.has(key)).map((key) => ["link", key] as const),
        ...staging.orphan.map((key) => ["_uploads", key] as const)
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
  return {
    candidates: candidateCount,
    removed,
    retained: retainedStagingFiles.length,
    failed: failures.length,
    pruned_dirs: prunedDirs,
    retained_items: retainedStagingFiles,
    failures
  };
}

export function cleanupStorage() {
  return withStorageMaintenanceLock(cleanupStorageUnderLock);
}
