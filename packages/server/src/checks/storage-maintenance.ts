import { mapWithWorkerPool } from "../core/concurrency.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { runWithAdvisoryLockAcquisitionSignal } from "../core/database/advisory-locks.ts";
import { STORAGE_OBJECT_REMOVAL_CONCURRENCY } from "../storage/objects/removal-admission.ts";
import { withStorageLocationWriteLock } from "../storage/maintenance-lock.ts";
import {
  pruneStorageMaintenanceDirectories,
  removeStorageMaintenanceCandidate
} from "./storage-orphan-cleanup.ts";
import {
  buildStorageMaintenancePlan,
  type MaintenanceCandidate,
  type MaintenanceItem,
  type MaintenanceOutcome
} from "./storage-maintenance-plan.ts";
import { repairStorageVariant } from "./storage-variant-repair.ts";
import { maintainTrashPurgeTasks } from "../images/trash/purge-maintenance.ts";

function summarizeMaintenance(
  items: readonly MaintenanceItem[],
  prunedDirectories: number
) {
  const count = (outcome: MaintenanceOutcome) =>
    items.filter((item) => item.outcome === outcome).length;
  return {
    requested: items.length,
    repaired: count("repaired"),
    removed: count("removed"),
    skipped: count("skipped"),
    failed: count("failed"),
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
  const plan = await buildStorageMaintenancePlan(scheduleSignal);
  scheduleSignal.throwIfAborted();
  type IndexedItem = Readonly<{ index: number; item: MaintenanceItem }>;
  type RemovalCandidate = Extract<MaintenanceCandidate, { kind: "remove" }>;
  const settled: IndexedItem[] = [];
  const repairs: Array<Readonly<{ index: number; imageId: string; prefix: Extract<MaintenanceCandidate, { kind: "repair" }>["prefix"] }>> = [];
  const removals: Array<
    Readonly<{
      index: number;
      candidate: RemovalCandidate;
    }>
  > = [];
  for (const [index, candidate] of plan.candidates.entries()) {
    if (candidate.kind === "result") {
      settled.push({ index, item: candidate.item });
    } else if (candidate.kind === "repair") {
      repairs.push({ index, imageId: candidate.imageId, prefix: candidate.prefix });
    } else {
      removals.push({ index, candidate });
    }
  }
  // Retained replicas may be repair sources. Finish repairs before orphan removal.
  const repaired = await mapWithWorkerPool(
    repairs, getRuntimeConfig().normalize.concurrency,
    async ({ index, imageId, prefix }) => ({ index, item: await repairStorageVariant(imageId, prefix, scheduleSignal, lockSignal) }),
    { signal: scheduleSignal }
  );
  const failedKeys = new Set(repaired.filter(({ item }) => item.outcome === "failed").map(({ item }) => item.key));
  const removed = await mapWithWorkerPool(
    removals, STORAGE_OBJECT_REMOVAL_CONCURRENCY,
    async ({ index, candidate }) => ({ index, item: failedKeys.has(candidate.key)
      ? { action: "remove_object" as const, outcome: "skipped" as const, backend: candidate.backend, prefix: candidate.prefix, key: candidate.key, reason: "保留修复失败图片的副本供人工恢复" }
      : await removeStorageMaintenanceCandidate(candidate, scheduleSignal, lockSignal) }),
    { signal: scheduleSignal }
  );
  const items = [...settled, ...repaired, ...removed]
    .sort((left, right) => left.index - right.index)
    .map(({ item }) => item);
  scheduleSignal.throwIfAborted();
  const pruned = await pruneStorageMaintenanceDirectories(
    plan.capturedGroups,
    items,
    scheduleSignal,
    lockSignal
  );
  scheduleSignal.throwIfAborted();
  items.push(...pruned.failures);
  return summarizeMaintenance(
    items,
    pruned.prunedDirectories
  );
}

function maintainStorage(callerSignal?: AbortSignal) {
  callerSignal?.throwIfAborted();
  const maintain = () =>
    withStorageLocationWriteLock((lockSignal) =>
      maintainStorageUnderLock(lockSignal, callerSignal)
    );
  return callerSignal
    ? runWithAdvisoryLockAcquisitionSignal(callerSignal, maintain)
    : maintain();
}

export async function maintainStorageAndPurgeTasks(callerSignal?: AbortSignal) {
  const storage = await maintainStorage(callerSignal);
  callerSignal?.throwIfAborted();
  const trashPurge = await maintainTrashPurgeTasks();
  return { storage, trash_purge: trashPurge };
}
