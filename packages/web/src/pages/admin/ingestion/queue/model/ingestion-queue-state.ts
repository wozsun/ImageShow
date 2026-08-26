import type {
  ImageDraft,
  IngestionCommitIntent,
  IngestionJob
} from "../../../../../lib/types.js";
import { normalizeAuthor, normalizeTheme } from "../../../../../lib/image-draft.js";
import type { IngestionAttributeDefaults } from "./ingestion-attribute-defaults.js";
import { webUuidV7 } from "./ingestion-identity.js";
import { ingestionJobNeedsDuplicateConfirmation } from "./duplicate-match.js";
import {
  classificationOverrideFor,
  imageDraftPatchChanges,
  ingestionAttributeDefaultsPatch
} from "./ingestion-attribute-policy.js";
import { ingestionStatusPatchMovesForward } from "./ingestion-status-state.js";
import {
  ingestionJobHasServerAuthority,
  serverIngestionJobPairKey
} from "./server-ingestion-job.js";

const processingIngestionStatuses = new Set<IngestionJob["status"]>([
  "uploading",
  "downloading",
  "processing",
  "cancelling"
]);

const waitingIngestionStatuses = new Set<IngestionJob["status"]>([
  "queued",
  "received"
]);

const commitOwnedStatuses = new Set<IngestionJob["status"]>([
  "commit-queued",
  "committing",
  "finalized"
]);

export type IngestionQueueState = { jobs: IngestionJob[]; page: number };
export type IngestionCommitRequest = "new" | "resume";
export type IngestionServerBinding = {
  sessionId: string;
  imageId: string;
} & Partial<Pick<
  IngestionJob,
  | "imageTime"
  | "serverVersion"
  | "serverSemanticRevision"
  | "serverHandoffPending"
  | "serverHandoffRevision"
  | "serverHandoffDisplayPage"
  | "serverHandoffProvisionalTotal"
  | "serverAcceptedOrder"
  | "status"
  | "message"
  | "failureStage"
  | "resultState"
  | "serverAccepted"
  | "transferProgress"
>>;
export type IngestionQueueAction =
  | { type: "append"; jobs: IngestionJob[] }
  | {
      type: "replace-server-page";
      jobs: IngestionJob[];
      stalePairKeys?: ReadonlySet<string>;
    }
  | { type: "patch"; id: string; patch: Partial<IngestionJob> }
  | { type: "bind-server"; id: string; binding: IngestionServerBinding }
  | {
      type: "patch-many";
      patches: ReadonlyMap<string, Partial<IngestionJob>>;
    }
  | { type: "patch-draft"; id: string; patch: Partial<ImageDraft> }
  | {
      type: "remove";
      ids: Set<string>;
      pageSize: number;
      totalItems?: number;
    }
  | {
      type: "release-resolved";
      targets: ReadonlyMap<string, Readonly<{
        attemptKey: string;
        pairKey: string;
      }>>;
      pageSize: number;
      totalItems?: number;
    }
  | {
      type: "apply-defaults";
      defaults: IngestionAttributeDefaults;
      attempts: ReadonlyMap<string, string>;
    }
  | {
      type: "set-page";
      page: number;
      pageSize: number;
      totalItems?: number;
    };

export function ingestionJobHasBrowserDisplayOrder(job: IngestionJob) {
  return job.browserDisplayReleased !== true
    && Number.isInteger(job.manifestPosition)
    && job.manifestPosition! >= 0
    && job.manifestPosition! <= 0xfff;
}

