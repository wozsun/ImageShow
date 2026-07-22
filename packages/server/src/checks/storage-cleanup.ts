import { pool } from "../core/db.ts";
import { errorMessage } from "../core/api-error.ts";
import { stagingSessionId } from "../images/imports/staging-keys.ts";
import { listStorageKeys, pruneEmptyStorageDirs, removeObject, type StoragePrefix } from "../storage/storage.ts";
import { withStorageLocationWriteLock } from "../storage/maintenance-lock.ts";
import {
  activeImportStorageReferences,
  classifyStagingKeys,
  expectedThumbs,
  importFinalStorageReferences,
  storageBackends,
  type StorageRow
} from "./storage-common.ts";

type ProtectedFinalReferences = Record<"media" | "thumbs", Set<string>>;

function emptyProtectedFinalReferences(): ProtectedFinalReferences {
  return { media: new Set(), thumbs: new Set() };
}

function objectKeyId(key: string) {
  return key.split("/").pop()?.replace(/\.[^./]+$/, "") ?? "";
}

async function cleanupStorageUnderLock(signal: AbortSignal) {
  signal.throwIfAborted();
  const rows = (await pool.query("SELECT id, object_key, status, storage_slug FROM metadata")).rows as StorageRow[];
  const { rows: uploadRows, sessionsByBackend } = await activeImportStorageReferences();
  const allImportSessionIds = new Set<string>((await pool.query(
    "SELECT id FROM import_session"
  )).rows.map((row) => String(row.id)));
  signal.throwIfAborted();
  const liveObjectIds = new Set<string>([
    ...rows.map((row) => String(row.id)),
    ...allImportSessionIds
  ]);
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
  signal.throwIfAborted();
  const expected = expectedThumbs(rows);
  const failures: Array<{ prefix: string; key: string; backend: string; error: string }> = [];
  let removed = 0;
  let candidateCount = 0;
  let prunedDirs = 0;
  const retainedItems: Array<Record<string, unknown>> = [];
  for (const backend of backends) {
    try {
      signal.throwIfAborted();
      const ready = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "ready").map((row) => row.object_key));
      const deleted = new Set(rows.filter((row) => row.storage_slug === backend && row.status === "deleted").map((row) => row.object_key));

      const activeUploadsOnBackend = sessionsByBackend.get(backend) ?? new Map();
      const committingOnBackend = committingReferences.get(backend) ?? emptyProtectedFinalReferences();
      const readyThumbs = expected.thumbs.get(backend) ?? new Set<string>();
      const [mediaKeys, thumbKeys, stagingKeys] = await Promise.all([
        listStorageKeys("media", backend),
        listStorageKeys("thumbs", backend),
        listStorageKeys("_uploads", backend)
      ]);
      signal.throwIfAborted();
      const staging = classifyStagingKeys(stagingKeys, activeUploadsOnBackend);
      for (const { key, session } of staging.active) {
        retainedItems.push({
          prefix: "_uploads",
          key,
          backend,
          session_id: session.id,
          status: session.status,
          expires_at: session.expires_at,
          reason: "对应导入会话仍有效，已保留"
        });
      }
      const candidates: Array<readonly [StoragePrefix, string]> = [];
      for (const key of mediaKeys) {
        if (ready.has(key) || deleted.has(key) || committingOnBackend.media.has(key)) continue;
        const ownerId = objectKeyId(key);
        if (liveObjectIds.has(ownerId)) {
          retainedItems.push({
            prefix: "media",
            key,
            backend,
            owner_id: ownerId,
            reason: "对象 UUID 仍属于图片或导入会话，交由单图清理任务处理"
          });
          continue;
        }
        candidates.push(["media", key]);
      }
      for (const key of thumbKeys) {
        if (readyThumbs.has(key) || committingOnBackend.thumbs.has(key)) continue;
        const ownerId = objectKeyId(key);
        if (liveObjectIds.has(ownerId)) {
          retainedItems.push({
            prefix: "thumbs",
            key,
            backend,
            owner_id: ownerId,
            reason: "对象 UUID 仍属于图片或导入会话，交由单图清理任务处理"
          });
          continue;
        }
        candidates.push(["thumbs", key]);
      }
      for (const key of staging.orphan) {
        const sessionId = stagingSessionId(key);
        if (allImportSessionIds.has(sessionId)) {
          retainedItems.push({
            prefix: "_uploads",
            key,
            backend,
            session_id: sessionId,
            reason: "对应导入会话尚未清理，暂存对象由导入清理流程处理"
          });
          continue;
        }
        candidates.push(["_uploads", key]);
      }
      candidateCount += candidates.length;
      for (const [prefix, key] of candidates) {
        try {
          signal.throwIfAborted();
          await removeObject(prefix, key, backend);
          signal.throwIfAborted();
          removed += 1;
        } catch (error) {
          if (signal.aborted) throw signal.reason ?? error;
          failures.push({ prefix, key, backend, error: errorMessage(error) });
        }
      }
      signal.throwIfAborted();
      prunedDirs += await pruneEmptyStorageDirs(backend);
      signal.throwIfAborted();
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      failures.push({ prefix: "*", key: "*", backend, error: errorMessage(error) });
    }
  }
  return {
    candidates: candidateCount,
    removed,
    retained: retainedItems.length,
    failed: failures.length,
    pruned_dirs: prunedDirs,
    retained_items: retainedItems,
    failures
  };
}

export function cleanupStorage() {
  return withStorageLocationWriteLock(cleanupStorageUnderLock);
}
