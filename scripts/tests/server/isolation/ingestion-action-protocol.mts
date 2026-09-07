import assert from "node:assert/strict";
import type { IngestionTokenEnvelope } from "../../../../packages/server/src/images/ingestion/sessions/token-service.ts";

import { runIntegrationScenario } from "./integration-runtime.mts";

await runIntegrationScenario(async () => {
const { requireOperationalRedis } = await import("../../../../packages/server/src/core/runtime-availability.ts");
await requireOperationalRedis();
const ingestionTokenService = await import("../../../../packages/server/src/images/ingestion/sessions/token-service.ts");
const ingestionActionScope = await import("../../../../packages/server/src/images/ingestion/queue/action-scope.ts");
const ingestionActionProtocol = await import("../../../../packages/server/src/images/ingestion/queue/action-protocol.ts");
  let actionTokenNow = 1_787_982_000_000;
  const actionTokenExpiresAt = 1_787_983_800_000;
  const actionTokenTokens = new ingestionTokenService.IngestionTokenService({
    rootKey: new Uint8Array(32).fill(73),
    now: () => actionTokenNow
  });
  const actionTokenSession = {
    id: "action-token-session",
    username: "action-owner"
  };
  const actionTokenScope = ingestionActionScope.openIngestionActionScope(
    actionTokenSession,
    "upload",
    () => undefined
  );
  const actionTokenMetadata = {
    owner: actionTokenSession.username,
    queue: "upload" as const,
    revision: 654321,
    last_accepted_order: 123456,
    total: 123456,
    unfinished: 123455,
    waiting: 1234,
    running: 123,
    ready: 123,
    duplicate_pending: 12,
    committing_resolving: 2,
    resolving: 1,
    completed: 1,
    failed: 40
  };
  const actionTokenInternalScope = ingestionActionScope
    .requireIngestionActionScope({
      id: actionTokenScope.id,
      sessionId: actionTokenSession.id,
      owner: actionTokenSession.username,
      queue: "upload" as const
    });
  const actionTokenToken = ingestionActionScope
    .signIngestionActionWatermark(
      actionTokenInternalScope,
      actionTokenMetadata,
      actionTokenTokens,
      actionTokenNow
    );
  const verifyActionTokenToken = (token: string, overrides: Record<string, unknown> = {}) => (
    ingestionActionScope.verifyIngestionActionWatermark({
      token,
      tokens: actionTokenTokens,
      actionScope: actionTokenScope.id,
      sessionId: actionTokenSession.id,
      owner: actionTokenSession.username,
      queue: "upload" as const,
      ...overrides
    })
  );
  const actionTokenClaims = verifyActionTokenToken(actionTokenToken);
  assert.deepEqual(Object.keys(actionTokenClaims).sort(), [
    "action_scope",
    "captured_queue_revision",
    "expires_at",
    "issued_at",
    "max_accepted_order",
    "owner",
    "purpose",
    "queue",
    "redis_connection_epoch"
  ].sort());
  const {
    purpose: actionTokenPurpose,
    issued_at: actionTokenIssuedAt,
    expires_at: verifiedActionTokenExpiresAt,
    ...actionTokenClaimBody
  } = actionTokenClaims;
  const {
    captured_queue_revision: _removedCapturedRevision,
    ...missingWatermarkClaimBody
  } = actionTokenClaimBody;
  const missingClaimWatermark = actionTokenTokens.sign(
    actionTokenPurpose,
    missingWatermarkClaimBody,
    verifiedActionTokenExpiresAt,
    actionTokenIssuedAt
  );
  assert.throws(
    () => verifyActionTokenToken(missingClaimWatermark),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_ingestion_token"
  );
  const wrongEpochWatermark = actionTokenTokens.sign(
    actionTokenPurpose,
    {
      ...actionTokenClaimBody,
      redis_connection_epoch:
        actionTokenClaimBody.redis_connection_epoch + 1
    },
    verifiedActionTokenExpiresAt,
    actionTokenIssuedAt
  );
  assert.throws(
    () => verifyActionTokenToken(wrongEpochWatermark),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_action_scope_stale"
  );
  for (const overrides of [
    { actionScope: "C".repeat(32) },
    { sessionId: "other-watermark-session" },
    { owner: "other-watermark-owner" },
    { queue: "import" as const }
  ]) {
    assert.throws(
      () => verifyActionTokenToken(actionTokenToken, overrides),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_action_scope_stale"
    );
  }
  const firstActionRequest = {
    queue: "upload" as const,
    action_request_id: "0198d321-1111-7111-8111-111111111111",
    action: "clear_queue" as const,
    action_watermark: actionTokenToken
  };
  const actionTokenResolved = ingestionActionProtocol
    .resolveIngestionQueueActionCursor({
      request: firstActionRequest,
      actionScope: actionTokenScope.id,
      session: actionTokenSession,
      tokens: actionTokenTokens
    });
  const actionTokenContinuation = ingestionActionProtocol
    .signIngestionQueueActionContinuation({
      tokens: actionTokenTokens,
      nextCursor: 123400,
      request: firstActionRequest,
      resolved: actionTokenResolved
    });
  assert.ok(actionTokenContinuation);
  assert.equal(ingestionActionProtocol.resolveIngestionQueueActionCursor({
    request: {
      ...firstActionRequest,
      continuation: actionTokenContinuation
    },
    actionScope: actionTokenScope.id,
    session: actionTokenSession,
    tokens: actionTokenTokens
  }).cursor, 123400);
  const continuationClaims = actionTokenTokens.verify(
    "imageshow/ingestion/action/continuation",
    actionTokenContinuation,
    (value): value is IngestionTokenEnvelope & { captured_queue_revision: number } =>
      typeof value.captured_queue_revision === "number"
  );
  const {
    purpose: continuationPurpose,
    issued_at: continuationIssuedAt,
    expires_at: continuationExpiresAt,
    ...continuationClaimBody
  } = continuationClaims;
  const wrongCapturedRevisionContinuation = actionTokenTokens.sign(
    continuationPurpose,
    {
      ...continuationClaimBody,
      captured_queue_revision:
        continuationClaimBody.captured_queue_revision + 1
    },
    continuationExpiresAt,
    continuationIssuedAt
  );
  assert.throws(() => ingestionActionProtocol.resolveIngestionQueueActionCursor({
    request: {
      ...firstActionRequest,
      continuation: wrongCapturedRevisionContinuation
    },
    actionScope: actionTokenScope.id,
    session: actionTokenSession,
    tokens: actionTokenTokens
  }), (error: unknown) => error instanceof Error && "code" in error && error.code === "ingestion_action_continuation_invalid");
  actionTokenNow = actionTokenExpiresAt;
  assert.throws(
    () => verifyActionTokenToken(actionTokenToken),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "invalid_ingestion_token"
  );
  actionTokenScope.close();
});
