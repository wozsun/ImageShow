import { storageObjectKey } from "@imageshow/shared/browser";
import { pool } from "../core/database/pools.ts";
import {
  STORAGE_ADMIN_LIST_MAX_KEYS,
  type StorageDirectorySnapshot
} from "../storage/objects/key-listing.ts";
import { STORAGE_PREFIXES, type StoragePrefix } from "../storage/objects/keys.ts";
import {
  activeIngestionStorageReferences,
  collectStorageBackendGroupSnapshot,
  ingestionFinalStorageReferences,
  mergeActiveIngestionStorageReferences,
  storageBackendGroups,
  type StorageBackendGroup,
  type ImageStorageReferenceRow
} from "./storage-inventory.ts";

export type MaintenanceImage = ImageStorageReferenceRow & { purging: boolean };

type MaintenanceAction =
  "repair_variant" | "remove_object" | "inspect_namespace" | "prune_directories";

export type MaintenanceOutcome = "repaired" | "removed" | "skipped" | "failed";

export type MaintenanceItem = {
  action: MaintenanceAction;
  outcome: MaintenanceOutcome;
  backend: string;
  prefix: StoragePrefix | "*";
  key: string;
  image_id?: string;
  byte_size?: number;
  reason?: string;
  error?: string;
};

export type MaintenanceCandidate =
  | { kind: "repair"; imageId: string; prefix: StoragePrefix }
  | {
      kind: "remove";
      backend: string;
      prefix: StoragePrefix;
      key: string;
    }
  | { kind: "result"; item: MaintenanceItem };

export type CapturedMaintenanceGroup = {
  directorySnapshot: StorageDirectorySnapshot;
  group: StorageBackendGroup;
  backend: string;
  snapshot: NonNullable<Awaited<ReturnType<typeof collectStorageBackendGroupSnapshot>>["snapshot"]>;
};

const maintenanceRowsQuery = `
  SELECT id, status, storage_slug,
         status='deleted' AND EXISTS (SELECT 1 FROM background_job
                  WHERE type='trash.purge' AND target_id=metadata.id::text) AS purging
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

function retainedRowsForGroup(
  rows: readonly MaintenanceImage[],
  group: StorageBackendGroup
) {
  const slugs = new Set(group.slugs);
  return rows.filter(
    (row) => slugs.has(row.storage_slug)
      && (row.status === "ready" || row.status === "deleted")
  );
}

async function captureMaintenanceGroups(
  groups: readonly StorageBackendGroup[],
  signal: AbortSignal
) {
  const captured: CapturedMaintenanceGroup[] = [];
  const candidates: MaintenanceCandidate[] = [];
  for (const group of groups) {
    signal.throwIfAborted();
    const directorySnapshot: StorageDirectorySnapshot = {
      directories: new Map(),
      entries: 0,
      complete: true
    };
    const result = await collectStorageBackendGroupSnapshot(group, {
      directorySnapshot,
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
          result.errors.map((entry) => `${entry.backend}: ${entry.error}`).join("; ") ||
            "存储后端不可用"
        )
      });
      continue;
    }
    const incomplete = (
      STORAGE_PREFIXES.map((prefix) => [prefix, result.snapshot[prefix]] as const)
    ).filter(([, listing]) => !listing.complete);
    if (incomplete.length) {
      for (const [prefix, listing] of incomplete) {
        candidates.push({
          kind: "result",
          item: failedNamespaceItem(
            result.backend,
            prefix,
            `存储键列举达到 ${STORAGE_ADMIN_LIST_MAX_KEYS} 项上限；` +
              `未使用不完整快照执行维护（已扫描 ${listing.count} 项）`
          )
        });
      }
      continue;
    }
    captured.push({
      directorySnapshot,
      group,
      backend: result.backend,
      snapshot: result.snapshot
    });
  }
  return { captured, candidates };
}

function buildMaintenanceCandidates(
  rows: readonly MaintenanceImage[],
  referencesByBackend: ReadonlyMap<
    string,
    ReadonlyMap<
      string,
      Awaited<ReturnType<typeof activeIngestionStorageReferences>>["rows"][number]
    >
  >,
  groups: readonly CapturedMaintenanceGroup[],
  initial: readonly MaintenanceCandidate[]
) {
  const candidates = [...initial];
  const retained = new Map(rows
    .filter((row) => row.status === "ready" || row.status === "deleted")
    .map((row) => [storageObjectKey(row.id), row]));
  const inspectedSlugs = new Set(groups.flatMap(({ group }) => group.slugs));
  const repairs = new Set<string>();
  const addRepair = (row: MaintenanceImage, prefix: StoragePrefix) => {
    const identity = `${row.id}:${prefix}`;
    if (repairs.has(identity)) return;
    repairs.add(identity);
    candidates.push({ kind: "repair", imageId: row.id, prefix });
  };
  for (const { group, backend, snapshot } of groups) {
    const retainedRows = retainedRowsForGroup(rows, group);
    const activeReferences = mergeActiveIngestionStorageReferences(
      ...group.slugs.map((slug) => referencesByBackend.get(slug) ?? new Map())
    );
    for (const prefix of STORAGE_PREFIXES) {
      const present = new Set(snapshot[prefix].keys);
      const referenced = new Set(retainedRows.map((row) => storageObjectKey(row.id)));
      for (const row of retainedRows) {
        if (!row.purging && !present.has(storageObjectKey(row.id))) addRepair(row, prefix);
      }
      for (const active of activeReferences.values()) {
        for (const reference of ingestionFinalStorageReferences(active)) {
          if (reference.prefix === prefix) referenced.add(reference.key);
        }
      }
      for (const key of snapshot[prefix].keys.toSorted()) {
        if (referenced.has(key)) continue;
        const owner = retained.get(key);
        if (owner?.purging || (owner && !inspectedSlugs.has(owner.storage_slug))) {
          candidates.push({ kind: "result", item: {
            action: "remove_object", outcome: "skipped", backend, prefix, key,
            image_id: owner.id,
            reason: owner.purging
              ? "图片由永久删除任务处理，保留现存对象"
              : "当前位置未完成检查，保留副本供恢复"
          } });
          continue;
        }
        // PostgreSQL facts survive failed writes and restarts. Prove the current
        // object before deleting any retained image's cross-namespace replica.
        if (owner) addRepair(owner, prefix);
        candidates.push({ kind: "remove", backend, prefix, key });
      }
    }
  }
  return { candidates };
}

export async function buildStorageMaintenancePlan(signal: AbortSignal) {
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
    ingestionReferences.referencesByBackend,
    capture.captured,
    capture.candidates
  );
  return {
    candidates: built.candidates,
    capturedGroups: capture.captured
  };
}
