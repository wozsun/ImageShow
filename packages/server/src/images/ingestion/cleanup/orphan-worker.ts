import { appConfig } from "@imageshow/shared";
import { errorMessage } from "../../../core/api-error.ts";
import { logger } from "../../../core/logger.ts";
import { cleanupIngestionOrphans } from "./orphans.ts";
import { ingestionOrphanCleanupIntervalMs } from "./retention.ts";
import { closeIngestionRawCleanupCursor } from "../raw/orphan-scanner.ts";

export class IngestionOrphanCleanupWorker {
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<void> | null = null;
  #controller: AbortController | null = null;
  #cursorClose: Promise<void> | null = null;

  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      void this.tick();
    }, ingestionOrphanCleanupIntervalMs());
    this.#timer.unref();
    void this.tick();
  }

  tick() {
    if (this.#running) return this.#running;
    const controller = new AbortController();
    this.#controller = controller;
    this.#running = cleanupIngestionOrphans(Date.now(), controller.signal)
      .then((report) => {
        if (
          report.raw_removed
          || report.staging_removed
          || report.staging_failed
          || report.incomplete_namespaces
          || report.incomplete_raw_scans
        ) {
          logger.info("ingestion_orphan_cleanup_completed", report);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          logger.warn("ingestion_orphan_cleanup_failed", {
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
    this.#controller?.abort(new Error("Ingestion orphan cleanup worker stopping"));
    const running = this.#running ?? Promise.resolve();
    this.#cursorClose = running.then(() => closeIngestionRawCleanupCursor());
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
