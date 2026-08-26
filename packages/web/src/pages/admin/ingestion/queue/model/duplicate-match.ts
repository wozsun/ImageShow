import type { IngestionJob } from "../../../../../lib/types.js";

export function ingestionJobPreviewAvailable(job: IngestionJob) {
  const preview = job.preview;
  const previewFull = job.previewFull || preview;
  if (!preview || !previewFull) return false;
  return job.status !== "failed"
    || job.failureStage !== "commit"
    || job.commitFailureCheckpoint === "ready";
}

function ingestionJobCanConfirmDuplicates(job: IngestionJob) {
  return job.status === "ready";
}

export function ingestionJobNeedsDuplicateConfirmation(job: IngestionJob) {
  return ingestionJobCanConfirmDuplicates(job)
    && job.duplicateDecision === "undecided";
}

export function ingestionDuplicateMessage(libraryCount: number) {
  if (libraryCount) return `与图库中 ${libraryCount} 张图片的最终文件重复`;
  return "已就绪，待提交";
}
