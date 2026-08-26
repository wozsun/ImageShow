import type { IngestionStatusItemDto } from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../../../lib/types.js";
import { completedIngestionJobPatch } from "./server-ingestion-job.js";

const terminalClientStatuses = new Set<IngestionJob["status"]>([
  "done",
  "cancelled"
]);

export function ingestionStatusPatchMovesForward(
  job: IngestionJob,
  patch: Partial<IngestionJob>
) {
  if (
    terminalClientStatuses.has(job.status)
    && patch.status
    && patch.status !== job.status
  ) return false;
  if (patch.serverVersion !== undefined) {
    const currentVersion = job.serverVersion ?? 0;
    if (patch.serverVersion < currentVersion) return false;
    if (
      patch.serverVersion === currentVersion
      && patch.serverProgressSeq !== undefined
      && patch.serverProgressSeq < (job.serverProgressSeq ?? 0)
    ) return false;
  }
  return true;
}

function clientStatusFor(
  status: Extract<IngestionStatusItemDto, { status: "present" }>["item"]["status"]
): IngestionJob["status"] {
  switch (status) {
    case "queued": return "queued";
    case "downloading": return "downloading";
    case "received": return "received";
    case "preparing": return "processing";
    case "ready": return "ready";
    case "committing": return "committing";
    case "resolving": return "finalized";
    case "failed": return "failed";
  }
}

export function ingestionStatusEventPatch(
  job: IngestionJob,
  state: IngestionStatusItemDto
): Partial<IngestionJob> | null {
  if (
    !job.sessionId
    || !job.imageId
    || state.session_id !== job.sessionId
    || state.image_id.toLowerCase() !== job.imageId.toLowerCase()
  ) return null;
  const authority = {
    serverAttemptKey: job.attemptKey,
    serverSessionId: job.sessionId,
    serverImageId: job.imageId
  };
  if (state.status === "missing") {
    return {
      ...authority,
      serverAccepted: false,
      serverVersion: undefined,
      serverProgressSeq: undefined,
      serverSemanticRevision: undefined,
      serverHandoffPending: false,
      serverHandoffRevision: undefined,
      serverHandoffDisplayPage: undefined,
      serverHandoffProvisionalTotal: undefined,
      serverAcceptedOrder: undefined,
      serverDraftPending: false,
      serverStatus: "missing",
      status: "failed",
      failureStage: job.commitIntent ? "commit" : "prepare",
      commitFailureCheckpoint: job.commitIntent ? "unknown" : undefined,
      message: "未完成内容接入已过期或被服务器丢弃"
    };
  }
  if (state.status === "completed") {
    return {
      ...authority,
      originalSize: job.originalSize ?? job.file?.size,
      ...completedIngestionJobPatch(state.completed_item, state.display)
    };
  }
  const item = state.item;
  const failed = item.status === "failed";
  return {
    ...authority,
    serverStatus: item.status,
    serverPhase: item.phase,
    serverError: item.error?.message ?? "",
    serverProgress: item.progress,
    serverVersion: item.version,
    serverProgressSeq: item.progress_seq,
    status: clientStatusFor(item.status),
    failureStage: failed
      ? job.commitIntent ? "commit" : "prepare"
      : undefined,
    commitFailureCheckpoint: failed && job.commitIntent
      ? item.status === "failed" && item.prepared ? "committing" : "unknown"
      : undefined,
    resultState: item.status === "committing" || item.status === "resolving"
      ? "pending"
      : undefined,
    message: item.error?.message || item.message,
    transferProgress: item.progress
  };
}
