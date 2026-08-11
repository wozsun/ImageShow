import { ApiError, errorMessage } from "../core/api-error.ts";
import { mapWithWorkerPool } from "../core/concurrency.ts";
import { pool } from "../core/database-pools.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { stagingSessionId } from "../images/imports/staging-keys.ts";
import { createThumbnail, md5Buffer, sha256Buffer } from "../images/processing.ts";
import { resolveStorageAccess } from "../storage/backend-registry.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import { STORAGE_ADMIN_LIST_MAX_KEYS } from "../storage/key-listing.ts";
import { withStorageLocationWriteLock } from "../storage/maintenance-lock.ts";
import {
  pruneEmptyStorageDirs,
  removeStorageObjectAndConfirm
} from "../storage/object-access.ts";
import {
  digestStorageObject,
  type StorageEndpoint
} from "../storage/object-transfer.ts";
import type { StoragePrefix } from "../storage/object-keys.ts";
import { assertObjectNotPendingCleanup } from "../storage/move-cleanup.ts";
import {
  activeImportStorageReferences,
  classifyStagingKeys,
  collectStorageBackendGroupSnapshot,
  importFinalStorageReferences,
  importSessionIdsByBackend,
  mergeActiveImportSessions,
  storageBackendGroups,
  type StorageBackendGroup,
  type StorageRow
} from "./storage-common.ts";

type MaintenanceImage = StorageRow & {
  md5: string;
  thumbnail_size: string | number;
};

type MaintenanceAction =
  | "repair_thumbnail"
  | "remove_object"
  | "inspect_namespace"
  | "prune_directories";

type MaintenanceOutcome = "repaired" | "removed" | "skipped" | "failed";

type MaintenanceItem = {
  action: MaintenanceAction;
  outcome: MaintenanceOutcome;
  backend: string;
  prefix: StoragePrefix | "*";
  key: string;
  image_id?: string;
  thumbnail_size?: number;
  reason?: string;
  error?: string;
};

type MaintenanceCandidate =
  | { kind: "repair"; imageId: string }
  | {
    kind: "remove";
    backend: string;
    prefix: StoragePrefix;
    key: string;
  }
  | { kind: "result"; item: MaintenanceItem };

type CapturedGroup = {
  group: StorageBackendGroup;
  backend: string;
  snapshot: NonNullable<Awaited<ReturnType<
    typeof collectStorageBackendGroupSnapshot
  >>["snapshot"]>;
};

const maintenanceRowsQuery = `
  SELECT id, object_key, status, storage_slug, md5, thumbnail_size
    FROM metadata
   ORDER BY id ASC`;

function failedNamespaceItem(
  backend: string,
  prefix: StoragePrefix | "*",
  error: string
): MaintenanceItem {
  return {
    action: "inspect_namespace",
    outcome: "failed",
    backend,
    prefix,
    key: "*",
    error
  };
}

function skippedUploadItem(
  backend: string,
  key: string,
  sessionId: string
): MaintenanceItem {
  return {
    action: "remove_object",
    outcome: "skipped",
    backend,
    prefix: "_uploads",
    key,
    reason: `导入会话 ${sessionId} 尚未清理，暂存对象继续由导入清理流程负责`
  };
}

function retainedRowsForGroup(
  rows: readonly MaintenanceImage[],
  group: StorageBackendGroup
) {
  const slugs = new Set(group.slugs);
  return rows.filter((row) => (
    slugs.has(row.storage_slug)
    && (row.status === "ready" || row.status === "deleted")
  ));
}

