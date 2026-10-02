import type { ImportAcceptItemDto, UploadRawResultDto } from "@imageshow/shared/browser";
import type { IngestionServerBinding } from "./ingestion-queue-state.js";

export type AcceptedIngestionResult = Exclude<ImportAcceptItemDto, { status: "failed" }>;

export function ingestionAcceptanceBinding(
  result: AcceptedIngestionResult | UploadRawResultDto
): IngestionServerBinding {
  return {
    sessionId: result.session_id,
    imageId: result.image_id,
    serverAccepted: true,
    ...("resolved_image_time" in result ? { imageTime: result.resolved_image_time } : {}),
    ...(result.status === "accepted" || result.status === "completed"
      ? {
          serverVersion: result.version,
          serverSemanticRevision: result.last_semantic_revision,
          serverHandoffPending: true,
          serverHandoffRevision: result.last_semantic_revision
        }
      : {})
  };
}
