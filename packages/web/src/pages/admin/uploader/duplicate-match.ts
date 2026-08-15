import type { ImportJob } from "../../../lib/types.js";
import { importPositionText } from "./import-job-utils.js";

export function isQueueDuplicateCandidate(job: ImportJob) {
  if (!job.md5) return false;
  return job.status === "ready"
    || job.status === "commit-queued"
    || job.status === "committing"
    || job.status === "finalized"
    || (job.status === "failed" && job.failureStage === "commit");
}

export function importJobPreviewAvailable(job: ImportJob) {
  const preview = job.preview;
  const previewFull = job.previewFull || preview;
  if (!preview || !previewFull) return false;
  return job.status !== "failed"
    || job.failureStage !== "commit"
    || job.commitFailureCheckpoint === "ready";
}

function importJobCanConfirmDuplicates(job: ImportJob) {
  return job.status === "ready"
    || (
      job.status === "failed"
      && job.failureStage === "commit"
      && job.commitFailureCheckpoint === "ready"
    );
}

export function importJobNeedsDuplicateConfirmation(job: ImportJob) {
  return importJobCanConfirmDuplicates(job)
    && job.duplicateDecision === "undecided";
}

function earlierPreparedJob(
  current: { job: ImportJob; index: number } | undefined,
  candidate: { job: ImportJob; index: number }
) {
  if (!current) return candidate;
  const currentOrder = current.job.preparedOrder ?? current.index;
  const candidateOrder = candidate.job.preparedOrder ?? candidate.index;
  return candidateOrder < currentOrder ? candidate : current;
}

function queueDuplicateRoots(jobs: readonly ImportJob[]) {
  const roots = new Map<string, { job: ImportJob; index: number }>();
  jobs.forEach((job, index) => {
    if (!job.md5 || !isQueueDuplicateCandidate(job)) return;
    roots.set(
      job.md5,
      earlierPreparedJob(roots.get(job.md5), { job, index })
    );
  });
  return roots;
}

export function queueDuplicateReferences(jobs: readonly ImportJob[]) {
  const roots = queueDuplicateRoots(jobs);
  const references = new Map<string, ImportJob>();
  for (const job of jobs) {
    if (!job.md5 || !isQueueDuplicateCandidate(job)) continue;
    const root = roots.get(job.md5)?.job;
    if (root && root.id !== job.id) references.set(job.id, root);
  }
  return references;
}

export function preparedQueueDuplicateReference(
  jobs: readonly ImportJob[],
  currentId: string,
  md5: string
) {
  let root: { job: ImportJob; index: number } | undefined;
  jobs.forEach((job, index) => {
    if (
      job.id === currentId
      || job.md5 !== md5
      || !isQueueDuplicateCandidate(job)
    ) {
      return;
    }
    root = earlierPreparedJob(root, { job, index });
  });
  return root?.job;
}

export function importJobSourceLabel(job: ImportJob) {
  return job.url
    || job.file?.webkitRelativePath
    || job.file?.name
    || job.draft.original
    || job.id;
}

export function importQueueDuplicateStateChanged(
  previous: ImportJob,
  next: ImportJob
) {
  return previous.md5 !== next.md5
    || previous.preparedOrder !== next.preparedOrder
    || previous.commitFailureCheckpoint !== next.commitFailureCheckpoint
    || isQueueDuplicateCandidate(previous) !== isQueueDuplicateCandidate(next)
    || (
      previous.status !== next.status
      && (
        isQueueDuplicateCandidate(previous)
        || isQueueDuplicateCandidate(next)
      )
    )
    || previous.duplicates !== next.duplicates
    || previous.duplicateDecision !== next.duplicateDecision
    || importPositionText(previous) !== importPositionText(next);
}

export function importDuplicateMessage(
  libraryCount: number,
  queueDuplicate?: ImportJob
) {
  const queuePosition = queueDuplicate
    ? importPositionText(queueDuplicate)
    : "";
  if (libraryCount && queueDuplicate) {
    return queuePosition
      ? `与图库中 ${libraryCount} 张图片及${queuePosition}的最终文件重复`
      : `与图库中 ${libraryCount} 张图片及同批任务的最终文件重复`;
  }
  if (libraryCount) return `与图库中 ${libraryCount} 张图片的最终文件重复`;
  if (queueDuplicate) {
    return queuePosition
      ? `与${queuePosition}的最终文件重复`
      : "与同批任务的最终文件重复";
  }
  return "已就绪，待提交";
}

export function reconcileImportQueueDuplicates(jobs: ImportJob[]) {
  const references = queueDuplicateReferences(jobs);
  let changed = false;
  const nextJobs = jobs.map((job) => {
    const readyForConfirmation = job.status === "ready";
    if (!importJobCanConfirmDuplicates(job)) return job;
    const queueDuplicate = references.get(job.id);
    const duplicateExists = job.duplicates.length > 0
      || Boolean(queueDuplicate);
    const duplicateDecision: ImportJob["duplicateDecision"] = !duplicateExists
      ? "upload"
      : job.duplicateDecision === "confirmed"
        ? "confirmed"
        : "undecided";
    const message = readyForConfirmation
      ? duplicateDecision === "confirmed"
        ? "已确认提交副本"
        : importDuplicateMessage(job.duplicates.length, queueDuplicate)
      : job.message;
    if (
      duplicateDecision === job.duplicateDecision
      && message === job.message
    ) {
      return job;
    }
    changed = true;
    return { ...job, duplicateDecision, message };
  });
  return changed ? nextJobs : jobs;
}
