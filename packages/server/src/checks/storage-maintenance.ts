import { mapWithWorkerPool } from "../core/concurrency.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { withStorageLocationWriteLock } from "../storage/maintenance-lock.ts";
import {
  pruneStorageMaintenanceDirectories,
  removeStorageMaintenanceCandidate
} from "./storage-orphan-cleanup.ts";
import {
  buildStorageMaintenancePlan,
  type MaintenanceItem,
  type MaintenanceOutcome
} from "./storage-maintenance-plan.ts";
import { repairStorageThumbnail } from "./storage-thumbnail-repair.ts";

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
  const plan = await buildStorageMaintenancePlan(scheduleSignal);
  scheduleSignal.throwIfAborted();
  const items = await mapWithWorkerPool(
    plan.candidates,
    getRuntimeConfig().upload.concurrency,
    (candidate) => {
      if (candidate.kind === "result") return Promise.resolve(candidate.item);
      if (candidate.kind === "repair") {
        return repairStorageThumbnail(candidate.imageId, lockSignal);
      }
      return removeStorageMaintenanceCandidate(candidate, lockSignal);
    },
    { signal: scheduleSignal }
  );
  scheduleSignal.throwIfAborted();
  const pruned = await pruneStorageMaintenanceDirectories(
    plan.capturedGroups,
    scheduleSignal,
    lockSignal
  );
  scheduleSignal.throwIfAborted();
  items.push(...pruned.failures);
  return summarizeMaintenance(
    items,
    plan.activeUploadsRetained,
    pruned.prunedDirectories
  );
}

export function maintainStorage(callerSignal?: AbortSignal) {
  callerSignal?.throwIfAborted();
  return withStorageLocationWriteLock((lockSignal) => (
    maintainStorageUnderLock(lockSignal, callerSignal)
  ));
}
