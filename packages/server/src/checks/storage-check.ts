import { appConfig } from "@imageshow/shared";
import { pool } from "../core/database/pools.ts";
import { errorMessage } from "../core/api-error.ts";
import { inspectIngestionTempOrphans } from "../images/ingestion/raw/orphan-scanner.ts";
import { ingestionOrphanCutoffs } from "../images/ingestion/cleanup/retention.ts";
import { resolveStorageAccess } from "../storage/backends/registry.ts";
import {
  assertCanonicalImageObjectKey,
  thumbnailRef
} from "../storage/objects/image-paths.ts";
import { STORAGE_ADMIN_LIST_MAX_KEYS } from "../storage/objects/key-listing.ts";
import {
  activeIngestionStorageReferences,
  collectStorageBackendGroupSnapshot,
  ingestionFinalStorageReferences,
  mergeActiveIngestionSessions,
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
  const activeBeforeEnumeration = await activeIngestionStorageReferences({ signal });
  const { sessionsByBackend: sessionsBeforeEnumeration } = activeBeforeEnumeration;
  const checkedAt = Date.now();
  const cutoffs = ingestionOrphanCutoffs(checkedAt);
  const incompleteListings: Array<{
    backend: string;
    namespace: string;
    prefix: "full" | "thumbs";
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
  // 保护枚举期间新增的正式候选和本地临时文件引用，避免快照时差造成误报。
  const [
    rowsAfterEnumerationResult,
    activeSessionsAfterEnumeration
  ] = await Promise.all([
    pool.query(storageRowsQuery),
    activeIngestionStorageReferences({ signal })
  ]);
  const rowsAfterEnumeration = rowsAfterEnumerationResult.rows as StorageRow[];
  const rowsReferencedDuringEnumeration = mergeStorageReferenceRows(
    rowsBeforeEnumeration,
    rowsAfterEnumeration
  );
  const { sessionsByBackend: sessionsAfterEnumeration } = activeSessionsAfterEnumeration;
  const tempReferencePaths = new Set([
    ...activeBeforeEnumeration.tempPaths,
    ...activeSessionsAfterEnumeration.tempPaths
  ]);

  for (const captured of storageSnapshots) {
    if (!captured) continue;
    const { group, backend } = captured;
    const namespace = storageBackendGroupName(group);
    const {
      full,
      thumbs
    } = captured.snapshot;
    const listings = [
      ["full", full],
      ["thumbs", thumbs]
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
    const fullSet = new Set(full.keys);
    const thumbSet = new Set(thumbs.keys);
    for (const row of retainedDuringEnumeration) {
      assertCanonicalImageObjectKey(row.object_key);
    }
    for (const slug of group.slugs) {
      const rowsForSlug = retainedDuringEnumeration.filter((row) => (
        row.storage_slug === slug
      ));
      const sample = rowsForSlug.find((row) => (
        fullSet.has(row.object_key)
      ))
        ?? rowsForSlug[0];
      if (!sample) continue;
      try {
        const access = await resolveStorageAccess(slug);
        const readable = await access.driver.exists(
          "full",
          sample.object_key,
          { signal }
        );
        if (
          full.complete
          && fullSet.has(sample.object_key)
          && !readable
        ) {
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
    const referencedFullKeys = new Set(
      retainedDuringEnumeration.map((row) => row.object_key)
    );
    const referencedThumbKeys = new Set(
      retainedDuringEnumeration.map((row) => thumbnailRef(row).key)
    );
    const activeSessions = mergeActiveIngestionSessions(
      ...group.slugs.flatMap((slug) => [
        sessionsBeforeEnumeration.get(slug) ?? new Map(),
        sessionsAfterEnumeration.get(slug) ?? new Map()
      ])
    );
    for (const session of activeSessions.values()) {
      for (const reference of ingestionFinalStorageReferences(session)) {
        if (reference.prefix === "full") referencedFullKeys.add(reference.key);
        if (reference.prefix === "thumbs") referencedThumbKeys.add(reference.key);
      }
    }

    for (const image of retainedBeforeEnumeration) {
      if (full.complete && !fullSet.has(image.object_key)) {
        missingObjects.push({
          id: image.id,
          object_key: image.object_key,
          prefix: "full",
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
    for (const key of full.keys) {
      if (!referencedFullKeys.has(key)) {
        orphanObjects.push({ prefix: "full", key, backend, namespace });
      }
    }
    for (const key of thumbs.keys) {
      if (!referencedThumbKeys.has(key)) {
        orphanThumbs.push({ key, backend, namespace });
      }
    }
  }
  const staleTemp = await inspectIngestionTempOrphans({
    keep: tempReferencePaths,
    fileCutoff: cutoffs.fileCutoff,
    partCutoff: cutoffs.partCutoff,
    signal
  });
  return {
    missing_objects: missingObjects,
    missing_thumbs: missingThumbs,
    pending_thumbnail_repairs: pendingThumbnailRepairs,
    orphan_objects: orphanObjects,
    orphan_thumbs: orphanThumbs,
    stale_ingestion_raw_files: staleTemp.raw,
    stale_ingestion_part_files: staleTemp.part,
    stale_ingestion_prepared_files: staleTemp.prepared,
    ingestion_temp_space: { total_bytes: staleTemp.total_bytes, retained_bytes: staleTemp.retained_bytes, complete: staleTemp.complete },
    incomplete_ingestion_temp_scan: staleTemp.complete ? [] : [{
      limit: appConfig.ingestionRuntime.orphanCleanupMaxTempEntriesPerCycle,
      reason: "内容接入临时目录扫描达到固定上限；当前 stale 统计不是完整结果"
    }],
    incomplete_listings: incompleteListings,
    unavailable_backends: unavailableBackends
  };
}
