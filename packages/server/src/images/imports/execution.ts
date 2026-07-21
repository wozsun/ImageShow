import { ApiError } from "../../core/api-error.ts";
import { DynamicConcurrencyLimiter } from "../../core/concurrency.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { withStorageLocationReadLock } from "../../storage/maintenance-lock.ts";
import { clearImportPhase, setImportPhase, withImportLease } from "./progress.ts";
import type { ImportMode, PreparedImportResult } from "./types.ts";

/** @internal Shared dynamic limiter, exported only for local concurrency verification. */
export class ImportConcurrencyLimiter {
  private readonly limiter: DynamicConcurrencyLimiter;

  constructor(limit: () => number) {
    this.limiter = new DynamicConcurrencyLimiter(
      limit,
      () => new ApiError(409, "import_cancelled", "导入已取消")
    );
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>, hooks: {
    onQueued?: () => void;
    onStarted?: () => void;
  } = {}): Promise<T> {
    return this.limiter.run(signal, work, hooks);
  }
}

const uploadPrepareLimiter = new ImportConcurrencyLimiter(
  () => getRuntimeConfig().upload.global_concurrency
);
const linkPrepareLimiter = new ImportConcurrencyLimiter(
  () => getRuntimeConfig().link_image.global_concurrency
);
const commitLimiter = new ImportConcurrencyLimiter(
  () => getRuntimeConfig().import.global_commit_concurrency
);

export function importCommitLockKey(id: string) {
  return `import.commit:${id}`;
}

const activeImports = new Map<string, {
  controller: AbortController;
  promise: Promise<PreparedImportResult>;
}>();

export async function runImportPreparation(
  id: string,
  mode: ImportMode,
  work: (signal: AbortSignal) => Promise<PreparedImportResult>
) {
  const active = activeImports.get(id);
  if (active) return active.promise;

  const controller = new AbortController();
  const limiter = mode === "upload" ? uploadPrepareLimiter : linkPrepareLimiter;
  const promise = Promise.resolve().then(() => withImportLease(id, () => withStorageLocationReadLock(
    () => limiter.run(controller.signal, () => work(controller.signal), {
      onQueued: () => setImportPhase(id, "prepare-waiting", "服务端全局处理名额已满，等待空闲名额"),
      onStarted: () => clearImportPhase(id)
    })
  )));

  activeImports.set(id, { controller, promise });
  try {
    return await promise;
  } finally {
    if (activeImports.get(id)?.promise === promise) activeImports.delete(id);
    clearImportPhase(id);
  }
}

export function runImportCommit<T>(work: () => Promise<T>, signal = new AbortController().signal) {
  return commitLimiter.run(signal, work);
}

export function abortActiveImport(id: string) {
  const active = activeImports.get(id);
  active?.controller.abort();
  return active?.promise;
}
