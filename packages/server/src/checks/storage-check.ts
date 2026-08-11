import { pool } from "../core/database-pools.ts";
import { errorMessage } from "../core/api-error.ts";
import { stagingSessionId } from "../images/imports/staging-keys.ts";
import { resolveStorageAccess } from "../storage/backend-registry.ts";
import { thumbnailRef } from "../storage/image-paths.ts";
import { STORAGE_ADMIN_LIST_MAX_KEYS } from "../storage/key-listing.ts";
import {
  activeImportStorageReferences,
  classifyStagingKeys,
  collectStorageBackendGroupSnapshot,
  importFinalStorageReferences,
  importSessionIdsByBackend,
  mergeActiveImportSessions,
  mergeImportSessionIds,
  mergeStorageReferenceRows,
  storageBackendGroupName,
  storageBackendGroups,
  type StorageRow
} from "./storage-common.ts";

const storageRowsQuery = `
  SELECT id, object_key, status, storage_slug, thumbnail_size
    FROM metadata`;

export async function checkStorage(signal?: AbortSignal) {
  signal?.throwIfAborted();
  const rowsBeforeEnumeration = (await pool.query(storageRowsQuery)).rows as StorageRow[];
  const groups = await storageBackendGroups();
  const missingObjects: Array<Record<string, unknown>> = [];
  const missingThumbs: Array<Record<string, unknown>> = [];
  const pendingThumbnailRepairs: Array<Record<string, unknown>> = [];
  const orphanObjects: Array<Record<string, unknown>> = [];
  const orphanThumbs: Array<Record<string, unknown>> = [];
  const unavailableBackends: Array<Record<string, unknown>> = [];
  const activeStagingFiles: Array<Record<string, unknown>> = [];
  const retainedStagingFiles: Array<Record<string, unknown>> = [];
  const orphanStagingFiles: Array<Record<string, unknown>> = [];
  const [activeBeforeEnumeration, sessionIdsBeforeEnumeration] = await Promise.all([
    activeImportStorageReferences(),
    importSessionIdsByBackend()
  ]);
  const { sessionsByBackend: sessionsBeforeEnumeration } = activeBeforeEnumeration;
  const incompleteListings: Array<{
    backend: string;
    namespace: string;
    prefix: "media" | "thumbs" | "_uploads";
    scanned: number;
    limit: number;
  }> = [];

  const storageSnapshots = await Promise.all(groups.map(async (group) => {
    const captured = await collectStorageBackendGroupSnapshot(group, {
      signal,
      maxKeys: STORAGE_ADMIN_LIST_MAX_KEYS
    });
    if (!captured.snapshot) {
      unavailableBackends.push({
        backend: group.slugs.join(" / ") || "unknown",
        namespace: storageBackendGroupName(group),
        blocks_maintenance: true,
        error: captured.errors
          .map((entry) => `${entry.backend}: ${entry.error}`)
          .join("; ") || "存储后端不可用"
      });
      return null;
    }
    return { group, ...captured, snapshot: captured.snapshot };
  }));

  // 检查本身不持有维护锁。枚举后再读取一次会话，并与枚举前快照取并集，
  // 避免刚创建的导入会话已经写入暂存对象、却被首轮快照漏掉而瞬时误报。
  const [
    rowsAfterEnumerationResult,
    activeSessionsAfterEnumeration,
    sessionIdsAfterEnumeration
  ] = await Promise.all([
    pool.query(storageRowsQuery),
    activeImportStorageReferences(),
    importSessionIdsByBackend()
  ]);
  const rowsAfterEnumeration = rowsAfterEnumerationResult.rows as StorageRow[];
  const rowsReferencedDuringEnumeration = mergeStorageReferenceRows(
    rowsBeforeEnumeration,
    rowsAfterEnumeration
  );
  const { sessionsByBackend: sessionsAfterEnumeration } = activeSessionsAfterEnumeration;
  const sessionIdsDuringEnumeration = mergeImportSessionIds(
    sessionIdsBeforeEnumeration,
    sessionIdsAfterEnumeration
  );

  for (const captured of storageSnapshots) {
    if (!captured) continue;
    const { group, backend } = captured;
    const namespace = storageBackendGroupName(group);
    const {
      media: objects,
      thumbs,
      _uploads: stagingListing
    } = captured.snapshot;
    const listings = [
      ["media", objects],
      ["thumbs", thumbs],
      ["_uploads", stagingListing]
    ] as const;
    for (const [prefix, listing] of listings) {
      if (!listing.complete) {
        incompleteListings.push({
          backend,
          namespace,
          prefix,
          scanned: listing.count,
          limit: STORAGE_ADMIN_LIST_MAX_KEYS
        });
      }
    }

    const aliases = new Set(group.slugs);
    const retainedBeforeEnumeration = rowsBeforeEnumeration.filter((row) => (
      aliases.has(row.storage_slug)
      && (row.status === "ready" || row.status === "deleted")
    ));
    const retainedDuringEnumeration = rowsReferencedDuringEnumeration.filter((row) => (
      aliases.has(row.storage_slug)
      && (row.status === "ready" || row.status === "deleted")
    ));
    const objectSet = new Set(objects.keys);
    const thumbSet = new Set(thumbs.keys);
    for (const slug of group.slugs) {
      const rowsForSlug = retainedDuringEnumeration.filter((row) => (
        row.storage_slug === slug
      ));
      const sample = rowsForSlug.find((row) => objectSet.has(row.object_key))
        ?? rowsForSlug[0];
      if (!sample) continue;
      try {
        const access = await resolveStorageAccess(slug);
        const readable = await access.driver.exists(
          "media",
          sample.object_key,
          { signal }
        );
        if (objects.complete && objectSet.has(sample.object_key) && !readable) {
          unavailableBackends.push({
            backend: slug,
            namespace,
            blocks_maintenance: false,
            error: "对象已由同一物理命名空间确认存在，但此逻辑后端不可读"
          });
        }
      } catch (error) {
        signal?.throwIfAborted();
        unavailableBackends.push({
          backend: slug,
          namespace,
          blocks_maintenance: false,
          error: errorMessage(error)
        });
      }
    }
    const referencedObjectKeys = new Set(
      retainedDuringEnumeration.map((row) => row.object_key)
    );
    const referencedThumbKeys = new Set(
      retainedDuringEnumeration.map((row) => thumbnailRef(row).key)
    );
    const activeSessions = mergeActiveImportSessions(
      ...group.slugs.flatMap((slug) => [
        sessionsBeforeEnumeration.get(slug) ?? new Map(),
        sessionsAfterEnumeration.get(slug) ?? new Map()
      ])
    );
    const staging = classifyStagingKeys(stagingListing.keys, activeSessions);
    const importSessionIds = new Set(
      group.slugs.flatMap((slug) => [
        ...(sessionIdsDuringEnumeration.get(slug) ?? [])
      ])
    );
    for (const key of staging.orphan) {
      const sessionId = stagingSessionId(key);
      if (sessionId && importSessionIds.has(sessionId)) {
        retainedStagingFiles.push({
          key,
          backend,
          namespace,
          session_id: sessionId,
          reason: "导入会话仍存在，继续由导入清理流程负责"
        });
      } else {
        orphanStagingFiles.push({ key, backend, namespace });
      }
    }
    for (const { key, session } of staging.active) {
      activeStagingFiles.push({
        key,
        backend,
        namespace,
        storage_slug: session.storage_slug,
        session_id: session.id,
        status: session.status,
        expires_at: session.expires_at
      });
    }
    for (const session of activeSessions.values()) {
      for (const reference of importFinalStorageReferences(session)) {
        if (reference.prefix === "media") referencedObjectKeys.add(reference.key);
        if (reference.prefix === "thumbs") referencedThumbKeys.add(reference.key);
      }
    }

    for (const image of retainedBeforeEnumeration) {
      if (objects.complete && !objectSet.has(image.object_key)) {
        missingObjects.push({
          id: image.id,
          object_key: image.object_key,
          backend: image.storage_slug,
          namespace
        });
      }
      const thumbKey = thumbnailRef(image).key;
      if (thumbs.complete && !thumbSet.has(thumbKey)) {
        missingThumbs.push({
          id: image.id,
          object_key: image.object_key,
          thumb_key: thumbKey,
          backend: image.storage_slug,
          namespace
        });
      } else if (thumbSet.has(thumbKey) && Number(image.thumbnail_size) <= 0) {
        pendingThumbnailRepairs.push({
          id: image.id,
          object_key: image.object_key,
          thumb_key: thumbKey,
          backend: image.storage_slug,
          namespace,
          reason: "缩略图尚未由数据库确认真实大小，需要重新校验并采用"
        });
      }
    }
    for (const key of objects.keys) {
      if (!referencedObjectKeys.has(key)) {
        orphanObjects.push({ key, backend, namespace });
      }
    }
    for (const key of thumbs.keys) {
      if (!referencedThumbKeys.has(key)) {
        orphanThumbs.push({ key, backend, namespace });
      }
    }
  }
  return {
    missing_objects: missingObjects,
    missing_thumbs: missingThumbs,
    pending_thumbnail_repairs: pendingThumbnailRepairs,
    orphan_objects: orphanObjects,
    orphan_thumbs: orphanThumbs,
    active_staging_files: activeStagingFiles,
    retained_staging_files: retainedStagingFiles,
    orphan_staging_files: orphanStagingFiles,
    incomplete_listings: incompleteListings,
    unavailable_backends: unavailableBackends
  };
}
