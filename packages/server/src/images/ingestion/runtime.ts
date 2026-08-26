import { IngestionSessionWorker } from "./workers/ingestion-worker.ts";
import { IngestionOrphanCleanupWorker } from "./cleanup/orphan-worker.ts";
import { IngestionSessionService } from "./session-service.ts";
import { ingestionSessionRepository } from "./runtime-repository.ts";
import { IngestionTokenService } from "./sessions/token-service.ts";

export { ingestionSessionRepository } from "./runtime-repository.ts";
export const ingestionTokenService = new IngestionTokenService();
export const ingestionSessionService = new IngestionSessionService(
  ingestionSessionRepository,
  ingestionTokenService
);
export const ingestionSessionWorker = new IngestionSessionWorker(
  ingestionSessionRepository
);
const ingestionOrphanCleanupWorker = new IngestionOrphanCleanupWorker();

export function startIngestionSessionWorker() {
  ingestionSessionWorker.start();
  ingestionOrphanCleanupWorker.start();
}

export function stopIngestionSessionWorker() {
  ingestionSessionWorker.stop();
  ingestionOrphanCleanupWorker.stop();
}

export function drainIngestionSessionWorker() {
  return Promise.all([
    ingestionSessionWorker.drain(),
    ingestionOrphanCleanupWorker.drain()
  ]);
}
