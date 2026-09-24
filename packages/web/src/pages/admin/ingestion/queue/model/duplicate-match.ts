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
  return job.status === "ready" && job.duplicateDecision === "undecided";
}

export function ingestionDuplicateMessage(libraryCount: number) {
  if (libraryCount) return `与图库中 ${libraryCount} 张图片的最终文件重复`;
  return "已就绪，待提交";
}
