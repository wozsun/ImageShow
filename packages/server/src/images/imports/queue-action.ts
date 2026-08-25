import type {
  ImportQueueActionInputDto,
  ImportQueueActionResultDto
} from "@imageshow/shared/browser";
import type { AdminSession } from "../../users/admin-session.ts";
import {
  replayImportQueueActionBatch,
  requireImportActionScope
} from "./action-scope.ts";
import type { ImportIrreversibleCoordinator } from "./irreversible-coordinator.ts";
import { executeImportQueueActionBatch } from "./queue-action-handlers.ts";
import {
  resolveImportQueueActionCursor,
  signImportQueueActionContinuation
} from "./queue-action-protocol.ts";
import type { ImportSessionPair } from "./session-model.ts";
import type { ImportSessionRepository } from "./session-repository.ts";
import type { ImportTokenService } from "./token-service.ts";

function actionScopeChecker(input: Readonly<{
  actionScope: string;
  session: Pick<AdminSession, "id" | "username">;
  queue: "upload" | "import";
}>) {
  return () => requireImportActionScope({
    id: input.actionScope,
    sessionId: input.session.id,
    owner: input.session.username,
    queue: input.queue
  });
}

export async function runImportQueueAction(input: Readonly<{
  repository: ImportSessionRepository;
  coordinator: ImportIrreversibleCoordinator;
  tokens: ImportTokenService;
  session: Pick<AdminSession, "id" | "username">;
  actionScope: string;
  request: ImportQueueActionInputDto;
  abortActive: (pair: ImportSessionPair) => void | Promise<unknown>;
}>): Promise<ImportQueueActionResultDto> {
  const resolved = resolveImportQueueActionCursor(input);
  const assertScope = actionScopeChecker({
    actionScope: input.actionScope,
    session: input.session,
    queue: input.request.queue
  });
  return replayImportQueueActionBatch({
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
      const items = await executeImportQueueActionBatch({
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
      const continuation = signImportQueueActionContinuation({
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