export function browserDisplayPrefixJobs(jobs: readonly IngestionJob[]) {
  const prefix = jobs.map((job, index) => ({ job, index })).filter(({ job }) => (
    !ingestionJobHasServerAuthority(job) || ingestionJobHasBrowserDisplayOrder(job)
  ));
  const ordered = prefix.filter(({ job }) => (
    ingestionJobHasBrowserDisplayOrder(job)
  )).sort((left, right) => {
    if (left.job.subscriptionBatchKey !== right.job.subscriptionBatchKey) {
      return left.job.subscriptionBatchKey > right.job.subscriptionBatchKey
        ? -1
        : 1;
    }
    const position = left.job.manifestPosition! - right.job.manifestPosition!;
    return position || left.index - right.index;
  });
  const fallback = prefix.filter(({ job }) => (
    !ingestionJobHasBrowserDisplayOrder(job)
  ));
  return [...ordered, ...fallback].map(({ job }) => job);
}

export function combinedIngestionQueuePagePlan(
  jobs: readonly IngestionJob[],
  page: number,
  pageSize: number,
  snapshotMaxItems: number
) {
  const displayPrefixJobs = browserDisplayPrefixJobs(jobs);
  const pageStart = (page - 1) * pageSize;
  const visibleDisplayPrefixJobs = displayPrefixJobs.slice(
    pageStart,
    pageStart + pageSize
  );
  const serverPairFor = (job: IngestionJob) => (
    ingestionJobHasServerAuthority(job) && job.sessionId && job.imageId
      ? { session_id: job.sessionId, image_id: job.imageId }
      : null
  );
  const excludedServerItems = displayPrefixJobs.flatMap((job) => {
    const pair = serverPairFor(job);
    return pair ? [pair] : [];
  });
  const visibleRetainedDisplayJobs = displayPrefixJobs.slice(
    pageStart,
    pageStart + pageSize
  );
  const includedServerItems = visibleRetainedDisplayJobs.flatMap((job) => {
    const pair = serverPairFor(job);
    return pair ? [pair] : [];
  });
  const acceptedDisplayPairs = new Set(displayPrefixJobs.flatMap((job) => {
    const pair = serverPairFor(job);
    return pair ? [`${pair.session_id}\0${pair.image_id.toLowerCase()}`] : [];
  }));
  const serverDisplayLimit = Math.max(
    0,
    pageSize - visibleDisplayPrefixJobs.length
  );
  const serverPageOffset = Math.max(0, pageStart - displayPrefixJobs.length);

  return {
    visibleDisplayPrefixJobs,
    acceptedDisplayPairs,
    excludedServerItems,
    includedServerItems,
    serverDisplayLimit,
    serverOffset: serverPageOffset,
    serverLimit: Math.min(
      pageSize,
      Math.max(0, snapshotMaxItems - includedServerItems.length)
    )
  };
}

type IngestionJobSummary = {
  readyCount: number;
  unfinishedCount: number;
  duplicateJobs: number;
  waitingJobs: number;
  runningJobs: number;
  commitQueuedJobs: number;
  committingJobs: number;
  finalizedJobs: number;
  doneJobs: number;
  failedJobs: number;
};

export function ingestionQueuePageCount(length: number, pageSize: number) {
  return Math.max(1, Math.ceil(length / pageSize));
}

export function ingestionJobCanStartCommit(
  job: IngestionJob,
  request: IngestionCommitRequest
) {
  if (!job.md5 || job.duplicateDecision === "undecided") return false;
  return request === "new"
    ? job.status === "ready" && !job.commitIntent
    : Boolean(job.commitIntent) && (
        job.status === "ready"
        || (job.status === "failed" && job.failureStage === "commit")
        || job.status === "committing"
        || (
          job.status === "finalized"
          && job.resultState !== "hydrated"
        )
      );
}

export function createIngestionCommitIntent(
  job: IngestionJob,
  attemptId = webUuidV7()
): IngestionCommitIntent {
  if (!job.md5) throw new Error("准备提交的图片缺少最终 MD5");
  return {
    attemptId,
    md5: job.md5,
    metadata: {
      ...job.draft,
      theme: normalizeTheme(job.draft.theme),
      author: normalizeAuthor(job.draft.author),
      tags: [...job.draft.tags]
    }
  };
}

