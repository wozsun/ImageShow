import { mapWithWorkerPool } from "../core/concurrency.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import {
  runWithAdvisoryLockAcquisitionSignal
} from "../core/database/advisory-locks.ts";
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
import { repairStorageThumbnail } from "./storage-thumbnail-repair.ts";

function summarizeMaintenance(
  items: readonly MaintenanceItem[],
  activeStagingObjectsRetained: number,
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
    active_staging_objects_retained: activeStagingObjectsRetained,
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
  const repairs: Array<Readonly<{ index: number; imageId: string }>> = [];
  const removals: Array<Readonly<{
    index: number;
    candidate: RemovalCandidate;
  }>> = [];
  for (const [index, candidate] of plan.candidates.entries()) {
    if (candidate.kind === "result") {
      settled.push({ index, item: candidate.item });
    } else if (candidate.kind === "repair") {
      repairs.push({ index, imageId: candidate.imageId });
    } else {
      removals.push({ index, candidate });
    }
  }
  // Each candidate is scheduled only by its actual resource owner. Repairs
  // and removals may progress together, while neither producer can overfill
  // the other resource's FIFO queue.
  const [repairOutcome, removalOutcome] = await Promise.allSettled([
    mapWithWorkerPool(
      repairs,
      getRuntimeConfig().normalize.concurrency,
      async ({ index, imageId }) => ({
        index,
        item: await repairStorageThumbnail(
          imageId,
          scheduleSignal,
          lockSignal
        )
      }),
      { signal: scheduleSignal }
    ),
    mapWithWorkerPool(
      removals,
      STORAGE_OBJECT_REMOVAL_CONCURRENCY,
      async ({ index, candidate }) => ({
        index,
        item: await removeStorageMaintenanceCandidate(
          candidate,
          scheduleSignal,
          lockSignal
        )
      }),
      { signal: scheduleSignal }
    )
  ]);
  // The caller signal stops new scheduling, but already-started storage work
  // deliberately finishes with the write-lock signal. Keep the advisory lock
  // until both resource pools have settled before propagating either failure.
  if (repairOutcome.status === "rejected") throw repairOutcome.reason;
  if (removalOutcome.status === "rejected") throw removalOutcome.reason;
  const repaired = repairOutcome.value;
  const removed = removalOutcome.value;
  const items = [...settled, ...repaired, ...removed]
    .sort((left, right) => left.index - right.index)
    .map(({ item }) => item);
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
    plan.activeStagingObjectsRetained,
    pruned.prunedDirectories
  );
}

export function maintainStorage(callerSignal?: AbortSignal) {
  callerSignal?.throwIfAborted();
  const maintain = () => withStorageLocationWriteLock((lockSignal) => (
    maintainStorageUnderLock(lockSignal, callerSignal)
  ));
  return callerSignal
    ? runWithAdvisoryLockAcquisitionSignal(callerSignal, maintain)
    : maintain();
}
