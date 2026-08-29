import { errorMessage } from "../core/api-error.ts";
import {
  assertStorageRemovalResults,
  pruneEmptyStorageDirs,
  removeStorageObjectsAndConfirm
} from "../storage/objects/access.ts";
import type {
  CapturedMaintenanceGroup,
  MaintenanceCandidate,
  MaintenanceItem
} from "./storage-maintenance-plan.ts";

export async function removeStorageMaintenanceCandidate(
  candidate: Extract<MaintenanceCandidate, { kind: "remove" }>,
  scheduleSignal: AbortSignal,
  operationSignal: AbortSignal = scheduleSignal
): Promise<MaintenanceItem> {
  try {
    scheduleSignal.throwIfAborted();
    operationSignal.throwIfAborted();
    const results = await removeStorageObjectsAndConfirm([{
      prefix: candidate.prefix,
      key: candidate.key,
      storageSlug: candidate.backend
    }], { signal: operationSignal }, scheduleSignal);
    assertStorageRemovalResults(results);
    const result = results[0]!;
    scheduleSignal.throwIfAborted();
    return {
      action: "remove_object",
      outcome: result.status === "removed" ? "removed" : "skipped",
      backend: candidate.backend,
      prefix: candidate.prefix,
      key: candidate.key,
      ...(result.status === "missing" ? { reason: "对象已不存在" } : {})
    };
  } catch (error) {
    if (scheduleSignal.aborted) throw scheduleSignal.reason ?? error;
    if (operationSignal.aborted) throw operationSignal.reason ?? error;
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
