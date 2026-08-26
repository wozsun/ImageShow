import { ApiError } from "../../../core/api-error.ts";
import {
  parseIngestionQueueMetadata,
  parseStoredIngestionSession
} from "./codec.ts";
import {
  throwIngestionCommandConflict
} from "./command-runner.ts";
import type {
  CompletedIngestionReceipt,
  DiscardedIngestionReceipt,
  IngestionQueueMetadata,
  IngestionQueueType,
  StoredIngestionSession
} from "./model.ts";
import { ingestionSessionSemanticHash } from "./projection.ts";

export function redisJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function normalizedSemanticSession(
  next: StoredIngestionSession
): StoredIngestionSession {
  const value = redisJsonValue(next);
  if (value.status === "completed") {
    const receipt: CompletedIngestionReceipt = {
      owner: value.owner,
      queue: value.queue,
      session_id: value.session_id,
      image_id: value.image_id,
      request_hash: value.request_hash,
      commit_request_id: value.commit_request_id,
      commit_intent_hash: value.commit_intent_hash,
      status: "completed",
      version: value.version,
      last_semantic_revision: value.last_semantic_revision,
      accepted_at: value.accepted_at,
      accepted_order: value.accepted_order,
      completed_at: value.completed_at,
      ...(value.display ? { display: value.display } : {}),
      discard_at: value.discard_at
    };
    return receipt;
  }
  if (value.status === "discarded") {
    const receipt: DiscardedIngestionReceipt = {
      owner: value.owner,
      queue: value.queue,
      session_id: value.session_id,
      image_id: value.image_id,
      image_time: value.image_time,
      request_hash: value.request_hash,
      status: "discarded",
      version: value.version,
      last_semantic_revision: value.last_semantic_revision,
      accepted_at: value.accepted_at,
      accepted_order: value.accepted_order,
      discarded_at: value.discarded_at,
      discard_at: value.discard_at
    };
    return receipt;
  }
  return {
    ...value,
    semantic_hash: ingestionSessionSemanticHash(value)
  };
}

export function redisReplyInteger(value: unknown, context: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Redis ingestion command returned invalid ${context}`);
  }
  return parsed;
}

export function redisReplyString(value: unknown, context: string) {
  if (typeof value !== "string") {
    throw new Error(`Redis ingestion command returned invalid ${context}`);
  }
  return value;
}

export function redisReplyArray(value: unknown, context: string) {
  if (!Array.isArray(value)) {
    throw new Error(`Redis ingestion command returned invalid ${context}`);
  }
  return value;
}

export function parseCanonicalReply(
  raw: unknown,
  operation: "create" | "mutate"
) {
  const reply = redisReplyArray(raw, "canonical result");
  const code = redisReplyInteger(reply[0], "canonical status");
  if (code < 0) {
    if (operation === "create") throwIngestionCommandConflict(code);
    if (code === -1) {
      throw new ApiError(410, "ingestion_session_missing", "内容接入任务已过期或被丢弃");
    }
    if (code === -2) {
      throw new ApiError(409, "ingestion_incarnation_conflict", "内容接入任务身份已被替换");
    }
    if (code === -3) {
      throw new ApiError(409, "ingestion_version_conflict", "内容接入任务版本已变化");
    }
    if (code === -4) {
      throw new ApiError(409, "ingestion_execution_fenced", "内容接入执行权已转移");
    }
    if (code === -5) {
      throw new ApiError(410, "ingestion_session_expired", "内容接入任务已经到期");
    }
    if (code === -6) {
      throw new ApiError(
        409,
        "ingestion_session_not_expired",
        "内容接入任务的有效期已经刷新"
      );
    }
    throwIngestionCommandConflict(code);
  }
  if (![0, 1, 2, 3, 4, 5].includes(code)) {
    throwIngestionCommandConflict(code);
  }
  const serialized = redisReplyString(reply[1] ?? "", "canonical snapshot");
  const metadataJson = redisReplyString(reply[2], "queue metadata");
  let metadataValue: unknown;
  try {
    metadataValue = JSON.parse(metadataJson);
  } catch {
    throw new Error("Redis ingestion command returned invalid queue metadata JSON");
  }
  return {
    code,
    session: serialized ? parseStoredIngestionSession(serialized) : undefined,
    metadata: parseIngestionQueueMetadata(metadataValue)
  };
}

export function parseIntentReply(raw: unknown) {
  const reply = redisReplyArray(raw, "upload-intent result");
  const code = redisReplyInteger(reply[0], "upload-intent status");
  if (code < 0) throwIngestionCommandConflict(code);
  return {
    code,
    serialized: redisReplyString(reply[1], "upload-intent snapshot")
  };
}

export function defaultQueueMetadata(
  owner: string,
  queue: IngestionQueueType
): IngestionQueueMetadata {
  return {
    owner,
    queue,
    revision: 0,
    last_accepted_order: 0,
    total: 0,
    unfinished: 0,
    waiting: 0,
    running: 0,
    ready: 0,
    duplicate_pending: 0,
    committing_resolving: 0,
    resolving: 0,
    completed: 0,
    failed: 0
  };
}

export function parseMetadataJson(value: unknown, context: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(redisReplyString(value, context));
  } catch {
    throw new Error(`Redis ingestion command returned invalid ${context} JSON`);
  }
  return parseIngestionQueueMetadata(parsed);
}
