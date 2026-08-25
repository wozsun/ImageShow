import type { ImportJob } from "../../../lib/types.js";

export function importJobPreviewAvailable(job: ImportJob) {
  const preview = job.preview;
  const previewFull = job.previewFull || preview;
  if (!preview || !previewFull) return false;
  return job.status !== "failed"
    || job.failureStage !== "commit"
    || job.commitFailureCheckpoint === "ready";
}

function importJobCanConfirmDuplicates(job: ImportJob) {
  return job.status === "ready";
}

export function importJobNeedsDuplicateConfirmation(job: ImportJob) {
  return importJobCanConfirmDuplicates(job)
    && job.duplicateDecision === "undecided";
}

export function importDuplicateMessage(libraryCount: number) {
  if (libraryCount) return `与图库中 ${libraryCount} 张图片的最终文件重复`;
  return "已就绪，待提交";
}
