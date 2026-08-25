import { errorMessage } from "../../core/api-error.ts";
import type {
  DiscardedImportReceipt,
  ImportSessionError,
  ImportSessionSnapshot
} from "./session-model.ts";
import { importSessionSemanticHash } from "./session-projection.ts";

export function semanticImportSession(
  current: ImportSessionSnapshot,
  changes: Partial<ImportSessionSnapshot>
): ImportSessionSnapshot {
  const withoutHash = {
    ...current,
    ...changes,
    semantic_hash: ""
  };
  return {
    ...withoutHash,
    semantic_hash: importSessionSemanticHash(withoutHash)
  };
}

export function failedImportSession(
  current: ImportSessionSnapshot,
  error: unknown,
  fallbackCode = "import_stage_failed"
) {
  const sessionError: ImportSessionError = {
    code: typeof error === "object"
      && error !== null
      && "code" in error
      && typeof error.code === "string"
      ? error.code
      : fallbackCode,
    message: errorMessage(error)
  };
  return semanticImportSession(current, {
    status: "failed",
    phase: "failed",
    message: sessionError.message,
    progress: null,
    execution_token: "",
    error: sessionError
  });
}

export function discardedImportReceipt(
  current: ImportSessionSnapshot,
  discardedAt: number
): DiscardedImportReceipt {
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
