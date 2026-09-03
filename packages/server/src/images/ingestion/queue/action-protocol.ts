import {
  ingestionQueueActionTypes,
  type IngestionQueueActionInputDto,
  type IngestionQueueActionTypeDto
} from "@imageshow/shared/browser";
import { ApiError } from "../../../core/api-error.ts";
import type { AdminSession } from "../../../users/admin-session.ts";
import {
  ingestionActionWatermarkHash,
  verifyIngestionActionWatermark
} from "./action-scope.ts";
import { semanticIngestionSessionHash } from "../sessions/projection.ts";
import {
  ingestionActionContinuationPurpose,
  type IngestionTokenEnvelope,
  type IngestionTokenService
} from "../sessions/token-service.ts";

type IngestionQueueContinuationClaims = IngestionTokenEnvelope & Readonly<{
  action_scope: string;
  redis_connection_epoch: number;
  owner: string;
  queue: "upload" | "import";
  action_request_id: string;
  action: IngestionQueueActionTypeDto;
  payload_hash: string;
  watermark_hash: string;
  max_accepted_order: number;
  captured_queue_revision: number;
  next_cursor: number;
}>;

const actionTypes = new Set<IngestionQueueActionTypeDto>(ingestionQueueActionTypes);

function isContinuationClaims(
  value: IngestionTokenEnvelope
): value is IngestionQueueContinuationClaims {
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 14
    && typeof record.action_scope === "string"
    && /^[A-Za-z0-9_-]{32}$/u.test(record.action_scope)
    && Number.isSafeInteger(record.redis_connection_epoch)
    && Number(record.redis_connection_epoch) > 0
    && typeof record.owner === "string"
    && record.owner.length > 0
    && (record.queue === "upload" || record.queue === "import")
    && typeof record.action_request_id === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(record.action_request_id)
    && typeof record.action === "string"
    && actionTypes.has(record.action as IngestionQueueActionTypeDto)
    && typeof record.payload_hash === "string"
    && /^[a-f0-9]{64}$/u.test(record.payload_hash)
    && typeof record.watermark_hash === "string"
    && /^[a-f0-9]{64}$/u.test(record.watermark_hash)
    && Number.isSafeInteger(record.max_accepted_order)
    && Number(record.max_accepted_order) >= 0
    && Number.isSafeInteger(record.captured_queue_revision)
    && Number(record.captured_queue_revision) >= 0
    && Number.isSafeInteger(record.next_cursor)
    && Number(record.next_cursor) > 0;
}

function actionPayloadHash(input: IngestionQueueActionInputDto) {
  return semanticIngestionSessionHash({
    action: input.action,
    metadata: input.metadata ?? null,
    max_semantic_revision: input.max_semantic_revision ?? null
  });
}

export function resolveIngestionQueueActionCursor(input: Readonly<{
  request: IngestionQueueActionInputDto;
  actionScope: string;
  session: Pick<AdminSession, "id" | "username">;
  tokens: IngestionTokenService;
}>) {
  const watermark = verifyIngestionActionWatermark({
    token: input.request.action_watermark,
    tokens: input.tokens,
    actionScope: input.actionScope,
    sessionId: input.session.id,
    owner: input.session.username,
    queue: input.request.queue
  });
  const payloadHash = actionPayloadHash(input.request);
  const watermarkHash = ingestionActionWatermarkHash(
    input.request.action_watermark
  );
  if (!input.request.continuation) {
    return {
      watermark,
      payloadHash,
      watermarkHash,
      cursor: watermark.max_accepted_order === 0 ? 0 : 1
    };
  }
  const continuation = input.tokens.verify(
    ingestionActionContinuationPurpose,
    input.request.continuation,
    isContinuationClaims
  );
  if (
    continuation.action_scope !== watermark.action_scope
    || continuation.redis_connection_epoch
      !== watermark.redis_connection_epoch
    || continuation.owner !== watermark.owner
    || continuation.queue !== watermark.queue
    || continuation.action_request_id !== input.request.action_request_id
    || continuation.action !== input.request.action
    || continuation.payload_hash !== payloadHash
    || continuation.watermark_hash !== watermarkHash
    || continuation.max_accepted_order !== watermark.max_accepted_order
    || continuation.captured_queue_revision
      !== watermark.captured_queue_revision
    || continuation.next_cursor > watermark.max_accepted_order
  ) {
    throw new ApiError(
      409,
      "ingestion_action_continuation_invalid",
      "内容接入队列操作游标与当前请求不一致"
    );
  }
  return {
    watermark,
    payloadHash,
    watermarkHash,
    cursor: continuation.next_cursor
  };
}

export function signIngestionQueueActionContinuation(input: Readonly<{
  tokens: IngestionTokenService;
  nextCursor: number | null;
  request: IngestionQueueActionInputDto;
  resolved: ReturnType<typeof resolveIngestionQueueActionCursor>;
}>) {
  if (input.nextCursor === null) return undefined;
  try {
    return input.tokens.sign(
      ingestionActionContinuationPurpose,
      {
        action_scope: input.resolved.watermark.action_scope,
        redis_connection_epoch:
          input.resolved.watermark.redis_connection_epoch,
        owner: input.resolved.watermark.owner,
        queue: input.resolved.watermark.queue,
        action_request_id: input.request.action_request_id,
        action: input.request.action,
        payload_hash: input.resolved.payloadHash,
        watermark_hash: input.resolved.watermarkHash,
        max_accepted_order: input.resolved.watermark.max_accepted_order,
        captured_queue_revision:
          input.resolved.watermark.captured_queue_revision,
        next_cursor: input.nextCursor
      },
      input.resolved.watermark.expires_at
    );
  } catch (error) {
    if (error instanceof RangeError) {
      throw new ApiError(
        409,
        "ingestion_action_watermark_expired",
        "内容接入队列操作水位已过期，请刷新后重试"
      );
    }
    throw error;
  }
}