async function captureMaintenanceGroups(
  groups: readonly StorageBackendGroup[],
  signal: AbortSignal
) {
  const captured: CapturedGroup[] = [];
  const candidates: MaintenanceCandidate[] = [];
  for (const group of groups) {
    signal.throwIfAborted();
    const result = await collectStorageBackendGroupSnapshot(group, {
      signal,
      maxKeys: STORAGE_ADMIN_LIST_MAX_KEYS
    });
    signal.throwIfAborted();
    if (!result.snapshot) {
      candidates.push({
        kind: "result",
        item: failedNamespaceItem(
          group.slugs.join(" / "),
          "*",
          result.errors.map((entry) => (
            `${entry.backend}: ${entry.error}`
          )).join("; ") || "存储后端不可用"
        )
      });
      continue;
    }
    const incomplete = ([
      ["media", result.snapshot.media],
      ["thumbs", result.snapshot.thumbs],
      ["_uploads", result.snapshot._uploads]
    ] as const).filter(([, listing]) => !listing.complete);
    if (incomplete.length) {
      for (const [prefix, listing] of incomplete) {
        candidates.push({
          kind: "result",
          item: failedNamespaceItem(
            result.backend,
            prefix,
            `存储键列举达到 ${STORAGE_ADMIN_LIST_MAX_KEYS} 项上限；`
              + `未使用不完整快照执行维护（已扫描 ${listing.count} 项）`
          )
        });
      }
      continue;
    }
    captured.push({
      group,
      backend: result.backend,
      snapshot: result.snapshot
    });
  }
  return { captured, candidates };
}

function buildMaintenanceCandidates(
  rows: readonly MaintenanceImage[],
  importSessionIdsByBackend: ReadonlyMap<string, ReadonlySet<string>>,
  sessionsByBackend: ReadonlyMap<
    string,
    ReadonlyMap<string, Awaited<ReturnType<
      typeof activeImportStorageReferences
    >>["rows"][number]>
  >,
  groups: readonly CapturedGroup[],
  initial: readonly MaintenanceCandidate[]
) {
  const candidates = [...initial];
  let activeUploadsRetained = 0;

  for (const { group, backend, snapshot } of groups) {
    const retainedRows = retainedRowsForGroup(rows, group);
    const mediaKeys = new Set(snapshot.media.keys);
    const thumbKeys = new Set(snapshot.thumbs.keys);
    for (const row of retainedRows) {
      const thumbKey = thumbnailObjectKey(row.object_key);
      if (
        !mediaKeys.has(row.object_key)
        || !thumbKeys.has(thumbKey)
        || Number(row.thumbnail_size) <= 0
      ) {
        candidates.push({ kind: "repair", imageId: row.id });
      }
    }

    const referencedMedia = new Set(retainedRows.map((row) => row.object_key));
    const referencedThumbs = new Set(
      retainedRows.map((row) => thumbnailObjectKey(row.object_key))
    );
    const activeSessions = mergeActiveImportSessions(
      ...group.slugs.map((slug) => sessionsByBackend.get(slug) ?? new Map())
    );
    const importSessionIds = new Set(
      group.slugs.flatMap((slug) => [
        ...(importSessionIdsByBackend.get(slug) ?? [])
      ])
    );
    for (const session of activeSessions.values()) {
      for (const reference of importFinalStorageReferences(session)) {
        if (reference.prefix === "media") referencedMedia.add(reference.key);
        if (reference.prefix === "thumbs") referencedThumbs.add(reference.key);
      }
    }

    for (const key of snapshot.media.keys.toSorted()) {
      if (!referencedMedia.has(key)) {
        candidates.push({ kind: "remove", backend, prefix: "media", key });
      }
    }
    for (const key of snapshot.thumbs.keys.toSorted()) {
      if (!referencedThumbs.has(key)) {
        candidates.push({ kind: "remove", backend, prefix: "thumbs", key });
      }
    }

    const staging = classifyStagingKeys(
      snapshot._uploads.keys.toSorted(),
      activeSessions
    );
    activeUploadsRetained += staging.active.length;
    for (const key of staging.orphan) {
      const sessionId = stagingSessionId(key);
      if (sessionId && importSessionIds.has(sessionId)) {
        candidates.push({
          kind: "result",
          item: skippedUploadItem(backend, key, sessionId)
        });
      } else {
        candidates.push({
          kind: "remove",
          backend,
          prefix: "_uploads",
          key
        });
      }
    }
  }
  return { candidates, activeUploadsRetained };
}