function ingestionJobHasCommitOwnership(job: IngestionJob) {
  return Boolean(job.commitIntent) || commitOwnedStatuses.has(job.status);
}

function ingestionJobHasConfirmedReadyCheckpoint(job: IngestionJob) {
  return Boolean(job.commitIntent)
    && job.status === "failed"
    && job.commitFailureCheckpoint === "ready";
}

function ingestionJobHasAuthoritativeFailedCommit(job: IngestionJob) {
  return Boolean(job.commitIntent)
    && job.status === "failed"
    && job.failureStage === "commit"
    && job.serverStatus === "failed";
}

function ingestionJobHasReadyCommitIntent(job: IngestionJob) {
  return Boolean(job.commitIntent) && job.status === "ready";
}

export function ingestionJobCanBeCancelled(job: IngestionJob) {
  if (["cancelling", "done", "cancelled"].includes(job.status)) return false;
  if (job.failureStage === "cancel") return true;
  if (ingestionJobHasReadyCommitIntent(job)) return true;
  if (ingestionJobHasConfirmedReadyCheckpoint(job)) return true;
  if (ingestionJobHasAuthoritativeFailedCommit(job)) return true;
  return !ingestionJobHasCommitOwnership(job);
}

export function ingestionJobCanLeaveQueue(job: IngestionJob) {
  if (["cancelling", "done", "cancelled"].includes(job.status)) return true;
  if (job.failureStage === "cancel") return true;
  if (ingestionJobHasReadyCommitIntent(job)) return true;
  if (ingestionJobHasConfirmedReadyCheckpoint(job)) return true;
  if (ingestionJobHasAuthoritativeFailedCommit(job)) return true;
  return !ingestionJobHasCommitOwnership(job);
}

export function ingestionJobCanBeRemovedLocally(job: IngestionJob) {
  return ingestionJobCanLeaveQueue(job) && !(
    job.status === "done" && ingestionJobHasServerAuthority(job)
  );
}

export function isUncommittedIngestionJob(job: IngestionJob) {
  return job.status !== "done" && ingestionJobCanLeaveQueue(job);
}

