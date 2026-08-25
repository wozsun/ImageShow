import { appConfig } from "@imageshow/shared";
import { errorMessage } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import { cleanupImportOrphans } from "./orphan-cleanup.ts";
import { importOrphanCleanupIntervalMs } from "./orphan-retention.ts";
import { closeImportRawCleanupCursor } from "./raw-files.ts";

export class ImportOrphanCleanupWorker {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #cursorClose: Promise<void> | null = null;

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, importOrphanCleanupIntervalMs());
    this.#timer.unref();
    void this.tick();
  }

  tick() {
    if (this.#running) return this.#running;
    const controller = new AbortController();
    this.#controller = controller;
    this.#running = cleanupImportOrphans(Date.now(), controller.signal)
      .then((report) => {
        if (
          report.raw_removed
          || report.staging_removed
          || report.staging_failed
          || report.incomplete_namespaces
          || report.incomplete_raw_scans
        ) {
          logger.info("import orphan cleanup completed", report);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          logger.warn("import orphan cleanup failed", {
            error: errorMessage(error)
          });
        }
      })
      .finally(() => {
        if (this.#controller === controller) this.#controller = null;
        this.#running = null;
      });
    return this.#running;
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#controller?.abort(new Error("Import orphan cleanup worker stopping"));
    const running = this.#running ?? Promise.resolve();
    this.#cursorClose = running.then(() => closeImportRawCleanupCursor());
  }

  async drain(timeoutMs = appConfig.backgroundJob.drainTimeoutMs) {
    const pending = [this.#running, this.#cursorClose].filter(
      (value): value is Promise<void> => Boolean(value)
    );
    if (!pending.length) return true;
    if (timeoutMs <= 0) return false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = await Promise.race([
      Promise.all(pending).then(() => true),
      deadline
    ]);
    if (timer) clearTimeout(timer);
    return drained;
  }
}
