import type {
  ImageDraft,
  AdminImageListItem,
  ImportCommitIntent,
  ImportJob
} from "../../../lib/types.js";
import {
  browserUuid,
  normalizeAuthor,
  normalizeTheme,
  type ImportAttributeDefaults
} from "../../../lib/upload/upload-utils.js";
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
import { importStatusPatchMovesForward } from "./import-status-state.js";

const processingImportStatuses = new Set<ImportJob["status"]>([
  "uploading",
  "downloading",
  "received",
  "processing",
  "cancelling"
]);

const commitOwnedStatuses = new Set<ImportJob["status"]>([
  "commit-queued",
  "committing",
  "finalized"
]);

export type ImportQueueState = { jobs: ImportJob[]; page: number };
export type ImportCommitRequest = "ready" | "retry";
export type ImportQueueAction =
  | { type: "append"; jobs: ImportJob[] }
  | { type: "retain-mode"; mode: "file" | "link" }
  | { type: "patch"; id: string; patch: Partial<ImportJob> }
  | {
      type: "patch-many";
      patches: ReadonlyMap<string, Partial<ImportJob>>;
    }
  | {
      type: "complete";
      id: string;
      patch: Partial<ImportJob>;
      item: AdminImageListItem;
      commitAttemptId: string;
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
  commitQueuedJobs: number;
  committingJobs: number;
  finalizedJobs: number;
  doneJobs: number;
  failedJobs: number;
};

export function importQueuePageCount(length: number, pageSize: number) {
  return Math.max(1, Math.ceil(length / pageSize));
}

export function importJobCanStartCommit(
  job: ImportJob,
  request: ImportCommitRequest
) {
  if (job.duplicateDecision === "undecided") return false;
  return request === "ready"
    ? job.status === "ready" && !job.commitIntent
    : Boolean(job.commitIntent) && (
        (job.status === "failed" && job.failureStage === "commit")
        || job.status === "committing"
        || (
          job.status === "finalized"
          && job.resultState !== "hydrated"
        )
      );
}

export function importJobIsRecoveringCommitResult(
  job: ImportJob
) {
  return job.status === "finalized"
    || (
      job.status === "failed"
      && job.failureStage === "commit"
      && job.commitFailureCheckpoint !== "ready"
    );
}

export function createImportCommitIntent(
  job: ImportJob,
  attemptId = browserUuid(),
  createdAt = new Date().toISOString()
): ImportCommitIntent {
  return {
    attemptId,
    createdAt,
    metadata: {
      ...job.draft,
      theme: normalizeTheme(job.draft.theme),
      author: normalizeAuthor(job.draft.author),
      tags: [...job.draft.tags]
    }
  };
}

function importJobHasCommitOwnership(job: ImportJob) {
  return Boolean(job.commitIntent) || commitOwnedStatuses.has(job.status);
}

export function importJobCanBeCancelled(job: ImportJob) {
  return !importJobHasCommitOwnership(job)
    && !["cancelling", "done", "cancelled"].includes(job.status);
}

export function importJobCanLeaveQueue(job: ImportJob) {
  if (["done", "cancelled"].includes(job.status)) return true;
  return !importJobHasCommitOwnership(job);
}

export function isUncommittedImportJob(job: ImportJob) {
  return job.status !== "done" && importJobCanLeaveQueue(job);
}

