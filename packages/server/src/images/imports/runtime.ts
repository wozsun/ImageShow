import { ImportSessionWorker } from "./import-worker.ts";
import { ImportOrphanCleanupWorker } from "./orphan-cleanup-worker.ts";
import { ImportSessionService } from "./session-service.ts";
import { importSessionRepository } from "./runtime-repository.ts";
import { ImportTokenService } from "./token-service.ts";

export { importSessionRepository } from "./runtime-repository.ts";
export const importTokenService = new ImportTokenService();
export const importSessionService = new ImportSessionService(
  importSessionRepository,
  importTokenService
);
export const importSessionWorker = new ImportSessionWorker(
  importSessionRepository
);
const importOrphanCleanupWorker = new ImportOrphanCleanupWorker();

export function startImportSessionWorker() {
  importSessionWorker.start();
  importOrphanCleanupWorker.start();
}

export function stopImportSessionWorker() {
  importSessionWorker.stop();
  importOrphanCleanupWorker.stop();
}

export function drainImportSessionWorker() {
  return Promise.all([
    importSessionWorker.drain(),
    importOrphanCleanupWorker.drain()
  ]);
}
