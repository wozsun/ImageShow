import { appConfig } from "@imageshow/shared";
import { pool } from "../core/database/pools.ts";
import { errorMessage } from "../core/api-error.ts";
import { inspectIngestionRawOrphans } from "../images/ingestion/raw/orphan-scanner.ts";
import { ingestionOrphanCutoffs } from "../images/ingestion/cleanup/retention.ts";
import {
  parseIngestionStagingCleanupKey
} from "../images/ingestion/staging-keys.ts";
import { resolveStorageAccess } from "../storage/backends/registry.ts";
import { thumbnailRef } from "../storage/objects/image-paths.ts";
import { STORAGE_ADMIN_LIST_MAX_KEYS } from "../storage/objects/key-listing.ts";
import {
  activeIngestionStorageReferences,
  classifyStagingKeys,
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
  const activeStagingFiles: Array<Record<string, unknown>> = [];
  const retainedStagingFiles: Array<Record<string, unknown>> = [];
  const orphanStagingFiles: Array<Record<string, unknown>> = [];
  const activeBeforeEnumeration = await activeIngestionStorageReferences({ signal });
  const { sessionsByBackend: sessionsBeforeEnumeration } = activeBeforeEnumeration;
  const checkedAt = Date.now();
  const cutoffs = ingestionOrphanCutoffs(checkedAt);
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
  // 避免刚创建的内容接入会话已经写入暂存对象、却被首轮快照漏掉而瞬时误报。
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
  const rawReferencePaths = new Set([
    ...activeBeforeEnumeration.rawPaths,
    ...activeSessionsAfterEnumeration.rawPaths
  ]);

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
    const activeSessions = mergeActiveIngestionSessions(
      ...group.slugs.flatMap((slug) => [
        sessionsBeforeEnumeration.get(slug) ?? new Map(),
        sessionsAfterEnumeration.get(slug) ?? new Map()
      ])
    );
    const staging = classifyStagingKeys(stagingListing.keys, activeSessions);
    const activePreparedSessions = new Map(
      [...activeSessions.values()].flatMap((session) => [
        session.prepared_image_key,
        session.prepared_thumbnail_key
      ].filter((key): key is string => Boolean(key)).map((key) => [
        key,
        session
      ] as const))
    );
    const selectedBackend = group.backends.find((candidate) => (
      candidate.slug === backend
    ));
    for (const key of staging.orphan) {
      const parsed = parseIngestionStagingCleanupKey(key);
      const identity = parsed
        && (!parsed.local_atomic_candidate
          || selectedBackend?.type === "local")
        ? parsed
        : null;
      const activeCandidateSession = identity?.local_atomic_candidate
        ? activePreparedSessions.get(identity.base_key)
        : undefined;
      if (activeCandidateSession) {
        activeStagingFiles.push({
          key,
          backend,
          namespace,
          storage_slug: activeCandidateSession.storage_slug,
          session_id: activeCandidateSession.id,
          status: activeCandidateSession.status,
          discard_at: activeCandidateSession.discard_at
        });
        continue;
      }
      if (!identity) {
        retainedStagingFiles.push({
          key,
          backend,
          namespace,
          reason: "暂存键不符合当前 attempt generation 结构，无法证明年龄，保守保留"
        });
      } else if (identity.created_at >= cutoffs.stagingCutoff) {
        retainedStagingFiles.push({
          key,
          backend,
          namespace,
          session_id: identity.session_id,
          created_at: identity.created_at,
          eligible_after: identity.created_at
            + (checkedAt - cutoffs.stagingCutoff),
          reason: "尚未超过 24 小时、一个清理周期与安全余量的统一门槛"
        });
      } else {
        orphanStagingFiles.push({
          key,
          backend,
          namespace,
          session_id: identity.session_id,
          created_at: identity.created_at
        });
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
        discard_at: session.discard_at
      });
    }
    for (const session of activeSessions.values()) {
      for (const reference of ingestionFinalStorageReferences(session)) {
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
  const staleRaw = await inspectIngestionRawOrphans({
    keep: rawReferencePaths,
    rawCutoff: cutoffs.rawCutoff,
    partCutoff: cutoffs.partCutoff,
    signal
  });
  return {
    missing_objects: missingObjects,
    missing_thumbs: missingThumbs,
    pending_thumbnail_repairs: pendingThumbnailRepairs,
    orphan_objects: orphanObjects,
    orphan_thumbs: orphanThumbs,
    active_staging_files: activeStagingFiles,
    retained_staging_files: retainedStagingFiles,
    orphan_staging_files: orphanStagingFiles,
    stale_ingestion_raw_files: staleRaw.raw,
    stale_ingestion_part_files: staleRaw.part,
    incomplete_ingestion_raw_scan: staleRaw.complete ? [] : [{
      limit: appConfig.ingestionRuntime.orphanCleanupMaxRawEntriesPerCycle,
      reason: "内容接入临时目录扫描达到固定上限；当前 stale 统计不是完整结果"
    }],
    incomplete_listings: incompleteListings,
    unavailable_backends: unavailableBackends
  };
}
