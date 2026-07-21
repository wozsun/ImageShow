import { pool } from "../core/db.ts";
import { errorMessage } from "../core/api-error.ts";
import { thumbnailRef } from "../storage/image-paths.ts";
import { listStorageKeys } from "../storage/storage.ts";
import {
  activeImportStorageReferences,
  classifyStagingKeys,
  expectedThumbs,
  importFinalStorageReferences,
  mergeActiveImportSessions,
  mergeStorageReferenceRows,
  storageBackends,
  type StorageRow
} from "./storage-common.ts";

const storageRowsQuery = "SELECT id, object_key, status, storage_slug FROM metadata";

export async function checkStorage() {
  const rowsBeforeEnumeration = (await pool.query(storageRowsQuery)).rows as StorageRow[];
  const { backends } = await storageBackends();
  const missingObjects: Array<Record<string, unknown>> = [];
  const missingThumbs: Array<Record<string, unknown>> = [];
  const orphanObjects: Array<Record<string, unknown>> = [];
  const orphanThumbs: Array<Record<string, unknown>> = [];
  const unavailableBackends: string[] = [];
  const activeStagingFiles: Array<Record<string, unknown>> = [];
  const orphanStagingFiles: Array<{ key: string; backend: string }> = [];
  const { sessionsByBackend: sessionsBeforeEnumeration } = await activeImportStorageReferences();

  const storageSnapshots = await Promise.all(backends.map(async (backend) => {
    try {
      const [objectKeys, thumbKeys, stagingKeys] = await Promise.all([
        listStorageKeys("media", backend),
        listStorageKeys("thumbs", backend),
        listStorageKeys("_uploads", backend)
      ]);
      return { backend, objectKeys, thumbKeys, stagingKeys };
    } catch (error) {
      unavailableBackends.push(`${backend}: ${errorMessage(error)}`);
      return null;
    }
  }));

  // 检查本身不持有维护锁。枚举后再读取一次会话，并与枚举前快照取并集，
  // 避免刚创建的导入会话已经写入暂存对象、却被首轮快照漏掉而瞬时误报。
  const [rowsAfterEnumerationResult, activeSessionsAfterEnumeration] = await Promise.all([
    pool.query(storageRowsQuery),
    activeImportStorageReferences()
  ]);
  const rowsAfterEnumeration = rowsAfterEnumerationResult.rows as StorageRow[];
  const rowsReferencedDuringEnumeration = mergeStorageReferenceRows(
    rowsBeforeEnumeration,
    rowsAfterEnumeration
  );
  const referencesDuringEnumeration = expectedThumbs(rowsReferencedDuringEnumeration);
  const { sessionsByBackend: sessionsAfterEnumeration } = activeSessionsAfterEnumeration;

  for (const snapshot of storageSnapshots) {
    if (!snapshot) continue;
    const { backend, objectKeys, thumbKeys, stagingKeys } = snapshot;
    const ready = rowsBeforeEnumeration.filter((row) => (
      row.storage_slug === backend && row.status === "ready"
    ));
    const referencedObjectKeys = new Set(rowsReferencedDuringEnumeration
      .filter((row) => (
        row.storage_slug === backend
        && (row.status === "ready" || row.status === "deleted")
      ))
      .map((row) => row.object_key));
    const activeSessions = mergeActiveImportSessions(
      sessionsBeforeEnumeration.get(backend) ?? new Map(),
      sessionsAfterEnumeration.get(backend) ?? new Map()
    );
    const staging = classifyStagingKeys(stagingKeys, activeSessions);
    orphanStagingFiles.push(...staging.orphan.map((key) => ({ key, backend })));
    for (const { key, session } of staging.active) {
      activeStagingFiles.push({
        key,
        backend,
        session_id: session.id,
        status: session.status,
        expires_at: session.expires_at
      });
    }
    const objectSet = new Set(objectKeys);
    const thumbSet = new Set(thumbKeys);
    const referencedThumbSet = referencesDuringEnumeration.thumbs.get(backend) ?? new Set<string>();
    for (const session of activeSessions.values()) {
      for (const reference of importFinalStorageReferences(session)) {
        if (reference.prefix === "media") referencedObjectKeys.add(reference.key);
        if (reference.prefix === "thumbs") referencedThumbSet.add(reference.key);
      }
    }

    for (const image of ready) {
      if (!objectSet.has(image.object_key)) { missingObjects.push({ id: image.id, object_key: image.object_key, backend }); continue; }
      const thumbKey = thumbnailRef(image).key;
      if (!thumbSet.has(thumbKey)) missingThumbs.push({ id: image.id, object_key: image.object_key, thumb_key: thumbKey, backend });
    }
    for (const key of objectKeys) if (!referencedObjectKeys.has(key)) orphanObjects.push({ key, backend });
    for (const key of thumbKeys) if (!referencedThumbSet.has(key)) orphanThumbs.push({ key, backend });
  }
  return {
    missing_objects: missingObjects,
    missing_thumbs: missingThumbs,
    orphan_objects: orphanObjects,
    orphan_thumbs: orphanThumbs,
    active_staging_files: activeStagingFiles,
    orphan_staging_files: orphanStagingFiles,
    unavailable_backends: unavailableBackends
  };
}
