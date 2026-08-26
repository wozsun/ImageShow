import type {
  IngestionQueueActionInputDto,
  IngestionQueueActionResultDto
} from "@imageshow/shared/browser";
import type { AdminSession } from "../../../users/admin-session.ts";
import {
  replayIngestionQueueActionBatch,
  requireIngestionActionScope
} from "./action-scope.ts";
import type { IngestionIrreversibleCoordinator } from "../execution/irreversible-coordinator.ts";
import { executeIngestionQueueActionBatch } from "./action-handlers.ts";
import {
  resolveIngestionQueueActionCursor,
  signIngestionQueueActionContinuation
} from "./action-protocol.ts";
import type { IngestionSessionPair } from "../sessions/model.ts";
import type { IngestionSessionRepository } from "../repository.ts";
import type { IngestionTokenService } from "../sessions/token-service.ts";

function actionScopeChecker(input: Readonly<{
  actionScope: string;
  session: Pick<AdminSession, "id" | "username">;
  queue: "upload" | "import";
}>) {
  return () => requireIngestionActionScope({
    id: input.actionScope,
    sessionId: input.session.id,
    owner: input.session.username,
    queue: input.queue
  });
}

export async function runIngestionQueueAction(input: Readonly<{
  repository: IngestionSessionRepository;
  coordinator: IngestionIrreversibleCoordinator;
  tokens: IngestionTokenService;
  session: Pick<AdminSession, "id" | "username">;
  actionScope: string;
  request: IngestionQueueActionInputDto;
  abortActive: (pair: IngestionSessionPair) => void | Promise<unknown>;
}>): Promise<IngestionQueueActionResultDto> {
  const resolved = resolveIngestionQueueActionCursor(input);
  const assertScope = actionScopeChecker({
    actionScope: input.actionScope,
    session: input.session,
    queue: input.request.queue
  });
  return replayIngestionQueueActionBatch({
    id: input.actionScope,
    sessionId: input.session.id,
    owner: input.session.username,
    queue: input.request.queue,
    actionRequestId: input.request.action_request_id,
    requestFingerprint: [
      input.request.action,
      resolved.payloadHash,
      resolved.watermarkHash
    ].join("\0"),
    cursor: resolved.cursor,
    ...(input.request.continuation
      ? { continuation: input.request.continuation }
      : {}),
    execute: async () => {
      assertScope();
      const scanned = await input.repository.scanAction(
        input.session.username,
        input.request.queue,
        resolved.watermark.max_accepted_order,
        resolved.cursor
      );
      assertScope();
      const items = await executeIngestionQueueActionBatch({
        repository: input.repository,
        coordinator: input.coordinator,
        owner: input.session.username,
        request: input.request,
        sessions: scanned.items,
        capturedRevision: resolved.watermark.captured_queue_revision,
        abortActive: input.abortActive,
        assertScope
      });
      assertScope();
      const continuation = signIngestionQueueActionContinuation({
        tokens: input.tokens,
        nextCursor: scanned.nextCursor,
        request: input.request,
        resolved
      });
      return {
        processed: items.length,
        changed: items.filter((item) => item.status === "changed").length,
        failed: items.filter((item) => item.status === "failed").length,
        ...(continuation ? { continuation } : {}),
        items
      };
    }
  });
}
