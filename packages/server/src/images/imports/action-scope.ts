import { createHash, randomBytes } from "node:crypto";
import type {
  ImportQueueActionResultDto,
  ImportQueueSummaryDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../core/api-error.ts";
import { logger } from "../../core/logger.ts";
import {
  getRedisOperationalState,
  onRedisOperationalStateChange
} from "../../core/runtime-availability.ts";
import type { AdminSession } from "../../users/admin-session.ts";
import type {
  ImportQueueMetadata,
  ImportQueueType
} from "./session-model.ts";
import { presentImportQueueSummary } from "./session-projection.ts";
import type { ImportTokenService } from "./token-service.ts";
import type { ImportTokenEnvelope } from "./token-service.ts";

const actionWatermarkLifetimeMs = 30 * 60 * 1_000;
const actionRequestBindingLimit = 32;

type ImportActionScope = Readonly<{
  id: string;
  sessionId: string;
  owner: string;
  queue: ImportQueueType;
  connectionEpoch: number;
  invalidate: () => void;
  replay: {
    current?: ImportActionBatchReplay;
    bindings: Map<string, string>;
  };
}>;

type ImportActionBatchReplay = {
  actionRequestId: string;
  requestFingerprint: string;
  cursor: number;
  continuation?: string;
  settled: boolean;
  result: Promise<ImportQueueActionResultDto>;
};

const scopes = new Map<string, ImportActionScope>();

const summaryFields = [
  "total",
  "unfinished",
  "waiting",
  "running",
  "ready",
  "duplicate_pending",
  "committing",
  "resolving",
  "completed",
  "failed"
] as const;

type ImportActionWatermarkClaims = ImportTokenEnvelope & Readonly<{
  action_scope: string;
  redis_connection_epoch: number;
  owner: string;
  queue: ImportQueueType;
  max_accepted_order: number;
  captured_queue_revision: number;
  summary: ImportQueueSummaryDto;
}>;

function staleActionScope() {
  return new ApiError(
    409,
    "import_action_scope_stale",
    "导入队列连接已变化，请重新连接并刷新队列"
  );
}

function invalidateScope(scope: ImportActionScope, notify: boolean) {
  if (scopes.get(scope.id) !== scope) return;
  scopes.delete(scope.id);
  if (notify) {
    try {
      scope.invalidate();
    } catch (error) {
      logger.error("import action scope invalidation failed", error);
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

export function openImportActionScope(
  session: Pick<AdminSession, "id" | "username">,
  queue: ImportQueueType,
  invalidate: () => void
) {
  const state = getRedisOperationalState();
  if (!state.available) throw staleActionScope();
  let id = "";
  do id = randomBytes(24).toString("base64url");
  while (scopes.has(id));
  const scope: ImportActionScope = {
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
export async function replayImportQueueActionBatch(input: Readonly<{
  id: string;
  sessionId: string;
  owner: string;
  queue: ImportQueueType;
  actionRequestId: string;
  requestFingerprint: string;
  cursor: number;
  continuation?: string;
  execute: () => Promise<ImportQueueActionResultDto>;
}>) {
  const scopeInput = {
    id: input.id,
    sessionId: input.sessionId,
    owner: input.owner,
    queue: input.queue
  };
  const start = (scope: ImportActionScope) => {
    let replay!: ImportActionBatchReplay;
    const result = Promise.resolve()
      .then(() => {
        requireImportActionScope(scopeInput);
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
    const scope = requireImportActionScope(scopeInput);
    const boundFingerprint = scope.replay.bindings.get(input.actionRequestId);
    if (
      boundFingerprint
      && boundFingerprint !== input.requestFingerprint
    ) {
      throw actionReplayError(
        "import_action_request_conflict",
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
          "import_action_in_progress",
          "当前队列已有全局操作正在执行"
        );
      }
      return start(scope);
    }
    if (current.requestFingerprint !== input.requestFingerprint) {
      throw actionReplayError(
        "import_action_request_conflict",
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
    requireImportActionScope(scopeInput);
    if (scope.replay.current !== current) continue;
    if (
      !input.continuation
      || input.continuation !== previous.continuation
    ) {
      throw actionReplayError(
        "import_action_continuation_invalid",
        "导入队列操作游标已被后续批次取代"
      );
    }
    return start(scope);
  }
}

export function requireImportActionScope(input: Readonly<{
  id: string;
  sessionId: string;
  owner: string;
  queue: ImportQueueType;
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

export function signImportActionWatermark(
  scope: ImportActionScope,
  metadata: ImportQueueMetadata,
  tokens: ImportTokenService,
  now = Date.now()
) {
  requireImportActionScope({
    id: scope.id,
    sessionId: scope.sessionId,
    owner: scope.owner,
    queue: scope.queue
  });
  if (metadata.owner !== scope.owner || metadata.queue !== scope.queue) {
    throw staleActionScope();
  }
  return tokens.sign(
    "imageshow/queue-watermark/v1",
    {
      action_scope: scope.id,
      redis_connection_epoch: scope.connectionEpoch,
      owner: scope.owner,
      queue: scope.queue,
      max_accepted_order: metadata.last_accepted_order,
      captured_queue_revision: metadata.revision,
      summary: presentImportQueueSummary(metadata)
    },
    now + actionWatermarkLifetimeMs,
    now
  );
}

function isQueueSummary(value: unknown): value is ImportQueueSummaryDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === summaryFields.length
    && summaryFields.every((field) => (
      Number.isSafeInteger(record[field]) && Number(record[field]) >= 0
    ));
}

function isActionWatermarkClaims(
  value: ImportTokenEnvelope
): value is ImportActionWatermarkClaims {
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 10
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
    && Number(record.captured_queue_revision) >= 0
    && isQueueSummary(record.summary);
}

export function verifyImportActionWatermark(input: Readonly<{
  token: string;
  tokens: ImportTokenService;
  actionScope: string;
  sessionId: string;
  owner: string;
  queue: ImportQueueType;
}>) {
  const claims = input.tokens.verify(
    "imageshow/queue-watermark/v1",
    input.token,
    isActionWatermarkClaims
  );
  if (
    claims.action_scope !== input.actionScope
    || claims.owner !== input.owner
    || claims.queue !== input.queue
  ) throw staleActionScope();
  const scope = requireImportActionScope({
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

export function importActionWatermarkHash(token: string) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
