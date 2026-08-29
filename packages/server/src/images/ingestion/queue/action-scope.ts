import { createHash, randomBytes } from "node:crypto";
import type { IngestionQueueActionResultDto } from "@imageshow/shared/browser";
import { ApiError } from "../../../core/api-error.ts";
import { logger } from "../../../core/logger.ts";
import {
  getRedisOperationalState,
  onRedisOperationalStateChange
} from "../../../core/runtime-availability.ts";
import type { AdminSession } from "../../../users/admin-session.ts";
import type {
  IngestionQueueMetadata,
  IngestionQueueType
} from "../sessions/model.ts";
import {
  ingestionActionWatermarkPurpose,
  type IngestionTokenEnvelope,
  type IngestionTokenService
} from "../sessions/token-service.ts";

const actionWatermarkLifetimeMs = 30 * 60 * 1_000;
const actionRequestBindingLimit = 32;

type IngestionActionScope = Readonly<{
  id: string;
  sessionId: string;
  owner: string;
  queue: IngestionQueueType;
  connectionEpoch: number;
  invalidate: () => void;
  replay: {
    current?: IngestionActionBatchReplay;
    bindings: Map<string, string>;
  };
}>;

type IngestionActionBatchReplay = {
  actionRequestId: string;
  requestFingerprint: string;
  cursor: number;
  continuation?: string;
  settled: boolean;
  result: Promise<IngestionQueueActionResultDto>;
};

const scopes = new Map<string, IngestionActionScope>();

type IngestionActionWatermarkClaims = IngestionTokenEnvelope & Readonly<{
  action_scope: string;
  redis_connection_epoch: number;
  owner: string;
  queue: IngestionQueueType;
  max_accepted_order: number;
  captured_queue_revision: number;
}>;

function staleActionScope() {
  return new ApiError(
    409,
    "ingestion_action_scope_stale",
    "内容接入队列连接已变化，请重新连接并刷新队列"
  );
}

function invalidateScope(scope: IngestionActionScope, notify: boolean) {
  if (scopes.get(scope.id) !== scope) return;
  scopes.delete(scope.id);
  if (notify) {
    try {
      scope.invalidate();
    } catch (error) {
      logger.error("ingestion_action_scope_invalidation_failed", error);
    }
  }
}

onRedisOperationalStateChange((state) => {
  for (const scope of [...scopes.values()]) {
    if (!state.available || state.connectionEpoch !== scope.connectionEpoch) {
      invalidateScope(scope, true);
    }
  }
});

export function openIngestionActionScope(
  session: Pick<AdminSession, "id" | "username">,
  queue: IngestionQueueType,
  invalidate: () => void
) {
  const state = getRedisOperationalState();
  if (!state.available) throw staleActionScope();
  let id = "";
  do id = randomBytes(24).toString("base64url");
  while (scopes.has(id));
  const scope: IngestionActionScope = {
    id,
    sessionId: session.id,
    owner: session.username,
    queue,
    connectionEpoch: state.connectionEpoch,
    invalidate,
    replay: { bindings: new Map() }
  };
  scopes.set(id, scope);
  return {
    id,
    connectionEpoch: scope.connectionEpoch,
    close: () => invalidateScope(scope, false)
  };
}

function actionReplayError(code: string, message: string) {
  return new ApiError(409, code, message);
}

/**
 * Keep exactly the latest request batch for the action attached to this
 * process-local scope. Receiving the signed continuation proves the caller
 * observed the preceding batch, so replacing that batch remains bounded while
 * an HTTP response loss can still replay destructive results verbatim.
 */