async function readThumbnailAuthority(imageId: string) {
  return (await pool.query<MaintenanceImage>(
    `SELECT id, object_key, status, storage_slug, md5, thumbnail_size
       FROM metadata
      WHERE id=$1`,
    [imageId]
  )).rows[0];
}

function sameThumbnailAuthority(
  before: MaintenanceImage,
  after: MaintenanceImage | undefined
) {
  return Boolean(
    after
    && (after.status === "ready" || after.status === "deleted")
    && after.object_key === before.object_key
    && after.storage_slug === before.storage_slug
  );
}

async function cleanupFailedThumbnailWrite(
  storage: StorageEndpoint,
  key: string,
  signal: AbortSignal,
  failure: unknown
): Promise<never> {
  try {
    await removeStorageObjectAndConfirm(
      "thumbs",
      key,
      storage.config.slug,
      { signal }
    );
  } catch (cleanupError) {
    signal.throwIfAborted();
    throw new AggregateError(
      [failure, cleanupError],
      "缩略图写入失败，且无法确认候选对象已清理"
    );
  }
  throw failure;
}

async function writeVerifiedThumbnail(
  storage: StorageEndpoint,
  key: string,
  body: Buffer,
  signal: AbortSignal
) {
  signal.throwIfAborted();

  let writeFailure: unknown;
  try {
    await storage.driver.writeBuffer(
      "thumbs",
      key,
      body,
      "image/webp",
      { signal }
    );
  } catch (error) {
    signal.throwIfAborted();
    writeFailure = error;
  }

  let digest;
  try {
    digest = await digestStorageObject(storage, "thumbs", key, { signal });
  } catch (error) {
    signal.throwIfAborted();
    return cleanupFailedThumbnailWrite(
      storage,
      key,
      signal,
      writeFailure ?? error
    );
  }
  const matches = digest.size === body.byteLength
    && digest.sha256 === sha256Buffer(body);
  if (!matches) {
    return cleanupFailedThumbnailWrite(
      storage,
      key,
      signal,
      new ApiError(
        502,
        "storage_transfer_integrity_failed",
        "缩略图写入后完整性校验失败",
        { backend: storage.config.slug, prefix: "thumbs", key }
      )
    );
  }
  return { responseRecovered: writeFailure !== undefined };
}

async function persistThumbnailSize(
  authority: MaintenanceImage,
  thumbnailSize: number,
  signal: AbortSignal
) {
  let updateFailure: unknown;
  try {
    const updated = await pool.query(
      `UPDATE metadata
          SET thumbnail_size=$2
        WHERE id=$1
          AND storage_slug=$3
          AND object_key=$4
          AND status IN ('ready','deleted')`,
      [
        authority.id,
        thumbnailSize,
        authority.storage_slug,
        authority.object_key
      ]
    );
    signal.throwIfAborted();
    if (updated.rowCount) return;
  } catch (error) {
    signal.throwIfAborted();
    updateFailure = error;
  }

  const current = await readThumbnailAuthority(authority.id);
  signal.throwIfAborted();
  if (
    sameThumbnailAuthority(authority, current)
    && Number(current?.thumbnail_size) === thumbnailSize
  ) {
    return;
  }
  if (updateFailure) throw updateFailure;
  throw new ApiError(
    409,
    "image_location_changed",
    "图片位置或缩略图状态在维修期间发生变化",
    { image_id: authority.id }
  );
}

