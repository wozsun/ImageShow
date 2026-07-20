import type { ImageDraft, ImportJob } from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import {
  batchDuplicateSnapshotChanged,
  detachRemovedBatchDuplicateOwners,
  refreshBatchDuplicateMatches,
  refreshBatchDuplicateMatchesForOwners
} from "./duplicate-match.js";
import {
  classificationOverrideFor,
  imageDraftPatchChanges,
  importAttributeDefaultsPatch
} from "./import-attribute-policy.js";

const runningImportStatuses = new Set<ImportJob["status"]>([
  "queued",
  "uploading",
  "downloading",
  "processing",
  "committing",
  "cancelling"
]);

export type ImportQueueState = { jobs: ImportJob[]; page: number };
export type ImportQueueAction =
  | { type: "append"; jobs: ImportJob[] }
  | { type: "retain-mode"; mode: "file" | "link" }
  | { type: "patch"; id: string; patch: Partial<ImportJob> }
  | { type: "patch-draft"; id: string; patch: Partial<ImageDraft> }
  | { type: "remove"; ids: Set<string>; pageSize: number }
  | { type: "apply-defaults"; defaults: ImportAttributeDefaults }
  | { type: "set-page"; page: number; pageSize: number };

type ImportJobSummary = {
  readyJobs: ImportJob[];
  duplicateJobs: number;
  runningJobs: number;
  doneJobs: number;
  failedJobs: number;
  skippedJobs: number;
};

export function importQueuePageCount(length: number, pageSize: number) {
  return Math.max(1, Math.ceil(length / pageSize));
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
    jobs: batchDuplicateSnapshotChanged(currentJob, nextJob)
      ? refreshBatchDuplicateMatches(jobs, id)
      : jobs
  };
}

export function summarizeImportJobs(jobs: ImportJob[]): ImportJobSummary {
  const summary: ImportJobSummary = {
    readyJobs: [],
    duplicateJobs: 0,
    runningJobs: 0,
    doneJobs: 0,
    failedJobs: 0,
    skippedJobs: 0
  };

  for (const job of jobs) {
    if (job.status === "ready") {
      if (job.duplicateDecision === "undecided") summary.duplicateJobs += 1;
      else summary.readyJobs.push(job);
      continue;
    }
    if (runningImportStatuses.has(job.status)) {
      summary.runningJobs += 1;
      continue;
    }
    if (job.status === "done") summary.doneJobs += 1;
    else if (job.status === "failed") summary.failedJobs += 1;
    else if (job.status === "skipped") summary.skippedJobs += 1;
  }

  return summary;
}

export function reduceImportQueue(
  state: ImportQueueState,
  action: ImportQueueAction
): ImportQueueState {
  switch (action.type) {
    case "append": {
      const jobs = [...action.jobs, ...state.jobs];
      return { jobs, page: 1 };
    }
    case "retain-mode": {
      const jobs = state.jobs.filter((job) => (
        action.mode === "file" ? job.kind === "local" : job.kind !== "local"
      ));
      return jobs.length === state.jobs.length && state.page === 1
        ? state
        : { jobs, page: 1 };
    }
    case "patch":
      return updateQueueJob(state, action.id, (job) => patchJob(job, action.patch));
    case "patch-draft":
      return updateQueueJob(state, action.id, (job) => patchJobDraft(job, action.patch));
    case "remove": {
      if (!action.ids.size || !state.jobs.some((job) => action.ids.has(job.id))) return state;
      const jobs = detachRemovedBatchDuplicateOwners(state.jobs, action.ids);
      return { jobs, page: Math.min(state.page, importQueuePageCount(jobs.length, action.pageSize)) };
    }
    case "apply-defaults": {
      const changedOwnerIds = new Set<string>();
      const jobs = mapJobsWithIdentity(
        state.jobs,
        (job) => {
          const nextJob = patchJobDraft(
            job,
            importAttributeDefaultsPatch(job, action.defaults)
          );
          if (nextJob !== job && batchDuplicateSnapshotChanged(job, nextJob)) {
            changedOwnerIds.add(job.id);
          }
          return nextJob;
        }
      );
      return jobs === state.jobs ? state : {
        ...state,
        jobs: refreshBatchDuplicateMatchesForOwners(jobs, changedOwnerIds)
      };
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
