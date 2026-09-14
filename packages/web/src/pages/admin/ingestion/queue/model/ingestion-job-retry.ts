import type { IngestionJob } from "../../../../../lib/types.js";
import { webUuidV7 } from "./ingestion-identity.js";
import { ingestionJobCanStartCommit } from "./ingestion-queue-state.js";
import { ingestionJobNeedsDuplicateConfirmation } from "./duplicate-match.js";

export function ingestionJobRetryKind(job: IngestionJob) {
  if (job.failureStage === "cancel" || ingestionJobNeedsDuplicateConfirmation(job)) return null;
  if (job.failureStage === "commit" || job.status === "finalized") {
    return ((job.status === "failed" || (job.status === "finalized" && job.resultState === "error"))
      && ingestionJobCanStartCommit(job, "resume")) ? "commit" as const : null;
  }
  if (job.status !== "failed" && job.status !== "cancelled") return null;
  if (job.serverAccepted && job.sessionId && job.imageId) {
    return job.status === "failed" && job.serverVersion !== undefined ? "server-prepare" as const : null;
  }
  return (job.kind === "upload" ? Boolean(job.file) : Boolean(job.downloadUrl))
    ? "browser-prepare" as const : null;
}

export function ingestionJobIsRetryableFailure(job: IngestionJob) {
  return job.status === "failed" && ingestionJobRetryKind(job) !== null;
}

// Only browser-owned inputs survive a new prepare attempt. Unknown accept
// results replay their frozen request with the original idempotency identity.
export function resetJobForPrepareRetry(job: IngestionJob): IngestionJob {
  return {
    id: job.id,
    kind: job.kind,
    batchKey: job.batchKey,
    batchTime: job.batchTime,
    batchPosition: job.batchPosition,
    imageTime: job.imageTime,
    manifestSource: job.manifestSource,
    manifestProvidedCommonFields: job.manifestProvidedCommonFields,
    manifestLine: job.manifestLine,
    draft: job.draft,
    storageSlug: job.storageSlug,
    file: job.file,
    fileFingerprint: job.fileFingerprint,
    downloadUrl: job.downloadUrl,
    preview: job.preview,
    previewFull: job.previewFull,
    objectUrl: job.objectUrl,
    width: job.width,
    height: job.height,
    originalWidth: job.originalWidth,
    originalHeight: job.originalHeight,
    originalSize: job.originalSize,
    status: "queued",
    message: "等待重试",
    duplicates: [],
    duplicateDecision: "upload",
    ...prepareRetryIdentity(job)
  };
}

function prepareRetryIdentity(job: IngestionJob) {
  if (job.kind === "upload" && !job.serverVersion && job.uploadIntentItemInput
    && (job.failureStage === "create" || isUnconfirmedUploadRawAttempt(job))) {
    return { attemptKey: job.attemptKey, uploadIntentItemInput: job.uploadIntentItemInput };
  }
  if (job.kind === "import" && job.failureStage === "create" && !job.sessionId) {
    return {
      attemptKey: job.attemptKey,
      importAcceptItemInput: job.importAcceptItemInput,
      importAcceptRejected: job.importAcceptRejected,
      message: "重新获取内容接入会话"
    };
  }
  return { attemptKey: webUuidV7() };
}

function isUnconfirmedUploadRawAttempt(job: IngestionJob) {
  return job.kind === "upload"
    && job.failureStage === "prepare"
    && job.serverVersion === undefined
    && Boolean(job.sessionId && job.imageId);
}
