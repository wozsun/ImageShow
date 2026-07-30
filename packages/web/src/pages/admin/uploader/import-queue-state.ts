import type { ImageDraft, ImageItem, ImportJob } from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import {
  importJobNeedsDuplicateConfirmation,
  importQueueDuplicateStateChanged,
  isQueueDuplicateCandidate,
  reconcileImportQueueDuplicates
} from "./duplicate-match.js";
import {
  classificationOverrideFor,
  imageDraftPatchChanges,
  importAttributeDefaultsPatch
} from "./import-attribute-policy.js";

const processingImportStatuses = new Set<ImportJob["status"]>([
  "uploading",
  "downloading",
  "received",
  "processing",
  "committing",
  "cancelling"
]);

export type ImportQueueState = { jobs: ImportJob[]; page: number };
export type ImportCommitIntent = "ready" | "retry";
export type ImportQueueAction =
  | { type: "append"; jobs: ImportJob[] }
  | { type: "retain-mode"; mode: "file" | "link" }
  | { type: "patch"; id: string; patch: Partial<ImportJob> }
  | {
      type: "complete";
      id: string;
      patch: Partial<ImportJob>;
      item: ImageItem;
      suppressDuplicateItem?: boolean;
    }
  | { type: "patch-draft"; id: string; patch: Partial<ImageDraft> }
  | { type: "remove"; ids: Set<string>; pageSize: number }
  | { type: "remove-library-duplicate"; imageId: string }
  | { type: "apply-defaults"; defaults: ImportAttributeDefaults }
  | { type: "set-page"; page: number; pageSize: number };

type ImportJobSummary = {
  readyJobs: ImportJob[];
  duplicateJobs: number;
  runningJobs: number;
  doneJobs: number;
  failedJobs: number;
};

export function importQueuePageCount(length: number, pageSize: number) {
  return Math.max(1, Math.ceil(length / pageSize));
}

export function importJobCanStartCommit(
  job: ImportJob,
  intent: ImportCommitIntent
) {
  if (job.duplicateDecision === "undecided") return false;
  return intent === "ready"
    ? job.status === "ready"
    : job.status === "failed" && job.failureStage === "commit";
}

function patchJobDraft(job: ImportJob, patch: Partial<ImageDraft>): ImportJob {
  if (!imageDraftPatchChanges(job.draft, patch)) return job;
  const next = { ...job, draft: { ...job.draft, ...patch } };
  return {
    ...next,
    classificationOverride: classificationOverrideFor(
      next.draft,
      next.detectedClassification
    )
  };
}

function patchJob(job: ImportJob, patch: Partial<ImportJob>) {
  const changes = (Object.keys(patch) as Array<keyof ImportJob>)
    .some((field) => job[field] !== patch[field]);
  return changes ? { ...job, ...patch } : job;
}

function mapJobsWithIdentity(
  jobs: ImportJob[],
  mapper: (job: ImportJob) => ImportJob
) {
  let changed = false;
  const nextJobs = jobs.map((job) => {
    const nextJob = mapper(job);
    if (nextJob !== job) changed = true;
    return nextJob;
  });
  return changed ? nextJobs : jobs;
}

function updateQueueJob(
  state: ImportQueueState,
  id: string,
  updater: (job: ImportJob) => ImportJob
): ImportQueueState {
  const jobIndex = state.jobs.findIndex((job) => job.id === id);
  if (jobIndex < 0) return state;
  const currentJob = state.jobs[jobIndex]!;
  const nextJob = updater(currentJob);
  if (nextJob === currentJob) return state;
  const jobs = [...state.jobs];
  jobs[jobIndex] = nextJob;
  return {
    ...state,
    jobs: importQueueDuplicateStateChanged(currentJob, nextJob)
      ? reconcileImportQueueDuplicates(jobs)
      : jobs
  };
}

