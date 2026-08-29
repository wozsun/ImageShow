import type { IngestionJob } from "../../../../../lib/types.js";
import { webUuidV7 } from "./ingestion-identity.js";

export function resetJobForPrepareRetry(job: IngestionJob): IngestionJob {
  return {
    ...job,
    attemptKey: webUuidV7(),
    uploadIntentItemInput: undefined,
    importAcceptItemInput: undefined,
    sessionId: undefined,
    imageId: undefined,
    imageTime: undefined,
    serverVersion: undefined,
    serverProgressSeq: undefined,
    serverSemanticRevision: undefined,
    serverHandoffPending: undefined,
    serverHandoffRevision: undefined,
    serverHandoffDisplayPage: undefined,
    serverHandoffProvisionalTotal: undefined,
    serverAcceptedOrder: undefined,
    serverAccepted: undefined,
    serverDraftPending: undefined,
    serverStatus: undefined,
    serverPhase: undefined,
    serverError: undefined,
    serverProgress: undefined,
    serverAttemptKey: undefined,
    serverSessionId: undefined,
    serverImageId: undefined,
    browserDisplayReleased: undefined,
    status: "queued",
    failureStage: undefined,
    commitFailureCheckpoint: undefined,
    commitIntent: undefined,
    resultState: undefined,
    resultError: undefined,
    message: "等待重试",
    transferProgress: undefined,
    md5: undefined,
    preparedOrder: undefined,
    detectedClassification: undefined,
    classificationOverride: undefined,
    duplicates: [],
    duplicateCount: undefined,
    duplicateDecision: "upload",
    finalSize: undefined,
    quality: undefined,
    transcoded: undefined
  };
}

export function isUnconfirmedUploadRawAttempt(job: IngestionJob) {
  return job.kind === "upload"
    && job.failureStage === "prepare"
    && job.serverVersion === undefined
    && Boolean(job.sessionId && job.imageId);
}

export function resetImportJobForPrepareRetry(job: IngestionJob): IngestionJob {
  if (job.failureStage !== "create" || job.sessionId) {
    return resetJobForPrepareRetry(job);
  }
  return {
    ...resetJobForPrepareRetry(job),
    attemptKey: job.attemptKey,
    importAcceptItemInput: job.importAcceptItemInput,
    status: "queued",
    message: "重新获取内容接入会话"
  };
}
