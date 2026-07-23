import { ApiError } from "../../core/api-error.ts";
import {
  DynamicConcurrencyLimiter,
  DynamicWeightedLimiter
} from "../../core/concurrency.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { clearImportPhase, setImportPhase, withImportLease } from "./progress.ts";
import { withImportSessionLock } from "./session-lock.ts";
import type { ImportMode, PreparedImportResult } from "./types.ts";

const importCancellationError = () => new ApiError(
  409,
  "import_cancelled",
  "导入已取消"
);

const uploadPrepareLimiter = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().upload.global_concurrency,
  importCancellationError
);
const linkPrepareLimiter = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().link_image.global_concurrency,
  importCancellationError
);
const uploadMaterializeLimiter = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().upload.global_concurrency,
  importCancellationError
);
const linkMaterializeLimiter = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().link_image.global_concurrency,
  importCancellationError
);
const commitLimiter = new DynamicConcurrencyLimiter(
  () => getRuntimeConfig().import.global_commit_concurrency,
  importCancellationError
);
const commitByteLimiter = new DynamicWeightedLimiter(
  () => getRuntimeConfig().import.global_commit_byte_budget_mb * 1024 * 1024,
  importCancellationError
);

function queueSignal(internal: AbortSignal, request?: AbortSignal) {
  return request ? AbortSignal.any([internal, request]) : internal;
}

function executionSignal(queue: AbortSignal, lock: AbortSignal) {
  return queue === lock ? queue : AbortSignal.any([queue, lock]);
}

const activeMaterializations = new Map<string, {
  mode: ImportMode;
  controller: AbortController;
  promise: Promise<void>;
}>();

const activePreparations = new Map<string, {
  controller: AbortController;
  promise: Promise<PreparedImportResult>;
}>();

export async function runImportMaterialization(
  id: string,
  mode: ImportMode,
  work: (signal: AbortSignal) => Promise<void>,
  requestSignal?: AbortSignal
) {
  const active = activeMaterializations.get(id);
  if (active) {
    if (active.mode !== mode) {
      throw new ApiError(409, "invalid_import_state", "导入任务素材化模式不匹配");
    }
    return active.promise;
  }

  const controller = new AbortController();
  const limiter = mode === "upload"
    ? uploadMaterializeLimiter
    : linkMaterializeLimiter;
  const limiterSignal = queueSignal(controller.signal, requestSignal);
  const promise = Promise.resolve().then(() => withImportLease(id, () =>
    limiter.run(
      limiterSignal,
      () => withImportSessionLock(id, (lockSignal) => work(
        executionSignal(limiterSignal, lockSignal)
      )),
      {
        onQueued: () => setImportPhase(
          id,
          "materialize-waiting",
          "服务端全局素材化名额已满，等待空闲名额"
        ),
        onStarted: () => clearImportPhase(id)
      }
    )
  ));

  activeMaterializations.set(id, { mode, controller, promise });
  try {
    return await promise;
  } finally {
    if (activeMaterializations.get(id)?.promise === promise) {
      activeMaterializations.delete(id);
    }
    clearImportPhase(id);
  }
}

export async function runImportPreparation(
  id: string,
  mode: ImportMode,
  work: (signal: AbortSignal) => Promise<PreparedImportResult>,
  requestSignal?: AbortSignal
) {
  const active = activePreparations.get(id);
  if (active) return active.promise;

  const controller = new AbortController();
  const limiter = mode === "upload" ? uploadPrepareLimiter : linkPrepareLimiter;
  const limiterSignal = queueSignal(controller.signal, requestSignal);
  const promise = Promise.resolve().then(() => withImportLease(id, () =>
    limiter.run(limiterSignal, () => withImportSessionLock(
      id,
      (lockSignal) => work(executionSignal(limiterSignal, lockSignal))
    ), {
      onQueued: () => setImportPhase(id, "prepare-waiting", "服务端全局处理名额已满，等待空闲名额"),
      onStarted: () => clearImportPhase(id)
    })
  ));

  activePreparations.set(id, { controller, promise });
  try {
    return await promise;
  } finally {
    if (activePreparations.get(id)?.promise === promise) {
      activePreparations.delete(id);
    }
    clearImportPhase(id);
  }
}

export function runImportCommit<T>(work: () => Promise<T>, signal = new AbortController().signal) {
  return commitLimiter.run(signal, work);
}

export function runImportCommitWithinByteBudget<T>(
  bytes: number,
  work: () => Promise<T>,
  signal = new AbortController().signal
) {
  return commitByteLimiter.run(bytes, signal, work);
}

export function abortActiveImport(id: string) {
  const materialization = activeMaterializations.get(id);
  const preparation = activePreparations.get(id);
  materialization?.controller.abort();
  preparation?.controller.abort();
  const promises: Promise<unknown>[] = [];
  if (materialization) promises.push(materialization.promise);
  if (preparation) promises.push(preparation.promise);
  return promises.length ? Promise.allSettled(promises) : undefined;
}
