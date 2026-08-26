import { errorMessage } from "../../../core/api-error.ts";
import type {
  DiscardedIngestionReceipt,
  IngestionSessionError,
  IngestionSessionSnapshot
} from "./model.ts";
import { ingestionSessionSemanticHash } from "./projection.ts";

export function semanticIngestionSession(
  current: IngestionSessionSnapshot,
  changes: Partial<IngestionSessionSnapshot>
): IngestionSessionSnapshot {
  const withoutHash = {
    ...current,
    ...changes,
    semantic_hash: ""
  };
  return {
    ...withoutHash,
    semantic_hash: ingestionSessionSemanticHash(withoutHash)
  };
}

export function failedIngestionSession(
  current: IngestionSessionSnapshot,
  error: unknown,
  fallbackCode = "ingestion_stage_failed"
) {
  const sessionError: IngestionSessionError = {
    code: typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "string"
      ? error.code
      : fallbackCode,
    message: errorMessage(error)
  };
  return semanticIngestionSession(current, {
    status: "failed",
    phase: "failed",
    message: sessionError.message,
    progress: null,
    execution_token: "",
    error: sessionError
  });
}

export function discardedIngestionReceipt(
  current: IngestionSessionSnapshot,
  discardedAt: number
): DiscardedIngestionReceipt {
  return {
    owner: current.owner,
    queue: current.queue,
    session_id: current.session_id,
    image_id: current.image_id,
    image_time: current.image_time,
    request_hash: current.request_hash,
    status: "discarded",
    version: current.version,
    last_semantic_revision: current.last_semantic_revision,
    accepted_at: current.accepted_at,
    accepted_order: current.accepted_order,
    discarded_at: discardedAt,
    discard_at: current.discard_at
  };
}
