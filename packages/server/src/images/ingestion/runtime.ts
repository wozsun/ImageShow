import type {
  IngestionCancelItemInputDto,
  IngestionQueueActionInputDto
} from "@imageshow/shared/browser";
import type { AdminSession } from "../../users/admin-session.ts";
import { cancelIngestionSessions } from "./cancel/coordinator.ts";
import { IngestionIrreversibleCoordinator } from "./execution/irreversible-coordinator.ts";
import { runIngestionQueueAction } from "./queue/action.ts";
import { IngestionSessionWorker } from "./workers/ingestion-worker.ts";
import { IngestionOrphanCleanupWorker } from "./cleanup/orphan-worker.ts";
import { IngestionSessionService } from "./session-service.ts";
import { ingestionSessionRepository } from "./runtime-repository.ts";
import type { IngestionSessionPair } from "./sessions/model.ts";
import { IngestionTokenService } from "./sessions/token-service.ts";

export { ingestionSessionRepository } from "./runtime-repository.ts";
export const ingestionTokenService = new IngestionTokenService();
export const ingestionSessionService = new IngestionSessionService(
  ingestionSessionRepository,
  ingestionTokenService
);
const ingestionCoordinator = new IngestionIrreversibleCoordinator();
const ingestionSessionWorker = new IngestionSessionWorker(
  ingestionSessionRepository,
  ingestionCoordinator
);
const ingestionOrphanCleanupWorker = new IngestionOrphanCleanupWorker();

function abortActiveIngestion(pair: IngestionSessionPair) {
  return ingestionSessionWorker.abortActive(pair);
}

export const ingestionExecutionControl = {
  runQueueAction(input: Readonly<{
    session: Pick<AdminSession, "id" | "username">;
    actionScope: string;
    request: IngestionQueueActionInputDto;
  }>) {
    return runIngestionQueueAction({
      repository: ingestionSessionRepository,
      coordinator: ingestionCoordinator,
      tokens: ingestionTokenService,
      session: input.session,
      actionScope: input.actionScope,
      request: input.request,
      abortActive: abortActiveIngestion
    });
  },

  cancelSessions(
    owner: string,
    items: readonly IngestionCancelItemInputDto[]
  ) {
    return cancelIngestionSessions(
      ingestionSessionRepository,
      ingestionCoordinator,
      owner,
      items,
      abortActiveIngestion
    );
  }
};

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