function patchJobDraft(job: IngestionJob, patch: Partial<ImageDraft>): IngestionJob {
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

function patchJob(job: IngestionJob, patch: Partial<IngestionJob>) {
  const has = (field: keyof IngestionJob) => Object.prototype.hasOwnProperty.call(
    patch,
    field
  );
  const attemptChanged = has("attemptKey")
    && patch.attemptKey !== job.attemptKey;
  const sessionChanged = has("sessionId")
    && patch.sessionId !== job.sessionId;
  const imageChanged = has("imageId")
    && patch.imageId?.toLowerCase() !== job.imageId?.toLowerCase();

  // Retry helpers deliberately spread the complete previous task so callers
  // can publish one atomic replacement. Treat a binding change as the owner
  // transition first: any server snapshot carried by that spread belongs to
  // the previous attempt/session and must never participate in the monotonic
  // event guard or survive into the new owner.
  if (attemptChanged || sessionChanged || imageChanged) {
    const nextPatch = {
      ...patch,
      serverStatus: undefined,
      serverPhase: undefined,
      serverError: undefined,
      serverProgress: undefined,
      serverAttemptKey: undefined,
      serverSessionId: undefined,
      serverImageId: undefined,
      serverVersion: undefined,
      serverProgressSeq: undefined,
      serverSemanticRevision: undefined,
      serverHandoffPending: undefined,
      serverHandoffRevision: undefined,
      serverHandoffDisplayPage: undefined,
      serverHandoffProvisionalTotal: undefined,
      serverAcceptedOrder: undefined,
      serverAccepted: undefined,
      commitIntent: undefined,
      resultState: undefined,
      resultError: undefined,
      ...(has("transferProgress") ? {} : { transferProgress: undefined })
    };
    const changes = (Object.keys(nextPatch) as Array<keyof IngestionJob>)
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
      || patch.serverSessionId !== job.sessionId
      || !job.imageId
      || !patch.serverImageId
      || patch.serverImageId.toLowerCase() !== job.imageId.toLowerCase()
      || !ingestionStatusPatchMovesForward(job, patch)
    )
  ) {
    return job;
  }
  if (!ingestionStatusPatchMovesForward(job, patch)) return job;
  if (
    job.commitIntent
    && patch.status === "failed"
    && patch.failureStage !== "commit"
    && !(job.status === "cancelling" && patch.failureStage === "cancel")
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
  const changes = (Object.keys(patch) as Array<keyof IngestionJob>)
    .some((field) => job[field] !== patch[field]);
  return changes ? { ...job, ...patch } : job;
}

function mapJobsWithIdentity(
  jobs: IngestionJob[],
  mapper: (job: IngestionJob) => IngestionJob
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
  state: IngestionQueueState,
  id: string,
  updater: (job: IngestionJob) => IngestionJob
): IngestionQueueState {
  const jobIndex = state.jobs.findIndex((job) => job.id === id);
  if (jobIndex < 0) return state;
  const currentJob = state.jobs[jobIndex]!;
  const nextJob = updater(currentJob);
  if (nextJob === currentJob) return state;
  const jobs = [...state.jobs];
  jobs[jobIndex] = nextJob;
  return { ...state, jobs };
}

function updateQueueJobs(
  state: IngestionQueueState,
  patches: ReadonlyMap<string, Partial<IngestionJob>>
): IngestionQueueState {
  const jobs = mapJobsWithIdentity(state.jobs, (job) => {
    const patch = patches.get(job.id);
    if (!patch) return job;
    return patchJob(job, patch);
  });
  if (jobs === state.jobs) return state;
  return { ...state, jobs };
}

function mergeCanonicalHandoff(
  canonical: IngestionJob,
  local: IngestionJob
): IngestionJob {
  const preserveLocalPreview = !canonical.md5 && !canonical.preview;
  const cancelling = local.status === "cancelling";
  const preserveLocalDraft = local.serverDraftPending === true;
  return {
    ...canonical,
    id: local.id,
    attemptKey: local.attemptKey,
    subscriptionBatchKey: local.subscriptionBatchKey,
    file: local.file ?? canonical.file,
    fileFingerprint: local.fileFingerprint ?? canonical.fileFingerprint,
    objectUrl: preserveLocalPreview
      ? local.objectUrl ?? canonical.objectUrl
      : canonical.objectUrl,
    draft: preserveLocalDraft ? local.draft : canonical.draft,
    serverDraftPending: preserveLocalDraft
      ? true
      : canonical.serverDraftPending,
    uploadIntentInput: local.uploadIntentInput ?? canonical.uploadIntentInput,
    importAcceptInput: local.importAcceptInput ?? canonical.importAcceptInput,
    batchTime: local.batchTime ?? canonical.batchTime,
    manifestSource: local.manifestSource ?? canonical.manifestSource,
    manifestProvidedCommonFields: local.manifestProvidedCommonFields
      ?? canonical.manifestProvidedCommonFields,
    manifestLine: local.manifestLine ?? canonical.manifestLine,
    manifestPosition: local.manifestPosition ?? canonical.manifestPosition,
    serverHandoffPending: local.serverHandoffPending
      ?? canonical.serverHandoffPending,
    serverHandoffRevision: local.serverHandoffPending !== undefined
      ? local.serverHandoffRevision
      : canonical.serverHandoffRevision,
    serverHandoffDisplayPage: local.serverHandoffDisplayPage,
    serverHandoffProvisionalTotal: local.serverHandoffProvisionalTotal,
    serverVersion: (
      local.serverHandoffPending !== undefined || preserveLocalDraft
    )
      && local.serverVersion !== undefined
      ? Math.max(canonical.serverVersion ?? 0, local.serverVersion)
      : canonical.serverVersion,
    serverSemanticRevision: (
      local.serverHandoffPending !== undefined || preserveLocalDraft
    )
      && local.serverSemanticRevision !== undefined
      ? Math.max(
          canonical.serverSemanticRevision ?? 0,
          local.serverSemanticRevision
        )
      : canonical.serverSemanticRevision,
    serverAttemptKey: local.attemptKey,
    ...(cancelling ? {
      status: local.status,
      message: local.message
    } : {})
  };
}

function bindQueueJob(
  state: IngestionQueueState,
  id: string,
  binding: IngestionServerBinding
): IngestionQueueState {
  const localIndex = state.jobs.findIndex((job) => job.id === id);
  if (localIndex < 0) return state;
  const current = state.jobs[localIndex]!;
  const patched = patchJob(current, {
    ...binding,
    serverAccepted: true
  });
  const bound = patched.serverAccepted === true
    ? patched
    : { ...patched, ...binding, serverAccepted: true };
  const pair = serverIngestionJobPairKey(bound);
  const canonicalIndex = pair
    ? state.jobs.findIndex((job, index) => (
        index !== localIndex
        && job.serverAccepted === true
        && serverIngestionJobPairKey(job) === pair
      ))
    : -1;
  const staleIncarnationIndexes = new Set(state.jobs.flatMap((job, index) => (
    index !== localIndex
    && index !== canonicalIndex
    && job.serverAccepted === true
    && job.sessionId === bound.sessionId
    ? [index]
    : []
  )));
  if (canonicalIndex < 0) {
    if (bound === current && !staleIncarnationIndexes.size) return state;
    const jobs = state.jobs
      .map((job, index) => index === localIndex ? bound : job)
      .filter((_job, index) => !staleIncarnationIndexes.has(index));
    return { ...state, jobs };
  }

  const canonical = state.jobs[canonicalIndex]!;
  const handedOff = mergeCanonicalHandoff(canonical, bound);
  const jobs = state.jobs
    .map((job, index) => index === canonicalIndex ? handedOff : job)
    .filter((_, index) => (
      index !== localIndex && !staleIncarnationIndexes.has(index)
    ));
  return {
    ...state,
    jobs
  };
}

export function summarizeIngestionJobs(jobs: IngestionJob[]): IngestionJobSummary {
  const summary: IngestionJobSummary = {
    readyCount: 0,
    unfinishedCount: 0,
    duplicateJobs: 0,
    waitingJobs: 0,
    runningJobs: 0,
    commitQueuedJobs: 0,
    committingJobs: 0,
    finalizedJobs: 0,
    doneJobs: 0,
    failedJobs: 0
  };

  for (const job of jobs) {
    if (!["done", "cancelled"].includes(job.status)) {
      summary.unfinishedCount += 1;
    }
    if (ingestionJobNeedsDuplicateConfirmation(job)) {
      summary.duplicateJobs += 1;
      continue;
    }
    if (job.status === "ready") {
      const request: IngestionCommitRequest = job.commitIntent ? "resume" : "new";
      if (ingestionJobCanStartCommit(job, request)) {
        summary.readyCount += 1;
      }
      continue;
    }
    if (processingIngestionStatuses.has(job.status)) {
      summary.runningJobs += 1;
      continue;
    }
    if (waitingIngestionStatuses.has(job.status)) {
      summary.waitingJobs += 1;
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

function removeQueueJobIds(
  state: IngestionQueueState,
  ids: ReadonlySet<string>,
  pageSize: number,
  totalItems?: number
) {
  if (!ids.size) return state;
  const jobs = state.jobs.filter((job) => !ids.has(job.id));
  if (jobs.length === state.jobs.length) return state;
  const nextTotalItems = totalItems === undefined
    ? jobs.length
    : Math.max(0, totalItems - (state.jobs.length - jobs.length));
  return {
    jobs,
    page: Math.min(
      state.page,
      ingestionQueuePageCount(nextTotalItems, pageSize)
    )
  };
}

export function reduceIngestionQueue(
  state: IngestionQueueState,
  action: IngestionQueueAction
): IngestionQueueState {
  switch (action.type) {
    case "append": {
      const jobs = [...action.jobs, ...state.jobs];
      return { jobs, page: 1 };
    }
    case "replace-server-page": {
      const browserOwners = new Set(browserDisplayPrefixJobs(state.jobs));
      const canonicalJobs = action.jobs;
      const serverById = new Map(canonicalJobs.map((job) => [job.id, job]));
      const serverByPair = new Map(canonicalJobs.map((job) => (
        [serverIngestionJobPairKey(job), job] as const
      )).filter(([pair]) => Boolean(pair)));
      const consumedServerJobs = new Set<IngestionJob>();
      const displayOwners = state.jobs.flatMap((job) => {
        if (!browserOwners.has(job)) return [];
        const pair = serverIngestionJobPairKey(job);
        if (pair && action.stalePairKeys?.has(pair)) return [];
        const canonical = pair
          ? serverByPair.get(pair)
          : serverById.get(job.id);
        if (!canonical) return [job];
        consumedServerJobs.add(canonical);
        return [mergeCanonicalHandoff(canonical, job)];
      });
      const retainedIds = new Set(displayOwners.map((job) => job.id));
      const retainedPairs = new Set(
        displayOwners.map(serverIngestionJobPairKey).filter(Boolean)
      );
      const serverPage = canonicalJobs.filter((job) => (
        !consumedServerJobs.has(job)
        && !retainedIds.has(job.id)
        && !retainedPairs.has(serverIngestionJobPairKey(job))
      ));
      const jobs = [...displayOwners, ...serverPage];
      if (
        jobs.length === state.jobs.length
        && jobs.every((job, index) => job === state.jobs[index])
      ) return state;
      return { ...state, jobs };
    }
    case "patch":
      return updateQueueJob(state, action.id, (job) => patchJob(job, action.patch));
    case "bind-server":
      return bindQueueJob(state, action.id, action.binding);
    case "patch-many":
      return updateQueueJobs(state, action.patches);
    case "patch-draft":
      return updateQueueJob(state, action.id, (job) => patchJobDraft(job, action.patch));
    case "remove": {
      const removable = new Set(state.jobs.filter((job) => (
        action.ids.has(job.id) && ingestionJobCanLeaveQueue(job)
      )).map((job) => job.id));
      return removeQueueJobIds(
        state,
        removable,
        action.pageSize,
        action.totalItems
      );
    }
    case "release-resolved": {
      const removable = new Set(state.jobs.filter((job) => {
        const target = action.targets.get(job.id);
        return target !== undefined
          && job.attemptKey === target.attemptKey
          && serverIngestionJobPairKey(job) === target.pairKey;
      }).map((job) => job.id));
      return removeQueueJobIds(
        state,
        removable,
        action.pageSize,
        action.totalItems
      );
    }
    case "apply-defaults": {
      const jobs = mapJobsWithIdentity(
        state.jobs,
        (job) => {
          if (action.attempts.get(job.id) !== job.attemptKey) return job;
          const patch = ingestionAttributeDefaultsPatch(job, action.defaults);
          if (!imageDraftPatchChanges(job.draft, patch)) return job;
          return {
            ...patchJobDraft(job, patch),
            // local placeholder 可能正与 accept 响应交叉；保留草稿到 canonical
            // 接管后再写回，避免已发出的 accept payload 覆盖点击时意图。
            serverDraftPending: true
          };
        }
      );
      return jobs === state.jobs ? state : { ...state, jobs };
    }
    case "set-page": {
      const page = Math.max(
        1,
        Math.min(
          action.page,
          ingestionQueuePageCount(
            action.totalItems ?? state.jobs.length,
            action.pageSize
          )
        )
      );
      return page === state.page ? state : { ...state, page };
    }
  }
}
