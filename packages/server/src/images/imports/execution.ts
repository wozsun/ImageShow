import { ApiError } from "../../core/http.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { withStorageMutationLock } from "../../storage/maintenance-lock.ts";
import { clearImportPhase, setImportPhase, withImportLease } from "./progress.ts";
import type { ImportMode, PreparedImportResult } from "./types.ts";

/** @internal Shared dynamic limiter, exported only for local concurrency verification. */
export class ImportConcurrencyLimiter {
  private active = 0;
  private queue: Array<{ run: () => void; signal: AbortSignal; abort: () => void }> = [];
  private readonly limit: () => number;

  constructor(limit: () => number) {
    this.limit = limit;
  }

  async run<T>(signal: AbortSignal, work: () => Promise<T>, hooks: {
    onQueued?: () => void;
    onStarted?: () => void;
  } = {}): Promise<T> {
    await this.acquire(signal, hooks.onQueued);
    hooks.onStarted?.();
    try {
      return await work();
    } finally {
      this.active = Math.max(0, this.active - 1);
      this.drain();
    }
  }

  private acquire(signal: AbortSignal, onQueued?: () => void) {
    if (signal.aborted) throw new ApiError(409, "import_cancelled", "导入已取消");
    if (this.active < this.currentLimit()) {
      this.active += 1;
      return Promise.resolve();
    }

    onQueued?.();
    return new Promise<void>((resolve, reject) => {
      let entry: { run: () => void; signal: AbortSignal; abort: () => void };
      entry = {
        signal,
        abort: () => {
          this.queue = this.queue.filter((item) => item !== entry);
          reject(new ApiError(409, "import_cancelled", "导入已取消"));
        },
        run: () => {
          signal.removeEventListener("abort", entry.abort);
          this.active += 1;
          resolve();
        }
      };
      signal.addEventListener("abort", entry.abort, { once: true });
      this.queue.push(entry);
    });
  }

  private currentLimit() {
    return Math.max(1, Math.floor(this.limit()));
  }

  private drain() {
    while (this.active < this.currentLimit()) {
      const next = this.queue.shift();
      if (!next) return;
      if (next.signal.aborted) {
        next.abort();
        continue;
      }
      next.run();
    }
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
  const promise = Promise.resolve().then(() => withImportLease(id, () => withStorageMutationLock(
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
