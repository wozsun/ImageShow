import { errorMessage } from "../core/api-error.ts";
import {
  pruneEmptyStorageDirs,
  removeStorageObjectAndConfirm
} from "../storage/objects/access.ts";
import type {
  CapturedMaintenanceGroup,
  MaintenanceCandidate,
  MaintenanceItem
} from "./storage-maintenance-plan.ts";

export async function removeStorageMaintenanceCandidate(
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

export async function pruneStorageMaintenanceDirectories(
  groups: readonly CapturedMaintenanceGroup[],
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
