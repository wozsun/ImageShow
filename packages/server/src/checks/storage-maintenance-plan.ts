import { pool } from "../core/database/pools.ts";
import { ingestionOrphanCutoffs } from "../images/ingestion/cleanup/retention.ts";
import {
  parseIngestionStagingCleanupKey
} from "../images/ingestion/staging-keys.ts";
import { thumbnailObjectKey } from "../storage/objects/image-paths.ts";
import { STORAGE_ADMIN_LIST_MAX_KEYS } from "../storage/objects/key-listing.ts";
import type { StoragePrefix } from "../storage/objects/keys.ts";
import {
  activeIngestionStorageReferences,
  classifyStagingKeys,
  collectStorageBackendGroupSnapshot,
  ingestionFinalStorageReferences,
  mergeActiveIngestionSessions,
  storageBackendGroups,
  type StorageBackendGroup,
  type StorageRow
} from "./storage-common.ts";

export type MaintenanceImage = StorageRow & {
  md5: string;
  thumbnail_size: string | number;
};

type MaintenanceAction =
  | "repair_thumbnail"
  | "remove_object"
  | "inspect_namespace"
  | "prune_directories";

export type MaintenanceOutcome =
  | "repaired"
  | "removed"
  | "skipped"
  | "failed";

export type MaintenanceItem = {
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

export type MaintenanceCandidate =
  | { kind: "repair"; imageId: string }
  | {
    kind: "remove";
    backend: string;
    prefix: StoragePrefix;
    key: string;
  }
  | { kind: "result"; item: MaintenanceItem };

export type CapturedMaintenanceGroup = {
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
  reason: string
): MaintenanceItem {
  return {
    action: "remove_object",
    outcome: "skipped",
    backend,
    prefix: "_uploads",
    key,
    reason
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
  const captured: CapturedMaintenanceGroup[] = [];
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
      ["full", result.snapshot.full],
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
  sessionsByBackend: ReadonlyMap<
    string,
    ReadonlyMap<string, Awaited<ReturnType<
      typeof activeIngestionStorageReferences
    >>["rows"][number]>
  >,
  groups: readonly CapturedMaintenanceGroup[],
  initial: readonly MaintenanceCandidate[],
  stagingCutoff: number
) {
  const candidates = [...initial];
  let activeStagingObjectsRetained = 0;

  for (const { group, backend, snapshot } of groups) {
    const retainedRows = retainedRowsForGroup(rows, group);
    const fullKeys = new Set(snapshot.full.keys);
    const thumbKeys = new Set(snapshot.thumbs.keys);
    for (const row of retainedRows) {
      const thumbKey = thumbnailObjectKey(row.object_key);
      if (
        !fullKeys.has(row.object_key)
        || !thumbKeys.has(thumbKey)
        || Number(row.thumbnail_size) <= 0
      ) {
        candidates.push({ kind: "repair", imageId: row.id });
      }
    }

    const referencedFull = new Set(retainedRows.flatMap((row) => (
      [row.object_key]
    )));
    const referencedThumbs = new Set(
      retainedRows.map((row) => thumbnailObjectKey(row.object_key))
    );
    const activeSessions = mergeActiveIngestionSessions(
      ...group.slugs.map((slug) => sessionsByBackend.get(slug) ?? new Map())
    );
    for (const session of activeSessions.values()) {
      for (const reference of ingestionFinalStorageReferences(session)) {
        if (reference.prefix === "full") referencedFull.add(reference.key);
        if (reference.prefix === "thumbs") referencedThumbs.add(reference.key);
      }
    }

    for (const key of snapshot.full.keys.toSorted()) {
      if (!referencedFull.has(key)) {
        candidates.push({ kind: "remove", backend, prefix: "full", key });
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
    activeStagingObjectsRetained += staging.active.length;
    const activePreparedKeys = new Set(
      [...activeSessions.values()].flatMap((session) => [
        session.prepared_image_key,
        session.prepared_thumbnail_key
      ].filter((key): key is string => Boolean(key)))
    );
    const selectedBackend = group.backends.find((candidate) => (
      candidate.slug === backend
    ));
    for (const key of staging.orphan) {
      const identity = parseIngestionStagingCleanupKey(key);
      const acceptedIdentity = identity
        && (!identity.local_atomic_candidate
          || selectedBackend?.type === "local")
        ? identity
        : null;
      if (
        acceptedIdentity?.local_atomic_candidate
        && activePreparedKeys.has(acceptedIdentity.base_key)
      ) {
        activeStagingObjectsRetained += 1;
      } else if (!acceptedIdentity) {
        candidates.push({
          kind: "result",
          item: skippedUploadItem(
            backend,
            key,
            "暂存键不符合当前 attempt generation 结构，无法证明年龄，保守保留"
          )
        });
      } else if (acceptedIdentity.created_at >= stagingCutoff) {
        candidates.push({
          kind: "result",
          item: skippedUploadItem(
            backend,
            key,
            "暂存对象尚未超过 24 小时、一个清理周期与安全余量的统一门槛"
          )
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
  return { candidates, activeStagingObjectsRetained };
}

export async function buildStorageMaintenancePlan(
  signal: AbortSignal,
  now = Date.now()
) {
  signal.throwIfAborted();
  const [rowsResult, ingestionReferences, groups] = await Promise.all([
    pool.query<MaintenanceImage>(maintenanceRowsQuery),
    activeIngestionStorageReferences({ signal }),
    storageBackendGroups()
  ]);
  signal.throwIfAborted();
  const capture = await captureMaintenanceGroups(groups, signal);
  signal.throwIfAborted();
  const built = buildMaintenanceCandidates(
    rowsResult.rows,
    ingestionReferences.sessionsByBackend,
    capture.captured,
    capture.candidates,
    ingestionOrphanCutoffs(now).stagingCutoff
  );
  return {
    activeStagingObjectsRetained: built.activeStagingObjectsRetained,
    candidates: built.candidates,
    capturedGroups: capture.captured
  };
}
