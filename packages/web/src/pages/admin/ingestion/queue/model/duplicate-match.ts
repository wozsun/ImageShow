import type { IngestionJob } from "./ingestion-job.js";

export function ingestionJobPreviewAvailable(job: IngestionJob) {
  if (!job.preview) return false;
  return (
    job.status !== "failed" ||
    job.failureStage !== "commit" ||
    job.commitFailureCheckpoint === "ready"
  );
}

export function ingestionJobNeedsDuplicateConfirmation(job: IngestionJob) {
  return job.status === "ready"
    && job.duplicateDecision === "undecided";
}