async function repairThumbnail(
  imageId: string,
  signal: AbortSignal
): Promise<MaintenanceItem> {
  let authority: MaintenanceImage | undefined;
  try {
    signal.throwIfAborted();
    authority = await readThumbnailAuthority(imageId);
    signal.throwIfAborted();
    if (!authority) {
      return {
        action: "repair_thumbnail",
        outcome: "skipped",
        backend: "unknown",
        prefix: "thumbs",
        key: "*",
        image_id: imageId,
        reason: "图片记录已不存在"
      };
    }
    const thumbKey = thumbnailObjectKey(authority.object_key);
    const itemBase = {
      action: "repair_thumbnail" as const,
      backend: authority.storage_slug,
      prefix: "thumbs" as const,
      key: thumbKey,
      image_id: authority.id
    };
    if (authority.status !== "ready" && authority.status !== "deleted") {
      return { ...itemBase, outcome: "skipped", reason: "图片不再处于保留状态" };
    }

    const storage = await resolveStorageAccess(authority.storage_slug);
    signal.throwIfAborted();
    await assertObjectNotPendingCleanup(storage.config, "thumbs", thumbKey);
    signal.throwIfAborted();
    if (!await storage.driver.exists("media", authority.object_key, { signal })) {
      return { ...itemBase, outcome: "skipped", reason: "当前位置的原图不存在" };
    }
    const thumbnailExists = await storage.driver.exists(
      "thumbs",
      thumbKey,
      { signal }
    );
    if (thumbnailExists && Number(authority.thumbnail_size) > 0) {
      return { ...itemBase, outcome: "skipped", reason: "缩略图已存在，无需维修" };
    }
    const source = await storage.driver.readBuffer(
      "media",
      authority.object_key,
      { signal }
    );
    signal.throwIfAborted();
    if (authority.md5 && md5Buffer(source) !== authority.md5) {
      throw new ApiError(
        502,
        "storage_source_integrity_failed",
        "源存储对象与数据库记录的 MD5 不一致",
        { image_id: authority.id, object_key: authority.object_key }
      );
    }
    const thumbnail = await createThumbnail(source);
    signal.throwIfAborted();

    const current = await readThumbnailAuthority(authority.id);
    signal.throwIfAborted();
    if (!sameThumbnailAuthority(authority, current)) {
      return { ...itemBase, outcome: "skipped", reason: "生成后图片位置或状态已变化" };
    }
    const currentStorage = await resolveStorageAccess(current!.storage_slug);
    signal.throwIfAborted();
    const currentThumbnailExists = await currentStorage.driver.exists(
      "thumbs",
      thumbKey,
      { signal }
    );
    if (currentThumbnailExists && Number(current!.thumbnail_size) > 0) {
      return { ...itemBase, outcome: "skipped", reason: "生成期间缩略图已恢复" };
    }
    if (currentThumbnailExists) {
      await removeStorageObjectAndConfirm(
        "thumbs",
        thumbKey,
        current!.storage_slug,
        { signal }
      );
      signal.throwIfAborted();
    }
    await persistThumbnailSize(current!, 0, signal);
    const pendingAuthority = { ...current!, thumbnail_size: 0 };
    const materialized = await writeVerifiedThumbnail(
      currentStorage,
      thumbKey,
      thumbnail,
      signal
    );
    signal.throwIfAborted();
    try {
      await persistThumbnailSize(
        pendingAuthority,
        thumbnail.byteLength,
        signal
      );
    } catch (error) {
      signal.throwIfAborted();
      return await cleanupFailedThumbnailWrite(
        currentStorage,
        thumbKey,
        signal,
        error
      );
    }
    signal.throwIfAborted();
    return {
      ...itemBase,
      outcome: "repaired",
      thumbnail_size: thumbnail.byteLength,
      ...(materialized.responseRecovered
        ? { reason: "写入响应丢失后已通过完整性回读确认" }
        : {})
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return {
      action: "repair_thumbnail",
      outcome: "failed",
      backend: authority?.storage_slug ?? "unknown",
      prefix: "thumbs",
      key: authority ? thumbnailObjectKey(authority.object_key) : "*",
      image_id: imageId,
      error: errorMessage(error)
    };
  }
}

async function removeCandidate(
  candidate: Extract<MaintenanceCandidate, { kind: "remove" }>,
  signal: AbortSignal
): Promise<MaintenanceItem> {
  try {
    signal.throwIfAborted();
    const result = await removeStorageObjectAndConfirm(
      candidate.prefix,
      candidate.key,
      candidate.backend,
      { signal }
    );
    signal.throwIfAborted();
    return {
      action: "remove_object",
      outcome: result === "removed" ? "removed" : "skipped",
      backend: candidate.backend,
      prefix: candidate.prefix,
      key: candidate.key,
      ...(result === "missing" ? { reason: "对象已不存在" } : {})
    };
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    return {
      action: "remove_object",
      outcome: "failed",
      backend: candidate.backend,
      prefix: candidate.prefix,
      key: candidate.key,
      error: errorMessage(error)
    };
  }
}

async function pruneCapturedGroups(
  groups: readonly CapturedGroup[],
  scheduleSignal: AbortSignal,
  lockSignal: AbortSignal
) {
  let prunedDirectories = 0;
  const failures: MaintenanceItem[] = [];
  for (const { backend } of groups) {
    scheduleSignal.throwIfAborted();
    try {
      prunedDirectories += await pruneEmptyStorageDirs(backend, {
        signal: lockSignal
      });
      lockSignal.throwIfAborted();
    } catch (error) {
      if (lockSignal.aborted) throw lockSignal.reason ?? error;
      failures.push({
        action: "prune_directories",
        outcome: "failed",
        backend,
        prefix: "*",
        key: "*",
        error: errorMessage(error)
      });
    }
  }
  return { prunedDirectories, failures };
}

function summarizeMaintenance(
  items: readonly MaintenanceItem[],
  activeUploadsRetained: number,
  prunedDirectories: number
) {
  const count = (outcome: MaintenanceOutcome) => (
    items.filter((item) => item.outcome === outcome).length
  );
  return {
    requested: items.length,
    repaired: count("repaired"),
    removed: count("removed"),
    skipped: count("skipped"),
    failed: count("failed"),
    active_uploads_retained: activeUploadsRetained,
    pruned_dirs: prunedDirectories,
    items
  };
}

async function maintainStorageUnderLock(
  lockSignal: AbortSignal,
  callerSignal?: AbortSignal
) {
  const scheduleSignal = callerSignal
    ? AbortSignal.any([callerSignal, lockSignal])
    : lockSignal;
  scheduleSignal.throwIfAborted();
  const [rowsResult, importReferences, sessionIdsByBackend, groups] = await Promise.all([
    pool.query(maintenanceRowsQuery),
    activeImportStorageReferences(),
    importSessionIdsByBackend(),
    storageBackendGroups()
  ]);
  scheduleSignal.throwIfAborted();
  const rows = rowsResult.rows as MaintenanceImage[];
  const capture = await captureMaintenanceGroups(groups, scheduleSignal);
  scheduleSignal.throwIfAborted();
  const built = buildMaintenanceCandidates(
    rows,
    sessionIdsByBackend,
    importReferences.sessionsByBackend,
    capture.captured,
    capture.candidates
  );
  const items = await mapWithWorkerPool(
    built.candidates,
    getRuntimeConfig().upload.concurrency,
    (candidate) => {
      if (candidate.kind === "result") return Promise.resolve(candidate.item);
      if (candidate.kind === "repair") {
        return repairThumbnail(candidate.imageId, lockSignal);
      }
      return removeCandidate(candidate, lockSignal);
    },
    { signal: scheduleSignal }
  );
  scheduleSignal.throwIfAborted();
  const pruned = await pruneCapturedGroups(
    capture.captured,
    scheduleSignal,
    lockSignal
  );
  scheduleSignal.throwIfAborted();
  items.push(...pruned.failures);
  return summarizeMaintenance(
    items,
    built.activeUploadsRetained,
    pruned.prunedDirectories
  );
}

export function maintainStorage(callerSignal?: AbortSignal) {
  callerSignal?.throwIfAborted();
  return withStorageLocationWriteLock((lockSignal) => (
    maintainStorageUnderLock(lockSignal, callerSignal)
  ));
}