function patchJobDraft(job: ImportJob, patch: Partial<ImageDraft>): ImportJob {
  if (job.commitIntent) return job;
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
  const has = (field: keyof ImportJob) => Object.prototype.hasOwnProperty.call(
    patch,
    field
  );
  const attemptChanged = has("attemptKey")
    && patch.attemptKey !== job.attemptKey;
  const sessionChanged = has("sessionId")
    && patch.sessionId?.toLowerCase() !== job.sessionId?.toLowerCase();

  // Retry helpers deliberately spread the complete previous task so callers
  // can publish one atomic replacement. Treat a binding change as the owner
  // transition first: any server snapshot carried by that spread belongs to
  // the previous attempt/session and must never participate in the monotonic
  // event guard or survive into the new owner.
  if (attemptChanged || sessionChanged) {
    const nextPatch = {
      ...patch,
      serverStatus: undefined,
      serverPhase: undefined,
      serverError: undefined,
      serverProgress: undefined,
      serverAttemptKey: undefined,
      serverSessionId: undefined,
      commitIntent: undefined,
      resultState: undefined,
      resultError: undefined,
      ...(has("transferProgress") ? {} : { transferProgress: undefined })
    };
    const changes = (Object.keys(nextPatch) as Array<keyof ImportJob>)
      .some((field) => job[field] !== nextPatch[field]);
    return changes ? { ...job, ...nextPatch } : job;
  }

  const authorityPatch = has("serverStatus") || has("serverPhase")
    || has("serverError") || has("serverProgress");
  if (
    authorityPatch
    && (
      patch.serverAttemptKey !== job.attemptKey
      || !job.sessionId
      || !patch.serverSessionId
      || patch.serverSessionId.toLowerCase() !== job.sessionId.toLowerCase()
      || !importStatusPatchMovesForward(job, patch)
    )
  ) {
    return job;
  }
  if (!importStatusPatchMovesForward(job, patch)) return job;
  if (
    job.commitIntent
    && patch.status === "failed"
    && patch.failureStage !== "commit"
  ) {
    return job;
  }
  if (
    job.commitIntent
    && has("commitIntent")
    && patch.commitIntent !== job.commitIntent
  ) {
    return job;
  }
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

function updateQueueJobs(
  state: ImportQueueState,
  patches: ReadonlyMap<string, Partial<ImportJob>>
): ImportQueueState {
  let duplicateStateChanged = false;
  const jobs = mapJobsWithIdentity(state.jobs, (job) => {
    const patch = patches.get(job.id);
    if (!patch) return job;
    const nextJob = patchJob(job, patch);
    if (
      nextJob !== job
      && importQueueDuplicateStateChanged(job, nextJob)
    ) {
      duplicateStateChanged = true;
    }
    return nextJob;
  });
  if (jobs === state.jobs) return state;
  return {
    ...state,
    jobs: duplicateStateChanged
      ? reconcileImportQueueDuplicates(jobs)
      : jobs
  };
}

function completeQueueJob(
  state: ImportQueueState,
  id: string,
  patch: Partial<ImportJob>,
  item: AdminImageListItem,
  commitAttemptId: string,
  suppressDuplicateItem = false
) {
  const jobIndex = state.jobs.findIndex((job) => job.id === id);
  const current = jobIndex >= 0 ? state.jobs[jobIndex] : undefined;
  if (
    !current?.commitIntent
    || current.commitIntent.attemptId !== commitAttemptId
    || current.resultState === "hydrated"
  ) {
    return state;
  }
  const completed = patchJob(current, {
    ...patch,
    status: "done",
    resultState: "hydrated",
    resultError: undefined,
    md5: item.md5
  });
  if (completed === current) return state;
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
    return { ...job, duplicates: [...job.duplicates, item] };
  });
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
    commitQueuedJobs: 0,
    committingJobs: 0,
    finalizedJobs: 0,
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
    if (job.status === "commit-queued") {
      summary.commitQueuedJobs += 1;
      continue;
    }
    if (job.status === "committing") {
      summary.committingJobs += 1;
      continue;
    }
    if (job.status === "finalized") {
      summary.finalizedJobs += 1;
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
          (action.mode === "file" ? job.kind === "local" : job.kind !== "local")
          || !importJobCanLeaveQueue(job)
        ))
      );
      return jobs.length === state.jobs.length && state.page === 1
        ? state
        : { jobs, page: 1 };
    }
    case "patch":
      return updateQueueJob(state, action.id, (job) => patchJob(job, action.patch));
    case "patch-many":
      return updateQueueJobs(state, action.patches);
    case "complete":
      return completeQueueJob(
        state,
        action.id,
        action.patch,
        action.item,
        action.commitAttemptId,
        action.suppressDuplicateItem
      );
    case "patch-draft":
      return updateQueueJob(state, action.id, (job) => patchJobDraft(job, action.patch));
    case "remove": {
      if (!action.ids.size || !state.jobs.some((job) => action.ids.has(job.id))) return state;
      const jobs = reconcileImportQueueDuplicates(
        state.jobs.filter((job) => (
          !action.ids.has(job.id) || !importJobCanLeaveQueue(job)
        ))
      );
      if (jobs.length === state.jobs.length) return state;
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