function completeQueueJob(
  state: ImportQueueState,
  id: string,
  patch: Partial<ImportJob>,
  item: ImageItem,
  suppressDuplicateItem = false
) {
  const jobIndex = state.jobs.findIndex((job) => job.id === id);
  const completed = jobIndex >= 0
    ? patchJob(state.jobs[jobIndex]!, { ...patch, md5: item.md5 })
    : undefined;
  let changed = Boolean(
    completed && completed !== state.jobs[jobIndex]
  );
  const jobs = state.jobs.map((job, index) => {
    if (index === jobIndex && completed) return completed;
    if (
      suppressDuplicateItem
      || job.md5 !== item.md5
      || (
        !isQueueDuplicateCandidate(job)
        && job.status !== "processing"
      )
      || job.duplicates.some((duplicate) => duplicate.id === item.id)
    ) {
      return job;
    }
    changed = true;
    return { ...job, duplicates: [...job.duplicates, item] };
  });
  if (!changed) return state;
  return {
    ...state,
    jobs: reconcileImportQueueDuplicates(jobs)
  };
}

export function summarizeImportJobs(jobs: ImportJob[]): ImportJobSummary {
  const summary: ImportJobSummary = {
    readyJobs: [],
    duplicateJobs: 0,
    runningJobs: 0,
    doneJobs: 0,
    failedJobs: 0
  };

  for (const job of jobs) {
    if (importJobNeedsDuplicateConfirmation(job)) {
      summary.duplicateJobs += 1;
      continue;
    }
    if (job.status === "ready") {
      if (importJobCanStartCommit(job, "ready")) summary.readyJobs.push(job);
      continue;
    }
    if (processingImportStatuses.has(job.status)) {
      summary.runningJobs += 1;
      continue;
    }
    if (job.status === "done") summary.doneJobs += 1;
    else if (job.status === "failed") summary.failedJobs += 1;
  }

  return summary;
}

export function reduceImportQueue(
  state: ImportQueueState,
  action: ImportQueueAction
): ImportQueueState {
  switch (action.type) {
    case "append": {
      const jobs = reconcileImportQueueDuplicates([...action.jobs, ...state.jobs]);
      return { jobs, page: 1 };
    }
    case "retain-mode": {
      const jobs = reconcileImportQueueDuplicates(
        state.jobs.filter((job) => (
          action.mode === "file" ? job.kind === "local" : job.kind !== "local"
        ))
      );
      return jobs.length === state.jobs.length && state.page === 1
        ? state
        : { jobs, page: 1 };
    }
    case "patch":
      return updateQueueJob(state, action.id, (job) => patchJob(job, action.patch));
    case "complete":
      return completeQueueJob(
        state,
        action.id,
        action.patch,
        action.item,
        action.suppressDuplicateItem
      );
    case "patch-draft":
      return updateQueueJob(state, action.id, (job) => patchJobDraft(job, action.patch));
    case "remove": {
      if (!action.ids.size || !state.jobs.some((job) => action.ids.has(job.id))) return state;
      const jobs = reconcileImportQueueDuplicates(
        state.jobs.filter((job) => !action.ids.has(job.id))
      );
      return { jobs, page: Math.min(state.page, importQueuePageCount(jobs.length, action.pageSize)) };
    }
    case "remove-library-duplicate": {
      if (!state.jobs.some((job) => (
        job.duplicates.some((duplicate) => duplicate.id === action.imageId)
      ))) {
        return state;
      }
      const jobs = reconcileImportQueueDuplicates(
        mapJobsWithIdentity(state.jobs, (job) => {
          const duplicates = job.duplicates.filter(
            (duplicate) => duplicate.id !== action.imageId
          );
          return duplicates.length === job.duplicates.length
            ? job
            : { ...job, duplicates };
        })
      );
      return { ...state, jobs };
    }
    case "apply-defaults": {
      const jobs = mapJobsWithIdentity(
        state.jobs,
        (job) => patchJobDraft(
          job,
          importAttributeDefaultsPatch(job, action.defaults)
        )
      );
      return jobs === state.jobs ? state : { ...state, jobs };
    }
    case "set-page": {
      const page = Math.max(
        1,
        Math.min(action.page, importQueuePageCount(state.jobs.length, action.pageSize))
      );
      return page === state.page ? state : { ...state, page };
    }
  }
}