export async function replayIngestionQueueActionBatch(input: Readonly<{
  id: string;
  sessionId: string;
  owner: string;
  queue: IngestionQueueType;
  actionRequestId: string;
  requestFingerprint: string;
  cursor: number;
  continuation?: string;
  execute: () => Promise<IngestionQueueActionResultDto>;
}>) {
  const scopeInput = {
    id: input.id,
    sessionId: input.sessionId,
    owner: input.owner,
    queue: input.queue
  };
  const start = (scope: IngestionActionScope) => {
    let replay!: IngestionActionBatchReplay;
    const result = Promise.resolve()
      .then(() => {
        requireIngestionActionScope(scopeInput);
        return input.execute();
      })
      .then(
        (value) => {
          replay.settled = true;
          return value;
        },
        (error: unknown) => {
          if (scope.replay.current === replay) {
            delete scope.replay.current;
          }
          throw error;
        }
      );
    replay = {
      actionRequestId: input.actionRequestId,
      requestFingerprint: input.requestFingerprint,
      cursor: input.cursor,
      ...(input.continuation ? { continuation: input.continuation } : {}),
      settled: false,
      result
    };
    scope.replay.current = replay;
    return result;
  };

  while (true) {
    const scope = requireIngestionActionScope(scopeInput);
    const boundFingerprint = scope.replay.bindings.get(input.actionRequestId);
    if (
      boundFingerprint
      && boundFingerprint !== input.requestFingerprint
    ) {
      throw actionReplayError(
        "ingestion_action_request_conflict",
        "同一全局操作 ID 已绑定不同操作、水位或内容"
      );
    }
    if (!boundFingerprint) {
      if (scope.replay.bindings.size >= actionRequestBindingLimit) {
        const oldest = scope.replay.bindings.keys().next().value;
        if (oldest) scope.replay.bindings.delete(oldest);
      }
      scope.replay.bindings.set(
        input.actionRequestId,
        input.requestFingerprint
      );
    }
    const current = scope.replay.current;
    if (!current) return start(scope);
    if (current.actionRequestId !== input.actionRequestId) {
      if (!current.settled) {
        throw actionReplayError(
          "ingestion_action_in_progress",
          "当前队列已有全局操作正在执行"
        );
      }
      return start(scope);
    }
    if (current.requestFingerprint !== input.requestFingerprint) {
      throw actionReplayError(
        "ingestion_action_request_conflict",
        "同一全局操作 ID 已绑定不同操作、水位或内容"
      );
    }
    if (
      current.cursor === input.cursor
      && current.continuation === input.continuation
    ) {
      return current.result;
    }

    const previous = await current.result;
    requireIngestionActionScope(scopeInput);
    if (scope.replay.current !== current) continue;
    if (
      !input.continuation
      || input.continuation !== previous.continuation
    ) {
      throw actionReplayError(
        "ingestion_action_continuation_invalid",
        "内容接入队列操作游标已被后续批次取代"
      );
    }
    return start(scope);
  }
}

export function requireIngestionActionScope(input: Readonly<{
  id: string;
  sessionId: string;
  owner: string;
  queue: IngestionQueueType;
}>) {
  const scope = scopes.get(input.id);
  const state = getRedisOperationalState();
  if (
    !scope
    || scope.sessionId !== input.sessionId
    || scope.owner !== input.owner
    || scope.queue !== input.queue
    || !state.available
    || state.connectionEpoch !== scope.connectionEpoch
  ) throw staleActionScope();
  return scope;
}

export function signIngestionActionWatermark(
  scope: IngestionActionScope,
  metadata: IngestionQueueMetadata,
  tokens: IngestionTokenService,
  now = Date.now()
) {
  requireIngestionActionScope({
    id: scope.id,
    sessionId: scope.sessionId,
    owner: scope.owner,
    queue: scope.queue
  });
  if (metadata.owner !== scope.owner || metadata.queue !== scope.queue) {
    throw staleActionScope();
  }
  return tokens.sign(
    ingestionActionWatermarkPurpose,
    {
      action_scope: scope.id,
      redis_connection_epoch: scope.connectionEpoch,
      owner: scope.owner,
      queue: scope.queue,
      max_accepted_order: metadata.last_accepted_order,
      captured_queue_revision: metadata.revision
    },
    now + actionWatermarkLifetimeMs,
    now
  );
}

function isActionWatermarkClaims(
  value: IngestionTokenEnvelope
): value is IngestionActionWatermarkClaims {
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 9
    && typeof record.action_scope === "string"
    && /^[A-Za-z0-9_-]{32}$/u.test(record.action_scope)
    && Number.isSafeInteger(record.redis_connection_epoch)
    && Number(record.redis_connection_epoch) > 0
    && typeof record.owner === "string"
    && record.owner.length > 0
    && (record.queue === "upload" || record.queue === "import")
    && Number.isSafeInteger(record.max_accepted_order)
    && Number(record.max_accepted_order) >= 0
    && Number.isSafeInteger(record.captured_queue_revision)
    && Number(record.captured_queue_revision) >= 0;
}

export function verifyIngestionActionWatermark(input: Readonly<{
  token: string;
  tokens: IngestionTokenService;
  actionScope: string;
  sessionId: string;
  owner: string;
  queue: IngestionQueueType;
}>) {
  const claims = input.tokens.verify(
    ingestionActionWatermarkPurpose,
    input.token,
    isActionWatermarkClaims
  );
  if (
    claims.action_scope !== input.actionScope
    || claims.owner !== input.owner
    || claims.queue !== input.queue
  ) throw staleActionScope();
  const scope = requireIngestionActionScope({
    id: claims.action_scope,
    sessionId: input.sessionId,
    owner: input.owner,
    queue: input.queue
  });
  if (claims.redis_connection_epoch !== scope.connectionEpoch) {
    throw staleActionScope();
  }
  return claims;
}

export function ingestionActionWatermarkHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
