import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ingestionBatchHardLimit,
  ingestionQueueSnapshotMaxItems,
  type IngestionQueueActionResultDto,
  type IngestionQueueTerminalEventItemDto,
  type ServerIngestionItemDto,
  type IngestionQueueSummaryDto,
  type IngestionQueueTypeDto,
  type IngestionSessionPairDto
} from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../../lib/types.js";
import type { IngestionAttributeDefaults } from "./model/ingestion-attribute-defaults.js";
import {
  browserDisplayPrefixJobs,
  combinedIngestionQueuePagePlan,
  ingestionJobHasBrowserDisplayOrder,
  ingestionQueuePageCount,
  ingestionJobCanLeaveQueue,
  isUncommittedIngestionJob,
  reduceIngestionQueue,
  summarizeIngestionJobs,
  type IngestionQueueAction,
  type IngestionServerBinding,
  type IngestionQueueState
} from "./model/ingestion-queue-state.js";
import {
  type CompletedIngestionObservation,
  type IngestionQueueProducerApi
} from "./ingestion-queue-api.js";
import {
  completedIngestionOwnerPatch,
  completedIngestionReceiptOwnerPatch,
  ingestionJobFromServerItem,
  ingestionJobAwaitsActionCoverage,
  ingestionJobHasServerAuthority,
  serverIngestionJobsForCombinedPage,
  serverIngestionJobPairKey,
  serverIngestionPairKey
} from "./model/server-ingestion-job.js";
import { ingestionStatusPatchMovesForward } from "./model/ingestion-status-state.js";
import { useServerIngestionQueue } from "./useServerIngestionQueue.js";
import { useIngestionQueueActions } from "./useIngestionQueueActions.js";
import { invalidateIngestionDuplicateDetails } from "./useIngestionDuplicateDetails.js";
import { useStoredIngestionDraftSync } from "./useStoredIngestionDraftSync.js";
import { useIngestionAuthorityHandoffs } from "./useIngestionAuthorityHandoffs.js";
import { useOptionalAuthSessionRecovery } from "../../../../hooks/useAuthSession.js";
import { useCompletedIngestionInvalidation } from "./useCompletedIngestionInvalidation.js";
import { useIngestionStatusHydration } from "./useIngestionStatusHydration.js";
import type {
  DetachedProvisionalHandoff,
  HandoffRetryGate,
  ServerQueueConnectionSnapshot
} from "./model/ingestion-handoff-runtime.js";

function revokeObjectUrl(job: IngestionJob) {
  if (job.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(job.objectUrl);
}

function ingestionPairBelongsToSession(pairKey: string, sessionId: string) {
  return pairKey.startsWith(`${sessionId}\0`);
}

type StableServerQueueSummary = Readonly<{
  connectionGeneration: number;
  lastAcceptedOrder: number;
  revision: number;
  summary: IngestionQueueSummaryDto;
}>;

type ResolvedServerJobTarget = Readonly<{
  id: string;
  attemptKey: string;
  pair: IngestionSessionPairDto;
  releasedRevision?: number;
  releasedSummary?: IngestionQueueSummaryDto;
}>;

type FailedResolvedReleaseRecovery = {
  target: ResolvedServerJobTarget;
  observedNonReady: boolean;
};

function ingestionJobMatchesResolvedServerTarget(
  job: IngestionJob,
  target: ResolvedServerJobTarget
) {
  if (serverIngestionJobPairKey(job) !== serverIngestionPairKey(target.pair)) {
    return false;
  }
  if (job.id === target.id && job.attemptKey === target.attemptKey) return true;
  return ingestionJobHasServerAuthority(job)
    && job.serverAttemptKey === target.attemptKey;
}

function serverItemSummary(
  item: ServerIngestionItemDto
): IngestionQueueSummaryDto {
  const completed = item.status === "completed";
  const prepareWaiting = item.status === "preparing"
    && item.phase === "prepare-waiting";
  const duplicatePending = item.status === "ready"
    && Boolean(item.prepared?.duplicate_count)
    && !item.duplicate_decision;
  return {
    total: 1,
    unfinished: completed ? 0 : 1,
    waiting: ["queued", "received"].includes(item.status) || prepareWaiting
      ? 1
      : 0,
    running: ["downloading", "preparing"].includes(item.status)
      && !prepareWaiting
      ? 1
      : 0,
    ready: item.status === "ready" && !duplicatePending ? 1 : 0,
    duplicate_pending: duplicatePending ? 1 : 0,
    committing: item.status === "committing" ? 1 : 0,
    resolving: item.status === "resolving" ? 1 : 0,
    completed: completed ? 1 : 0,
    failed: item.status === "failed" ? 1 : 0
  };
}

function withoutReleasedServerSummaries(
  summary: IngestionQueueSummaryDto,
  releasedSummaries: readonly IngestionQueueSummaryDto[]
): IngestionQueueSummaryDto {
  if (!releasedSummaries.length) return summary;
  const released = releasedSummaries.reduce<IngestionQueueSummaryDto>(
    (counts, item) => ({
      total: counts.total + item.total,
      unfinished: counts.unfinished + item.unfinished,
      waiting: counts.waiting + item.waiting,
      running: counts.running + item.running,
      ready: counts.ready + item.ready,
      duplicate_pending: counts.duplicate_pending + item.duplicate_pending,
      committing: counts.committing + item.committing,
      resolving: counts.resolving + item.resolving,
      completed: counts.completed + item.completed,
      failed: counts.failed + item.failed
    }), {
      total: 0,
      unfinished: 0,
      waiting: 0,
      running: 0,
      ready: 0,
      duplicate_pending: 0,
      committing: 0,
      resolving: 0,
      completed: 0,
      failed: 0
    }
  );
  const subtract = (value: number, amount: number) => Math.max(0, value - amount);
  return {
    total: subtract(summary.total, released.total),
    unfinished: subtract(summary.unfinished, released.unfinished),
    waiting: subtract(summary.waiting, released.waiting),
    running: subtract(summary.running, released.running),
    ready: subtract(summary.ready, released.ready),
    duplicate_pending: subtract(
      summary.duplicate_pending,
      released.duplicate_pending
    ),
    committing: subtract(summary.committing, released.committing),
    resolving: subtract(summary.resolving, released.resolving),
    completed: subtract(summary.completed, released.completed),
    failed: subtract(summary.failed, released.failed)
  };
}

type ResolvedReleaseProjectionContext = Readonly<{
  hasRetainedServerBaseline: boolean;
  serverItems: readonly ServerIngestionItemDto[];
  retainedServerSummary: IngestionQueueSummaryDto | null;
  retainedServerRevision: number | null;
  localJobs: readonly IngestionJob[];
  provisionalSummaryJobs: readonly IngestionJob[];
}>;

function releasedServerSummariesForTargets(
  context: Pick<
    ResolvedReleaseProjectionContext,
    | "hasRetainedServerBaseline"
    | "serverItems"
    | "retainedServerRevision"
  >,
  targets: ReadonlyMap<string, ResolvedServerJobTarget>
) {
  const snapshotItemsByPair = context.hasRetainedServerBaseline
    ? new Map(context.serverItems.map((item) => (
        [serverIngestionPairKey(item), item] as const
      )))
    : new Map<string, ServerIngestionItemDto>();
  return [...targets].flatMap(([pairKey, target]) => {
    const snapshotItem = snapshotItemsByPair.get(pairKey);
    if (snapshotItem) return [serverItemSummary(snapshotItem)];
    return target.releasedSummary
      && target.releasedRevision !== undefined
      && context.retainedServerRevision !== null
      && context.retainedServerRevision < target.releasedRevision
        ? [target.releasedSummary]
        : [];
  });
}

function projectedTotalAfterResolvedRelease(
  context: ResolvedReleaseProjectionContext,
  currentTargets: ReadonlyMap<string, ResolvedServerJobTarget>,
  releasedTargets: ReadonlyMap<string, ResolvedServerJobTarget>
) {
  const projectedTargets = new Map(currentTargets);
  for (const [pairKey, target] of releasedTargets) {
    projectedTargets.set(pairKey, target);
  }
  const projectedServerSummary = context.retainedServerSummary
    ? withoutReleasedServerSummaries(
        context.retainedServerSummary,
        releasedServerSummariesForTargets(context, projectedTargets)
      )
    : null;
  const retainedLocalJobs = context.localJobs.filter((job) => {
    const target = projectedTargets.get(serverIngestionJobPairKey(job));
    return !target || !ingestionJobMatchesResolvedServerTarget(job, target);
  });
  const retainedProvisionalJobs = context.provisionalSummaryJobs.filter((job) => {
    const target = projectedTargets.get(serverIngestionJobPairKey(job));
    return !target || !ingestionJobMatchesResolvedServerTarget(job, target);
  });
  return retainedLocalJobs.length
    + retainedProvisionalJobs.length
    + (projectedServerSummary?.total ?? 0);
}

export function useIngestionQueue(
  pageSize: number,
  queueType: IngestionQueueTypeDto,
  displayed: boolean
) {
  const recoverAuthSession = useOptionalAuthSessionRecovery();
  const [state, setState] = useState<IngestionQueueState>({ jobs: [], page: 1 });
  const [draftNotice, setDraftNotice] = useState<{
    message: string;
    retryable: boolean;
  } | null>(null);
  const [statusNotice, setStatusNotice] = useState<{
    message: string;
    retryable: boolean;
  } | null>(null);
  const [statusRetryEpoch, setStatusRetryEpoch] = useState(0);
  const [handoffEpoch, setHandoffEpoch] = useState(0);
  const [resolvedReleaseEpoch, setResolvedReleaseEpoch] = useState(0);
  const stateRef = useRef(state);
  const jobsRef = useRef(state.jobs);
  const handoffJobsRef = useRef(new Map<string, IngestionJob>());
  const detachedProvisionalHandoffsRef = useRef(
    new Map<string, DetachedProvisionalHandoff>()
  );
  const handoffRetryAfterRevisionRef = useRef(
    new Map<string, HandoffRetryGate>()
  );
  const completedHandoffPairsRef = useRef(new Set<string>());
  const completedReceiptHydrationsRef = useRef(
    new Map<string, IngestionSessionPairDto>()
  );
  const resolvedReleaseTargetsRef = useRef(
    new Map<string, ResolvedServerJobTarget>()
  );
  const failedResolvedReleaseRecoveriesRef = useRef(
    new Map<string, FailedResolvedReleaseRecovery>()
  );
  const handledStaleSnapshotRef = useRef("");
  const actionConnectionHoldRef = useRef(false);
  const lastReadyGenerationRef = useRef(0);
  const dispatch = useCallback((action: IngestionQueueAction) => {
    // 上传/下载是异步并发流程，回调触发时 React state 可能已落后；ref 里同步维护最新队列供所有回调用。
    const current = stateRef.current;
    const next = reduceIngestionQueue(current, action);
    if (next === current) return false;
    stateRef.current = next;
    jobsRef.current = next.jobs;
    setState(next);
    return true;
  }, []);
  const completedInvalidation = useCompletedIngestionInvalidation();
  const flushCompletedIngestionInvalidations = completedInvalidation.flush;
  const projectRetainedServerOwner = useCallback((
    pairKey: string,
    project: (job: IngestionJob) => IngestionJob
  ) => {
    const objectUrls = new Set<string>();
    let retainedRefChanged = false;
    const projectJob = (job: IngestionJob) => {
      if (serverIngestionJobPairKey(job) !== pairKey) return job;
      const next = project(job);
      if (
        next !== job
        && job.objectUrl?.startsWith("blob:")
        && next.objectUrl !== job.objectUrl
      ) objectUrls.add(job.objectUrl);
      return next;
    };
    const patches = new Map<string, Partial<IngestionJob>>();
    for (const job of stateRef.current.jobs) {
      const next = projectJob(job);
      if (next !== job) patches.set(job.id, next);
    }
    const handoff = handoffJobsRef.current.get(pairKey);
    if (handoff) {
      const next = projectJob(handoff);
      if (next !== handoff) {
        handoffJobsRef.current.set(pairKey, next);
        retainedRefChanged = true;
      }
    }
    const detached = detachedProvisionalHandoffsRef.current.get(pairKey);
    if (detached) {
      const next = projectJob(detached.job);
      if (next !== detached.job) {
        detachedProvisionalHandoffsRef.current.set(pairKey, {
          ...detached,
          job: next
        });
        retainedRefChanged = true;
      }
    }
    for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
    const stateChanged = patches.size
      ? dispatch({ type: "patch-many", patches })
      : false;
    if (retainedRefChanged && !stateChanged) {
      setHandoffEpoch((current) => current + 1);
    }
  }, [dispatch]);
  const observeCompletedIngestions = useCallback((
    entries: readonly CompletedIngestionObservation[]
  ) => {
    let hydrationChanged = false;
    for (const entry of entries) {
      const pairKey = serverIngestionPairKey(entry.pair);
      hydrationChanged = completedReceiptHydrationsRef.current.delete(pairKey)
        || hydrationChanged;
      projectRetainedServerOwner(pairKey, (job) => {
        const patch = completedIngestionOwnerPatch(job, entry);
        if (!patch || !ingestionStatusPatchMovesForward(job, patch)) return job;
        return { ...job, ...patch };
      });
    }
    if (hydrationChanged) setHandoffEpoch((current) => current + 1);
    completedInvalidation.observe(entries);
  }, [completedInvalidation.observe, projectRetainedServerOwner]);
  const observeCompletedIngestionReceipt = useCallback((
    receipt: IngestionQueueTerminalEventItemDto & { status: "completed" }
  ) => {
    const pairKey = serverIngestionPairKey(receipt);
    const retained = stateRef.current.jobs.find((job) => (
      serverIngestionJobPairKey(job) === pairKey
    )) ?? handoffJobsRef.current.get(pairKey)
      ?? detachedProvisionalHandoffsRef.current.get(pairKey)?.job;
    if (retained) {
      projectRetainedServerOwner(pairKey, (job) => {
        const patch = completedIngestionReceiptOwnerPatch(job, receipt);
        if (!patch || !ingestionStatusPatchMovesForward(job, patch)) return job;
        return { ...job, ...patch };
      });
    }
    const projected = stateRef.current.jobs.find((job) => (
      serverIngestionJobPairKey(job) === pairKey
    )) ?? handoffJobsRef.current.get(pairKey)
      ?? detachedProvisionalHandoffsRef.current.get(pairKey)?.job;
    if (projected?.resultState === "hydrated") {
      if (completedReceiptHydrationsRef.current.delete(pairKey)) {
        setHandoffEpoch((current) => current + 1);
      }
      return;
    }
    // A compact receipt for an off-page/unknown pair may be replayed after its
    // PostgreSQL DTO was already hydrated. Reuse the completion invalidation
    // owner's bounded lifetime dedupe instead of issuing another status read.
    if (!projected && completedInvalidation.hasObserved(receipt)) return;
    if (!completedReceiptHydrationsRef.current.has(pairKey)) {
      completedReceiptHydrationsRef.current.set(pairKey, {
        session_id: receipt.session_id,
        image_id: receipt.image_id
      });
      setHandoffEpoch((current) => current + 1);
    }
  }, [completedInvalidation.hasObserved, projectRetainedServerOwner]);
  const observeServerIngestionItem = useCallback((
    item: ServerIngestionItemDto
  ) => {
    const pairKey = serverIngestionPairKey(item);
    projectRetainedServerOwner(pairKey, (job) => {
      const next = ingestionJobFromServerItem(item, job);
      return ingestionStatusPatchMovesForward(job, next) ? next : job;
    });
  }, [projectRetainedServerOwner]);
  const scheduleCompletedIngestionInvalidation = completedInvalidation.schedule;
  const localJobs = useMemo(
    () => state.jobs.filter((job) => !ingestionJobHasServerAuthority(job)),
    [state.jobs]
  );
  const pagePlan = useMemo(() => combinedIngestionQueuePagePlan(
    state.jobs,
    state.page,
    pageSize,
    ingestionQueueSnapshotMaxItems
  ), [pageSize, state.jobs, state.page]);
  const {
    visibleDisplayPrefixJobs,
    acceptedDisplayPairs,
    excludedServerItems,
    includedServerItems,
    serverDisplayLimit,
    serverOffset,
    serverLimit
  } = pagePlan;
  const acceptedDisplayPairsKey = [...acceptedDisplayPairs]
    .sort()
    .join("\n");
  const server = useServerIngestionQueue({
    enabled: displayed || actionConnectionHoldRef.current,
    displayed,
    queue: queueType,
    offset: serverOffset,
    limit: serverLimit,
    requiredItems: serverDisplayLimit,
    excludeItems: excludedServerItems,
    includeItems: includedServerItems,
    onCompletedIngestions: observeCompletedIngestions,
    onCompletedIngestionReceipt: observeCompletedIngestionReceipt,
    onServerIngestionItem: observeServerIngestionItem
  });
  completedInvalidation.setQueueIdle(server.status === "ready"
    && server.summary !== null
    && server.summary.committing === 0
    && server.summary.resolving === 0
    && completedReceiptHydrationsRef.current.size === 0);
  const serverItemsRef = useRef(server.items);
  serverItemsRef.current = server.items;
  const serverConnectionRef = useRef<ServerQueueConnectionSnapshot>({
    status: server.status,
    connectionGeneration: server.connectionGeneration,
    revision: server.revision,
    lastAcceptedOrder: server.lastAcceptedOrder
  });
  serverConnectionRef.current = {
    status: server.status,
    connectionGeneration: server.connectionGeneration,
    revision: server.revision,
    lastAcceptedOrder: server.lastAcceptedOrder
  };
  const lastStableServerSummaryRef = useRef<StableServerQueueSummary | null>(
    null
  );
  if (
    server.status === "ready"
    && server.summary
    && server.revision !== null
    && server.lastAcceptedOrder !== null
  ) {
    lastStableServerSummaryRef.current = {
      connectionGeneration: server.connectionGeneration,
      lastAcceptedOrder: server.lastAcceptedOrder,
      revision: server.revision,
      summary: server.summary
    };
  }
  const hasRetainedServerBaseline = server.summary !== null
    && server.revision !== null
    && server.lastAcceptedOrder !== null;
  const provisionalAcceptedOrderBaseline = hasRetainedServerBaseline
    ? server.lastAcceptedOrder
    : lastStableServerSummaryRef.current?.lastAcceptedOrder ?? null;
  const captureServerConnectionGeneration = useCallback(() => {
    const current = serverConnectionRef.current;
    return current.status === "ready" ? current.connectionGeneration : null;
  }, []);
  const actions = useIngestionQueueActions(
    queueType,
    server,
    actionConnectionHoldRef,
    observeCompletedIngestions,
    recoverAuthSession
  );
  const releasedTargets = useMemo(
    () => [...resolvedReleaseTargetsRef.current.entries()],
    [resolvedReleaseEpoch]
  );
  const releasedPairKeys = useMemo(
    () => new Set(releasedTargets.map(([pairKey]) => pairKey)),
    [releasedTargets]
  );
  const currentServerJobs = useMemo(
    () => state.jobs.filter(ingestionJobHasServerAuthority),
    [state.jobs]
  );
  const availableServerJobs = currentServerJobs;
  const snapshotItems = useMemo(() => (
    hasRetainedServerBaseline
      ? server.items.filter((item) => (
          !releasedPairKeys.has(serverIngestionPairKey(item))
        ))
      : []
  ), [hasRetainedServerBaseline, releasedPairKeys, server.items]);
  const snapshotPairs = new Set(snapshotItems.map(serverIngestionPairKey));
  const visibleHandoffPairs = new Set(availableServerJobs.flatMap((job) => {
    const pairKey = serverIngestionJobPairKey(job);
    return pairKey
      && !ingestionJobHasBrowserDisplayOrder(job)
      && !snapshotPairs.has(pairKey)
      && job.serverHandoffDisplayPage === state.page
      && (
        server.status !== "ready"
        || job.serverHandoffPending === true
      )
      ? [pairKey]
      : [];
  }));
  // Current-document cards retain their browser batch/position order while
  // authority moves item-by-item. The bounded snapshot supplies only the
  // remaining slots and keeps its own display-ZSET order.
  const displayedServerJobs = serverIngestionJobsForCombinedPage(
    availableServerJobs,
    snapshotItems,
    serverDisplayLimit,
    visibleHandoffPairs
  ).filter((job) => (
    !acceptedDisplayPairs.has(serverIngestionJobPairKey(job))
  )).slice(0, serverDisplayLimit);
  const detachedProvisionalJobs = [
    ...detachedProvisionalHandoffsRef.current.values()
  ].map((entry) => entry.job);
  const provisionalByPair = new Map([
    ...availableServerJobs,
    ...detachedProvisionalJobs,
    ...handoffJobsRef.current.values()
  ].map((job) => [serverIngestionJobPairKey(job), job]));
  const provisionalSummaryJobs = [...provisionalByPair.values()].filter((job) => (
    job.serverHandoffProvisionalTotal === true
    && job.serverHandoffPending === true
    && !snapshotPairs.has(serverIngestionJobPairKey(job))
    && (
      provisionalAcceptedOrderBaseline === null
      || job.serverAcceptedOrder === undefined
      || job.serverAcceptedOrder > provisionalAcceptedOrderBaseline
    )
  ));
  const hasCurrentCoverageGate = [...handoffRetryAfterRevisionRef.current.values()]
    .some((gate) => (
      gate.connectionGeneration === server.connectionGeneration
      && gate.mode === "coverage"
    ));
  const retainsResolvedReleaseProjection = releasedTargets.length > 0
    && lastStableServerSummaryRef.current?.connectionGeneration
      === server.connectionGeneration
    && (server.status === "loading" || server.status === "error");
  const retainsLastStableServerSummary = (
    server.status === "loading"
    && (hasCurrentCoverageGate || provisionalSummaryJobs.length > 0)
  ) || retainsResolvedReleaseProjection;
  const retainedServerSummary = server.summary ?? (
    retainsLastStableServerSummary
      ? lastStableServerSummaryRef.current?.summary ?? null
      : null
  );
  const retainedServerRevision = server.summary !== null
    ? server.revision
    : retainsLastStableServerSummary
      ? lastStableServerSummaryRef.current?.revision ?? null
      : null;
  const releasedSummaries = releasedServerSummariesForTargets({
    hasRetainedServerBaseline,
    serverItems: server.items,
    retainedServerRevision
  }, new Map(releasedTargets));
  const effectiveServerSummary = retainedServerSummary
    ? withoutReleasedServerSummaries(
        retainedServerSummary,
        releasedSummaries
      )
    : null;
  const serverTotal = effectiveServerSummary?.total ?? 0;
  const totalItems = localJobs.length
    + provisionalSummaryJobs.length
    + serverTotal;
  const totalItemsRef = useRef(totalItems);
  totalItemsRef.current = totalItems;
  const resolvedReleaseProjectionContextRef = useRef<
    ResolvedReleaseProjectionContext
  >({
    hasRetainedServerBaseline,
    serverItems: server.items,
    retainedServerSummary,
    retainedServerRevision,
    localJobs,
    provisionalSummaryJobs
  });
  resolvedReleaseProjectionContextRef.current = {
    hasRetainedServerBaseline,
    serverItems: server.items,
    retainedServerSummary,
    retainedServerRevision,
    localJobs,
    provisionalSummaryJobs
  };

  const reportDraftError = useCallback((
    message: string,
    retryable = true
  ) => {
    setDraftNotice({ message, retryable });
  }, []);
  const reportRecoverableStatusError = useCallback((
    message: string,
    retryable = true
  ) => {
    setStatusNotice({ message, retryable });
  }, []);

  const draftSync = useStoredIngestionDraftSync({
    jobsRef,
    dispatch,
    server,
    reportError: reportDraftError,
    observeCompletedIngestions
  });
  const promoteReconnectOwners = useCallback((
    pairKeys: ReadonlySet<string>
  ) => {
    const promoted = new Set<string>();
    let changed = false;
    for (const pairKey of pairKeys) {
      const detached = detachedProvisionalHandoffsRef.current.get(pairKey);
      const candidate = detached?.job
        ?? handoffJobsRef.current.get(pairKey)
        ?? jobsRef.current.find((job) => (
          serverIngestionJobPairKey(job) === pairKey
        ));
      if (!candidate) continue;
      handoffJobsRef.current.set(pairKey, {
        ...candidate,
        file: undefined,
        objectUrl: undefined,
        preview: candidate.preview?.startsWith("blob:")
          ? ""
          : candidate.preview,
        previewFull: candidate.previewFull?.startsWith("blob:")
          ? undefined
          : candidate.previewFull,
        uploadIntentItemInput: undefined,
        importAcceptItemInput: undefined,
        duplicates: []
      });
      detachedProvisionalHandoffsRef.current.delete(pairKey);
      handoffRetryAfterRevisionRef.current.delete(pairKey);
      promoted.add(pairKey);
      changed = true;
    }
    if (changed) setHandoffEpoch((current) => current + 1);
    return promoted;
  }, []);
  const handoffs = useIngestionAuthorityHandoffs({
    jobs: state.jobs,
    jobsRef,
    dispatch,
    server,
    reportError: reportRecoverableStatusError,
    promoteReconnectOwners,
    observeCompletedIngestions
  });
  const activeDraftNotice = draftNotice && (
    !draftNotice.retryable || draftSync.hasRetryableUpdates()
  ) ? draftNotice : null;
  const serverNoticeState = activeDraftNotice?.retryable
    ? activeDraftNotice
    : statusNotice?.retryable
      ? statusNotice
      : activeDraftNotice ?? statusNotice;

  useEffect(() => () => {
    const jobs = new Set([
      ...jobsRef.current,
      ...handoffJobsRef.current.values()
    ]);
    jobs.forEach(revokeObjectUrl);
    handoffJobsRef.current.clear();
    detachedProvisionalHandoffsRef.current.clear();
    handoffRetryAfterRevisionRef.current.clear();
    completedHandoffPairsRef.current.clear();
    completedReceiptHydrationsRef.current.clear();
    resolvedReleaseTargetsRef.current.clear();
    failedResolvedReleaseRecoveriesRef.current.clear();
  }, []);
  useEffect(() => {
    if (server.status === "idle") {
      if (
        !resolvedReleaseTargetsRef.current.size
        && !failedResolvedReleaseRecoveriesRef.current.size
      ) return;
      resolvedReleaseTargetsRef.current.clear();
      failedResolvedReleaseRecoveriesRef.current.clear();
      setResolvedReleaseEpoch((current) => current + 1);
      return;
    }
    if (server.status !== "ready") {
      for (const [pairKey, failed] of (
        failedResolvedReleaseRecoveriesRef.current
      )) {
        if (resolvedReleaseTargetsRef.current.get(pairKey) !== failed.target) {
          failedResolvedReleaseRecoveriesRef.current.delete(pairKey);
          continue;
        }
        failed.observedNonReady = true;
      }
      return;
    }
    let changed = false;
    for (const [pairKey, failed] of (
      failedResolvedReleaseRecoveriesRef.current
    )) {
      if (resolvedReleaseTargetsRef.current.get(pairKey) !== failed.target) {
        failedResolvedReleaseRecoveriesRef.current.delete(pairKey);
        continue;
      }
      if (!failed.observedNonReady) continue;
      resolvedReleaseTargetsRef.current.delete(pairKey);
      failedResolvedReleaseRecoveriesRef.current.delete(pairKey);
      changed = true;
    }
    if (changed) setResolvedReleaseEpoch((current) => current + 1);
  }, [resolvedReleaseEpoch, server.status]);
  useEffect(() => {
    if (server.status !== "ready") return;
    observeCompletedIngestions(server.items.flatMap((item) => (
      item.status === "completed"
        ? [{
            pair: item,
            item: item.completed_item,
            ...(item.display ? { display: item.display } : {}),
            serverVersion: item.version,
            serverSemanticRevision: item.last_semantic_revision,
            completedAt: item.completed_at
          }]
        : []
    )));
  }, [observeCompletedIngestions, server.items, server.status]);
  useEffect(() => {
    if (completedInvalidation.isQueueIdle()) {
      scheduleCompletedIngestionInvalidation();
    }
  }, [
    handoffEpoch,
    scheduleCompletedIngestionInvalidation,
    server.status,
    server.summary?.committing,
    server.summary?.resolving
  ]);
  useEffect(() => {
    if (!displayed) {
      void flushCompletedIngestionInvalidations().catch(() => undefined);
    }
  }, [displayed, flushCompletedIngestionInvalidations]);
  useEffect(() => () => {
    completedInvalidation.setQueueIdle(false);
    void flushCompletedIngestionInvalidations().catch(() => undefined);
  }, [flushCompletedIngestionInvalidations]);
  useEffect(() => {
    if (server.status !== "ready") return;
    dispatch({
      type: "set-page",
      page: stateRef.current.page,
      pageSize,
      totalItems: totalItemsRef.current
    });
  }, [dispatch, pageSize, server.status, totalItems]);

  useEffect(() => {
    let existingServerJobs = stateRef.current.jobs.filter(
      ingestionJobHasServerAuthority
    );
    if (server.status !== "ready") {
      const reconnecting = server.connectionGeneration
        !== lastReadyGenerationRef.current;
      if (reconnecting) {
        setStatusNotice(null);
      }
      const retainedVisibleHandoffs: IngestionJob[] = [];
      let handoffChanged = false;
      for (const job of existingServerJobs) {
        const pairKey = serverIngestionJobPairKey(job);
        const retainVisible = pairKey
          && !ingestionJobHasBrowserDisplayOrder(job)
          && job.serverHandoffDisplayPage === stateRef.current.page
          && serverDisplayLimit > retainedVisibleHandoffs.length;
        if (retainVisible) retainedVisibleHandoffs.push(job);
        if (
          pairKey
          && (
            reconnecting
            ||
            job.file
            || job.objectUrl
            || job.uploadIntentItemInput
            || job.importAcceptItemInput
            || job.commitIntent
          )
        ) {
          if (job.serverDraftPending === true) {
            draftSync.ensureJobSnapshot(job);
          }
          if (
            !completedHandoffPairsRef.current.has(pairKey)
            && handoffJobsRef.current.get(pairKey) !== job
          ) {
            handoffJobsRef.current.set(pairKey, job);
            handoffChanged = true;
          }
        } else if (
          !retainVisible
          && !hasRetainedServerBaseline
          && !ingestionJobHasBrowserDisplayOrder(job)
        ) {
          revokeObjectUrl(job);
        }
      }
      if (handoffChanged) setHandoffEpoch((current) => current + 1);
      if (existingServerJobs.length && !hasRetainedServerBaseline) {
        dispatch({
          type: "replace-server-page",
          jobs: retainedVisibleHandoffs
        });
      }
      return;
    }
    if (server.connectionGeneration !== lastReadyGenerationRef.current) {
      setStatusNotice(null);
    }
    lastReadyGenerationRef.current = server.connectionGeneration;
    let handoffChanged = false;
    const snapshotStalePairKeys = new Set(
      server.staleItems.map(serverIngestionPairKey)
    );
    const staleSignal = [
      server.connectionGeneration,
      server.revision,
      ...snapshotStalePairKeys
    ].join("\u0001");
    const stalePairKeys = staleSignal !== handledStaleSnapshotRef.current
      ? snapshotStalePairKeys
      : new Set<string>();
    if (stalePairKeys.size) {
      handledStaleSnapshotRef.current = staleSignal;
      const objectUrls = new Set<string>();
      const collectObjectUrl = (job: IngestionJob | undefined) => {
        if (job?.objectUrl?.startsWith("blob:")) objectUrls.add(job.objectUrl);
      };
      for (const job of stateRef.current.jobs) {
        if (stalePairKeys.has(serverIngestionJobPairKey(job))) {
          collectObjectUrl(job);
        }
      }
      for (const pairKey of stalePairKeys) {
        collectObjectUrl(handoffJobsRef.current.get(pairKey));
        collectObjectUrl(
          detachedProvisionalHandoffsRef.current.get(pairKey)?.job
        );
        handoffJobsRef.current.delete(pairKey);
        detachedProvisionalHandoffsRef.current.delete(pairKey);
        handoffRetryAfterRevisionRef.current.delete(pairKey);
        completedHandoffPairsRef.current.delete(pairKey);
        completedReceiptHydrationsRef.current.delete(pairKey);
      }
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
      handoffs.resolvePairs(stalePairKeys);
      draftSync.retirePairOwners(stalePairKeys);
      existingServerJobs = existingServerJobs.filter((job) => (
        !stalePairKeys.has(serverIngestionJobPairKey(job))
      ));
      handoffChanged = true;
    }
    for (const [pairKey, entry] of detachedProvisionalHandoffsRef.current) {
      if (
        entry.connectionGeneration !== server.connectionGeneration
        || server.lastAcceptedOrder !== null
          && entry.job.serverAcceptedOrder !== undefined
          && entry.job.serverAcceptedOrder <= server.lastAcceptedOrder
      ) {
        detachedProvisionalHandoffsRef.current.delete(pairKey);
        handoffChanged = true;
      }
    }

    const existingByPair = new Map<string, IngestionJob>();
    for (const job of stateRef.current.jobs) {
      const pairKey = serverIngestionJobPairKey(job);
      if (
        pairKey
        && !stalePairKeys.has(pairKey)
        && (
          !existingByPair.has(pairKey)
          || !ingestionJobHasServerAuthority(job)
        )
      ) existingByPair.set(pairKey, job);
    }
    for (const [pairKey, job] of handoffJobsRef.current) {
      if (!existingByPair.has(pairKey)) existingByPair.set(pairKey, job);
    }
    const hydratedHandoffPairs = new Set<string>();
    let retainedServerDisplayItems = 0;
    const stateServerItems = snapshotItems.filter((item) => {
      if (acceptedDisplayPairs.has(serverIngestionPairKey(item))) return true;
      if (retainedServerDisplayItems >= serverDisplayLimit) return false;
      retainedServerDisplayItems += 1;
      return true;
    });
    const stateServerPairs = new Set(stateServerItems.map(serverIngestionPairKey));
    const resolveCoveredHandoff = (pairKey: string) => {
      const gate = handoffRetryAfterRevisionRef.current.get(pairKey);
      if (
        handoffs.hasExternalPair(pairKey)
        && (
          gate?.connectionGeneration !== server.connectionGeneration
          || gate.mode !== "coverage"
          || server.revision === null
          || server.revision < gate.revision
        )
      ) return;
      if (!handoffJobsRef.current.delete(pairKey)) return;
      handoffRetryAfterRevisionRef.current.delete(pairKey);
      detachedProvisionalHandoffsRef.current.delete(pairKey);
      completedHandoffPairsRef.current.delete(pairKey);
      completedReceiptHydrationsRef.current.delete(pairKey);
      handoffChanged = true;
      hydratedHandoffPairs.add(pairKey);
    };
    const nextServerJobs = stateServerItems.map((item) => {
      const pairKey = serverIngestionPairKey(item);
      const existing = existingByPair.get(pairKey);
      const next = ingestionJobFromServerItem(item, existing, server.revision);
      if (
        existing?.objectUrl?.startsWith("blob:")
        && !next.objectUrl?.startsWith("blob:")
      ) URL.revokeObjectURL(existing.objectUrl);
      const awaitsCompleted = completedHandoffPairsRef.current.has(pairKey);
      if (awaitsCompleted && item.status !== "completed") {
        handoffRetryAfterRevisionRef.current.set(pairKey, {
          connectionGeneration: server.connectionGeneration,
          revision: Math.max(
            server.revision ?? 0,
            item.last_semantic_revision
          ),
          mode: "state-change"
        });
      } else {
        resolveCoveredHandoff(pairKey);
      }
      return next;
    });
    for (const item of snapshotItems) {
      const pairKey = serverIngestionPairKey(item);
      if (stateServerPairs.has(pairKey)) continue;
      if (
        completedHandoffPairsRef.current.has(pairKey)
        && item.status !== "completed"
      ) {
        handoffRetryAfterRevisionRef.current.set(pairKey, {
          connectionGeneration: server.connectionGeneration,
          revision: Math.max(
            server.revision ?? 0,
            item.last_semantic_revision
          ),
          mode: "state-change"
        });
        continue;
      }
      // A required/include item can prove this handoff even when browser-owned
      // cards consume every slot on the composed page. It does not need to be
      // rendered to discharge the current-generation coverage fence.
      resolveCoveredHandoff(pairKey);
    }
    const nextPairs = stateServerPairs;
    const retainedVisibleHandoffs: IngestionJob[] = [];
    for (const job of existingServerJobs) {
      const pairKey = serverIngestionJobPairKey(job);
      if (!pairKey || nextPairs.has(pairKey)) continue;
      if (ingestionJobHasBrowserDisplayOrder(job)) continue;
      if (
        job.serverHandoffPending === true
        && job.serverHandoffDisplayPage === stateRef.current.page
        && retainedVisibleHandoffs.length < serverDisplayLimit
      ) {
        retainedVisibleHandoffs.push(job);
        continue;
      }
      // The pair is authoritative but no longer belongs to this bounded
      // page. Release any handoff-only browser preview instead of retaining
      // an off-page Server DTO or Blob URL in the owner.
      revokeObjectUrl(job);
      const needsCompletedHydration =
        completedHandoffPairsRef.current.has(pairKey);
      if (
        !needsCompletedHydration
        && !handoffs.hasExternalPair(pairKey)
        && handoffJobsRef.current.delete(pairKey)
      ) {
        handoffRetryAfterRevisionRef.current.delete(pairKey);
        completedHandoffPairsRef.current.delete(pairKey);
        handoffChanged = true;
      }
    }
    dispatch({
      type: "replace-server-page",
      jobs: [...retainedVisibleHandoffs, ...nextServerJobs],
      stalePairKeys
    });
    if (hydratedHandoffPairs.size) {
      handoffs.resolveExternalStatuses(hydratedHandoffPairs);
    }
    if (handoffChanged) setHandoffEpoch((current) => current + 1);
  }, [
    dispatch,
    acceptedDisplayPairsKey,
    draftSync.ensureJobSnapshot,
    draftSync.retirePairOwners,
    handoffs.resolvePairs,
    handoffs.resolveExternalStatuses,
    handoffs.hasExternalPair,
    handoffEpoch,
    server.connectionGeneration,
    snapshotItems,
    server.revision,
    server.staleItems,
    server.status,
    serverDisplayLimit,
    hasRetainedServerBaseline
  ]);

  useEffect(() => {
    if (server.status !== "ready") return;
    const snapshotPairs = new Set(snapshotItems.map(serverIngestionPairKey));
    const staleVisibleHandoffs = currentServerJobs.filter((job) => (
      job.serverHandoffDisplayPage !== undefined
      && !ingestionJobHasBrowserDisplayOrder(job)
      && job.serverHandoffPending !== true
      && !snapshotPairs.has(serverIngestionJobPairKey(job))
    ));
    if (!staleVisibleHandoffs.length) return;
    const staleIds = new Set(staleVisibleHandoffs.map((job) => job.id));
    staleVisibleHandoffs.forEach(revokeObjectUrl);
    dispatch({
      type: "replace-server-page",
      jobs: currentServerJobs.filter((job) => !staleIds.has(job.id))
    });
  }, [currentServerJobs, dispatch, snapshotItems, server.status]);

  useEffect(() => {
    if (server.status !== "ready" || server.revision === null) return;
    let retry = false;
    const coveredExternalPairs = new Set<string>();
    const snapshotPairs = new Set(snapshotItems.map(serverIngestionPairKey));
    for (const [pairKey, gate] of handoffRetryAfterRevisionRef.current) {
      if (gate.connectionGeneration !== server.connectionGeneration) {
        handoffRetryAfterRevisionRef.current.delete(pairKey);
        retry = handoffJobsRef.current.has(pairKey) || retry;
        continue;
      }
      if (
        gate.mode === "state-change"
        && server.revision > gate.revision
        && handoffJobsRef.current.has(pairKey)
      ) {
        handoffRetryAfterRevisionRef.current.delete(pairKey);
        retry = true;
        continue;
      }
      if (
        gate.mode === "coverage"
        && server.revision >= gate.revision
        && !snapshotPairs.has(pairKey)
      ) {
        handoffRetryAfterRevisionRef.current.delete(pairKey);
        const job = handoffJobsRef.current.get(pairKey);
        if (!job) continue;
        handoffJobsRef.current.delete(pairKey);
        detachedProvisionalHandoffsRef.current.delete(pairKey);
        completedHandoffPairsRef.current.delete(pairKey);
        completedReceiptHydrationsRef.current.delete(pairKey);
        revokeObjectUrl(job);
        coveredExternalPairs.add(pairKey);
      }
    }
    if (coveredExternalPairs.size) {
      const currentServerJobs = stateRef.current.jobs
        .filter(ingestionJobHasServerAuthority);
      currentServerJobs
        .filter((job) => coveredExternalPairs.has(serverIngestionJobPairKey(job)))
        .forEach(revokeObjectUrl);
      const retainedServerJobs = currentServerJobs.filter(
        (job) => !coveredExternalPairs.has(serverIngestionJobPairKey(job))
      );
      dispatch({ type: "replace-server-page", jobs: retainedServerJobs });
      handoffs.resolveExternalStatuses(coveredExternalPairs);
    }
    if (retry || coveredExternalPairs.size) {
      setHandoffEpoch((current) => current + 1);
    }
  }, [
    dispatch,
    handoffEpoch,
    handoffs.resolveExternalStatuses,
    server.connectionGeneration,
    snapshotItems,
    server.revision,
    server.status
  ]);

  const bumpHandoffEpoch = useCallback(() => {
    setHandoffEpoch((current) => current + 1);
  }, []);
  useIngestionStatusHydration({
    server,
    serverConnectionRef,
    handoffJobsRef,
    retryGatesRef: handoffRetryAfterRevisionRef,
    detachedHandoffsRef: detachedProvisionalHandoffsRef,
    completedPairsRef: completedHandoffPairsRef,
    completedReceiptHydrationsRef,
    jobsRef,
    dispatch,
    ensureDraftSnapshot: draftSync.ensureJobSnapshot,
    retireDraftPairs: draftSync.retirePairOwners,
    resolveExternalStatuses: handoffs.resolveExternalStatuses,
    verifyExternalStatusRevisions: handoffs.verifyExternalStatusRevisions,
    observeCompletedIngestions,
    handoffEpoch,
    statusRetryEpoch,
    bumpHandoffEpoch,
    reportError: reportRecoverableStatusError,
    revokeObjectUrl
  });

  const retryServerNotice = useCallback(() => {
    setDraftNotice(null);
    setStatusNotice(null);
    setStatusRetryEpoch((current) => current + 1);
    handoffs.retry();
    void draftSync.retryPendingUpdates();
    server.refresh();
  }, [draftSync.retryPendingUpdates, handoffs.retry, server.refresh]);

  const appendJobs = useCallback((jobs: IngestionJob[]) => {
    if (!jobs.length) return true;
    const browserOwned = browserDisplayPrefixJobs([
      ...jobs,
      ...stateRef.current.jobs
    ]);
    if (browserOwned.length > ingestionBatchHardLimit) return false;
    dispatch({ type: "append", jobs });
    return true;
  }, [dispatch]);

  const captureBrowserActionJobs = useCallback((
    predicate: (job: IngestionJob) => boolean
  ) => {
    const serverRevision = serverConnectionRef.current.revision;
    const candidates = [
      ...stateRef.current.jobs,
      ...handoffJobsRef.current.values(),
      ...[...detachedProvisionalHandoffsRef.current.values()].map(
        ({ job }) => job
      )
    ];
    const captured: IngestionJob[] = [];
    const owners = new Set<string>();
    for (const job of candidates) {
      if (
        ingestionJobHasServerAuthority(job)
        && !ingestionJobAwaitsActionCoverage(job, serverRevision)
      ) continue;
      if (!predicate(job)) continue;
      const pairKey = serverIngestionJobPairKey(job);
      const ownerKey = pairKey || `${job.id}\0${job.attemptKey}`;
      if (owners.has(ownerKey)) continue;
      owners.add(ownerKey);
      captured.push(job);
    }
    return captured;
  }, []);

  const updateJob = useCallback((id: string, patch: Partial<IngestionJob>) => {
    dispatch({ type: "patch", id, patch });
  }, [dispatch]);

  const bindServerJob = useCallback((
    id: string,
    binding: IngestionServerBinding,
    requestConnectionGeneration?: number | null,
    acceptedOrder?: number
  ) => {
    const serverAtBinding = serverConnectionRef.current;
    const requestGeneration = requestConnectionGeneration === undefined
      ? serverAtBinding.connectionGeneration
      : requestConnectionGeneration;
    const requiresCompletedStatusHydration =
      binding.serverHandoffPending === true
      && binding.serverHandoffRevision === undefined
      && binding.status === "finalized"
      && binding.resultState === "recovering";
    const requiresGenerationStatusHydration =
      binding.serverHandoffPending === true
      && (
        requestGeneration === null
        || requestGeneration !== serverAtBinding.connectionGeneration
      );
    const externalStatusOwner = requiresCompletedStatusHydration
      || requiresGenerationStatusHydration;
    const effectiveBinding = handoffs.prepareBinding(
      binding,
      requestConnectionGeneration,
      externalStatusOwner
    );
    const currentState = stateRef.current;
    const current = currentState.jobs.find((job) => job.id === id);
    const currentDisplayJobs = browserDisplayPrefixJobs(currentState.jobs);
    const displayIndex = currentDisplayJobs.findIndex((job) => job.id === id);
    const displayPageStart = (currentState.page - 1) * pageSize;
    const wasVisibleBrowserCard = displayIndex >= displayPageStart
      && displayIndex < displayPageStart + pageSize;
    const lastCoveredAcceptedOrder = serverAtBinding.status === "ready"
      ? serverAtBinding.lastAcceptedOrder
      : lastStableServerSummaryRef.current?.lastAcceptedOrder ?? null;
    const tracksCanonicalOutsideSnapshot =
      effectiveBinding.serverHandoffPending === true
      && acceptedOrder !== undefined
      && (
        lastCoveredAcceptedOrder === null
        || acceptedOrder > lastCoveredAcceptedOrder
      );
    const visibleBinding: IngestionServerBinding = {
      ...effectiveBinding,
      ...(acceptedOrder === undefined ? {} : {
        serverAcceptedOrder: acceptedOrder
      }),
      serverHandoffDisplayPage: effectiveBinding.serverHandoffPending === true
        ? current?.serverHandoffDisplayPage
          ?? (wasVisibleBrowserCard ? currentState.page : undefined)
        : undefined,
      serverHandoffProvisionalTotal: tracksCanonicalOutsideSnapshot
        ? true
        : undefined
    };
    const pair = serverIngestionPairKey({
      session_id: visibleBinding.sessionId,
      image_id: visibleBinding.imageId
    });
    const staleIncarnationPairs = new Set<string>();
    const includeStalePair = (pairKey: string) => {
      if (
        pairKey !== pair
        && ingestionPairBelongsToSession(pairKey, visibleBinding.sessionId)
      ) staleIncarnationPairs.add(pairKey);
    };
    for (const job of stateRef.current.jobs) {
      if (ingestionJobHasServerAuthority(job)) {
        includeStalePair(serverIngestionJobPairKey(job));
      }
    }
    for (const pairKey of handoffJobsRef.current.keys()) {
      includeStalePair(pairKey);
    }
    for (const pairKey of detachedProvisionalHandoffsRef.current.keys()) {
      includeStalePair(pairKey);
    }
    for (const pairKey of handoffRetryAfterRevisionRef.current.keys()) {
      includeStalePair(pairKey);
    }
    for (const pairKey of completedHandoffPairsRef.current) {
      includeStalePair(pairKey);
    }
    for (const pairKey of handoffs.pairKeysForSession(
      visibleBinding.sessionId
    )) includeStalePair(pairKey);
    for (const pairKey of draftSync.pairKeysForSession(
      visibleBinding.sessionId
    )) includeStalePair(pairKey);

    if (staleIncarnationPairs.size) {
      const staleObjectUrls = new Set<string>();
      const collectObjectUrl = (job: IngestionJob | undefined) => {
        if (job?.objectUrl?.startsWith("blob:")) {
          staleObjectUrls.add(job.objectUrl);
        }
      };
      for (const job of stateRef.current.jobs) {
        if (staleIncarnationPairs.has(serverIngestionJobPairKey(job))) {
          collectObjectUrl(job);
        }
      }
      for (const pairKey of staleIncarnationPairs) {
        collectObjectUrl(handoffJobsRef.current.get(pairKey));
        collectObjectUrl(
          detachedProvisionalHandoffsRef.current.get(pairKey)?.job
        );
        handoffJobsRef.current.delete(pairKey);
        detachedProvisionalHandoffsRef.current.delete(pairKey);
        handoffRetryAfterRevisionRef.current.delete(pairKey);
        completedHandoffPairsRef.current.delete(pairKey);
        completedReceiptHydrationsRef.current.delete(pairKey);
      }
      for (const objectUrl of staleObjectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
      handoffs.resolvePairs(staleIncarnationPairs);
      setHandoffEpoch((value) => value + 1);
    }
    const canonical = jobsRef.current.find((job) => (
      job.id !== id
      && ingestionJobHasServerAuthority(job)
      && serverIngestionJobPairKey(job) === pair
    ));
    if (
      current?.objectUrl?.startsWith("blob:")
      && canonical
      && (canonical.md5 || canonical.preview)
    ) URL.revokeObjectURL(current.objectUrl);
    dispatch({ type: "bind-server", id, binding: visibleBinding });
    draftSync.retirePairOwners(staleIncarnationPairs);
    const bound = jobsRef.current.find((job) => job.id === id);
    if (bound && tracksCanonicalOutsideSnapshot) {
      detachedProvisionalHandoffsRef.current.set(pair, {
        connectionGeneration: serverAtBinding.connectionGeneration,
        job: {
          ...bound,
          file: undefined,
          objectUrl: undefined,
          preview: bound.preview?.startsWith("blob:") ? "" : bound.preview,
          previewFull: bound.previewFull?.startsWith("blob:")
            ? undefined
            : bound.previewFull,
          uploadIntentItemInput: undefined,
          importAcceptItemInput: undefined,
          duplicates: []
        }
      });
      setHandoffEpoch((value) => value + 1);
    }
    if (bound && externalStatusOwner) {
      handoffRetryAfterRevisionRef.current.delete(pair);
      if (requiresCompletedStatusHydration) {
        completedHandoffPairsRef.current.add(pair);
      }
      handoffJobsRef.current.set(pair, {
        ...bound,
        file: undefined,
        objectUrl: undefined,
        preview: bound.preview?.startsWith("blob:") ? "" : bound.preview,
        previewFull: bound.previewFull?.startsWith("blob:")
          ? undefined
          : bound.previewFull
      });
      setHandoffEpoch((value) => value + 1);
    }
    const snapshotHasPair = serverItemsRef.current.some(
      (item) => serverIngestionPairKey(item) === pair
    );
    if (
      current
      && !wasVisibleBrowserCard
      && !canonical
      && !snapshotHasPair
      && bound
      && ingestionJobHasServerAuthority(bound)
    ) {
      // A covered response can bind an item outside the current combined
      // page without changing serverLimit. Move any pending draft into its
      // detached owner, then release browser-only bytes immediately instead
      // of waiting for an unrelated snapshot/render to notice the DTO.
      if (bound.serverDraftPending === true) {
        draftSync.ensureJobSnapshot(bound);
      }
      revokeObjectUrl(bound);
      if (ingestionJobHasBrowserDisplayOrder(bound)) {
        dispatch({
          type: "patch",
          id: bound.id,
          patch: {
            file: undefined,
            objectUrl: undefined,
            preview: bound.preview?.startsWith("blob:") ? "" : bound.preview,
            previewFull: bound.previewFull?.startsWith("blob:")
              ? undefined
              : bound.previewFull,
            uploadIntentItemInput: undefined,
            importAcceptItemInput: undefined,
            duplicates: []
          }
        });
        if (bound.serverDraftPending === true) draftSync.scheduleJob(bound.id);
        return;
      }
      dispatch({
        type: "replace-server-page",
        jobs: jobsRef.current.filter((job) => (
          ingestionJobHasServerAuthority(job)
          && serverIngestionJobPairKey(job) !== pair
        ))
      });
      return;
    }
    if (bound?.serverDraftPending === true) draftSync.scheduleJob(id);
  }, [
    dispatch,
    draftSync.ensureJobSnapshot,
    draftSync.pairKeysForSession,
    draftSync.retirePairOwners,
    draftSync.scheduleJob,
    handoffs.pairKeysForSession,
    handoffs.prepareBinding,
    handoffs.resolvePairs,
    pageSize
  ]);

  const updateJobs = useCallback((
    patches: ReadonlyMap<string, Partial<IngestionJob>>
  ) => {
    if (patches.size) dispatch({ type: "patch-many", patches });
  }, [dispatch]);

  const releaseJob = useCallback((job: IngestionJob) => {
    // 本地预览 URL 由前端创建，任务离队时必须释放；服务端 preview_url 不需要 revoke。
    revokeObjectUrl(job);
  }, []);

  const removeJob = useCallback((id: string) => {
    const job = jobsRef.current.find((item) => item.id === id);
    if (!job || !ingestionJobCanLeaveQueue(job)) return false;
    releaseJob(job);
    dispatch({
      type: "remove",
      ids: new Set([id]),
      pageSize,
      totalItems: totalItemsRef.current
    });
    return true;
  }, [dispatch, pageSize, releaseJob]);

  const clearJobIds = useCallback((ids: ReadonlySet<string>) => {
    const removed = jobsRef.current.filter((job) => (
      ids.has(job.id) && ingestionJobCanLeaveQueue(job)
    ));
    removed.forEach(releaseJob);
    dispatch({
      type: "remove",
      ids: new Set(removed.map((job) => job.id)),
      pageSize,
      totalItems: totalItemsRef.current
    });
  }, [dispatch, pageSize, releaseJob]);

  const removeLibraryDuplicate = useCallback((imageId: string) => {
    const md5 = jobsRef.current
      .flatMap((job) => job.duplicates)
      .find((duplicate) => duplicate.id === imageId)?.md5;
    if (md5) invalidateIngestionDuplicateDetails(md5);
  }, []);

  const applyDefaultsToLocalJobs = useCallback((
    defaults: IngestionAttributeDefaults,
    jobs: readonly Pick<IngestionJob, "id" | "attemptKey">[]
  ) => {
    dispatch({
      type: "apply-defaults",
      defaults,
      attempts: new Map(jobs.map((job) => [job.id, job.attemptKey]))
    });
  }, [dispatch]);

  const setPage = useCallback((next: number | ((current: number) => number)) => {
    const page = typeof next === "function" ? next(stateRef.current.page) : next;
    dispatch({
      type: "set-page",
      page,
      pageSize,
      totalItems: totalItemsRef.current
    });
  }, [dispatch, pageSize]);

  const projectResolvedServerJobs = useCallback((
    targets: readonly ResolvedServerJobTarget[],
    authoritativePairKeys: ReadonlySet<string> = new Set()
  ) => {
    const resolved = new Set<string>();
    const releasedPairs = new Map<string, ResolvedServerJobTarget>();
    for (const target of targets) {
      const pairKey = serverIngestionPairKey(target.pair);
      const handoff = handoffJobsRef.current.get(pairKey);
      const detached = detachedProvisionalHandoffsRef.current.get(pairKey)?.job;
      const candidates = new Set([
        ...stateRef.current.jobs.filter((job) => (
          job.id === target.id
          || ingestionJobHasServerAuthority(job)
            && serverIngestionJobPairKey(job) === pairKey
        )),
        ...(handoff ? [handoff] : []),
        ...(detached ? [detached] : [])
      ]);
      const pairHasIdentityFreeOwner =
        handoffRetryAfterRevisionRef.current.has(pairKey)
        || completedHandoffPairsRef.current.has(pairKey)
        || handoffs.hasPair(pairKey);
      if (
        !authoritativePairKeys.has(pairKey)
        && (
          [...candidates].some((job) => (
            !ingestionJobMatchesResolvedServerTarget(job, target)
          ))
          || !candidates.size && pairHasIdentityFreeOwner
        )
      ) continue;
      resolved.add(target.id);
      releasedPairs.set(pairKey, target);
    }
    if (!releasedPairs.size) return { resolved, releasedPairs };

    const projectedTotalItems = projectedTotalAfterResolvedRelease(
      resolvedReleaseProjectionContextRef.current,
      resolvedReleaseTargetsRef.current,
      releasedPairs
    );

    for (const [pairKey, target] of releasedPairs) {
      resolvedReleaseTargetsRef.current.set(pairKey, target);
      failedResolvedReleaseRecoveriesRef.current.delete(pairKey);
    }

    const removedStateTargets = new Map<string, {
      attemptKey: string;
      pairKey: string;
    }>();
    for (const job of stateRef.current.jobs) {
      const pairKey = serverIngestionJobPairKey(job);
      const target = releasedPairs.get(pairKey);
      if (
        target
        && (
          authoritativePairKeys.has(pairKey)
          || ingestionJobMatchesResolvedServerTarget(job, target)
        )
      ) {
        removedStateTargets.set(job.id, {
          attemptKey: job.attemptKey,
          pairKey
        });
        revokeObjectUrl(job);
      }
    }
    for (const pairKey of releasedPairs.keys()) {
      const handoff = handoffJobsRef.current.get(pairKey);
      const detached = detachedProvisionalHandoffsRef.current.get(pairKey)?.job;
      if (handoff) revokeObjectUrl(handoff);
      if (detached && detached !== handoff) revokeObjectUrl(detached);
      handoffJobsRef.current.delete(pairKey);
      detachedProvisionalHandoffsRef.current.delete(pairKey);
      handoffRetryAfterRevisionRef.current.delete(pairKey);
      completedHandoffPairsRef.current.delete(pairKey);
      completedReceiptHydrationsRef.current.delete(pairKey);
    }
    handoffs.resolvePairs(new Set(releasedPairs.keys()));
    dispatch({
      type: "release-resolved",
      targets: removedStateTargets,
      pageSize,
      projectedTotalItems
    });
    setHandoffEpoch((current) => current + 1);
    setResolvedReleaseEpoch((current) => current + 1);
    return { resolved, releasedPairs };
  }, [
    dispatch,
    handoffs.hasPair,
    handoffs.resolvePairs,
    pageSize
  ]);

  const trackResolvedReleaseRecovery = useCallback((
    recoveryTargets: ReadonlyMap<string, ResolvedServerJobTarget>,
    recovery: Promise<void>
  ) => {
    void recovery.then(() => {
      let changed = false;
      for (const [pairKey, target] of recoveryTargets) {
        if (resolvedReleaseTargetsRef.current.get(pairKey) !== target) continue;
        resolvedReleaseTargetsRef.current.delete(pairKey);
        const failed = failedResolvedReleaseRecoveriesRef.current.get(pairKey);
        if (failed?.target === target) {
          failedResolvedReleaseRecoveriesRef.current.delete(pairKey);
        }
        changed = true;
      }
      if (changed) setResolvedReleaseEpoch((current) => current + 1);
    }).catch(() => {
      let changed = false;
      for (const [pairKey, target] of recoveryTargets) {
        if (resolvedReleaseTargetsRef.current.get(pairKey) !== target) continue;
        failedResolvedReleaseRecoveriesRef.current.set(pairKey, {
          target,
          observedNonReady: false
        });
        changed = true;
      }
      if (changed) setResolvedReleaseEpoch((current) => current + 1);
    });
  }, []);

  const releaseResolvedServerJobs = useCallback((
    targets: readonly ResolvedServerJobTarget[]
  ) => {
    const projected = projectResolvedServerJobs(targets);
    if (projected.releasedPairs.size) {
      trackResolvedReleaseRecovery(
        new Map(projected.releasedPairs),
        server.recoverAuthority()
      );
    }
    return projected.resolved;
  }, [
    projectResolvedServerJobs,
    server.recoverAuthority,
    trackResolvedReleaseRecovery
  ]);

  const successfulActionItems = useCallback((
    result: IngestionQueueActionResultDto
  ) => new Map(result.items.flatMap((item) => (
    item.status === "changed" || item.status === "unchanged"
      ? [[serverIngestionPairKey(item), item] as const]
      : []
  ))), []);

  const projectCompletedCleanupBatch = useCallback((
    result: IngestionQueueActionResultDto
  ) => {
    const releasedItems = successfulActionItems(result);
    if (!releasedItems.size) return 0;
    const targets: ResolvedServerJobTarget[] = [];
    for (const [pairKey, item] of releasedItems) {
      // A completed result learned through status/commit deliberately hands
      // browser display ownership back by setting serverAccepted=false. The
      // Server action still proves the same pair was cleared, so release every
      // matching current owner shape rather than only canonical DTO jobs.
      const handoff = handoffJobsRef.current.get(pairKey);
      const detached = detachedProvisionalHandoffsRef.current.get(pairKey)?.job;
      const candidates = new Set([
        ...stateRef.current.jobs.filter((job) => (
          serverIngestionJobPairKey(job) === pairKey
        )),
        ...(handoff ? [handoff] : []),
        ...(detached ? [detached] : [])
      ]);
      const owners = candidates.size
        ? [...candidates]
        : [{
            id: item.image_id,
            attemptKey: `completed-cleanup:${item.image_id}`
          }];
      for (const owner of owners) {
        targets.push({
          id: owner.id,
          attemptKey: owner.attemptKey,
          pair: item,
          ...(item.queue_revision === undefined
            ? {}
            : { releasedRevision: item.queue_revision })
        });
      }
    }
    projectResolvedServerJobs(targets, new Set(releasedItems.keys()));
    return releasedItems.size;
  }, [projectResolvedServerJobs, successfulActionItems]);

  const recoverAfterSuccessfulAction = useCallback((
    result: IngestionQueueActionResultDto
  ) => {
    const releasedItems = successfulActionItems(result);
    if (!releasedItems.size) return Promise.resolve();
    // Fence every pre-action snapshot and retain the unaffected bounded raw
    // baseline. Per-batch exact successes have already been projected out of
    // the combined owner, including when a later continuation failed.
    const recovery = server.recoverAfterSuccessfulAction();
    const recoveryTargets = new Map<string, ResolvedServerJobTarget>();
    for (const pairKey of releasedItems.keys()) {
      const target = resolvedReleaseTargetsRef.current.get(pairKey);
      if (target) recoveryTargets.set(pairKey, target);
    }
    if (recoveryTargets.size) {
      trackResolvedReleaseRecovery(recoveryTargets, recovery);
    }
    return recovery;
  }, [
    server.recoverAfterSuccessfulAction,
    successfulActionItems,
    trackResolvedReleaseRecovery
  ]);

  const totalPages = ingestionQueuePageCount(totalItems, pageSize);
  const visibleJobs = useMemo(
    () => [...visibleDisplayPrefixJobs, ...displayedServerJobs],
    [displayedServerJobs, visibleDisplayPrefixJobs]
  );
  const summary = useMemo(() => {
    const local = summarizeIngestionJobs([
      ...localJobs,
      ...provisionalSummaryJobs
    ]);
    const provisionalPairs = new Set(
      provisionalSummaryJobs.map(serverIngestionJobPairKey)
    );
    const currentServer = summarizeIngestionJobs(displayedServerJobs.filter(
      (job) => !provisionalPairs.has(serverIngestionJobPairKey(job))
    ));
    if (!effectiveServerSummary) return {
      ...local,
      readyCount: local.readyCount + currentServer.readyCount,
      unfinishedCount: local.unfinishedCount + currentServer.unfinishedCount,
      duplicateJobs: local.duplicateJobs + currentServer.duplicateJobs,
      waitingJobs: local.waitingJobs + currentServer.waitingJobs,
      runningJobs: local.runningJobs + currentServer.runningJobs,
      commitQueuedJobs: local.commitQueuedJobs + currentServer.commitQueuedJobs,
      committingJobs: local.committingJobs + currentServer.committingJobs,
      finalizedJobs: local.finalizedJobs + currentServer.finalizedJobs,
      doneJobs: local.doneJobs + currentServer.doneJobs,
      failedJobs: local.failedJobs + currentServer.failedJobs
    };
    return {
      ...local,
      readyCount: local.readyCount + effectiveServerSummary.ready,
      unfinishedCount: local.unfinishedCount + effectiveServerSummary.unfinished,
      duplicateJobs: local.duplicateJobs
        + effectiveServerSummary.duplicate_pending,
      waitingJobs: local.waitingJobs + effectiveServerSummary.waiting,
      runningJobs: local.runningJobs + effectiveServerSummary.running,
      commitQueuedJobs: local.commitQueuedJobs,
      committingJobs: local.committingJobs
        + effectiveServerSummary.committing,
      finalizedJobs: local.finalizedJobs + effectiveServerSummary.resolving,
      doneJobs: local.doneJobs + effectiveServerSummary.completed,
      failedJobs: local.failedJobs + effectiveServerSummary.failed
    };
  }, [
    displayedServerJobs,
    effectiveServerSummary,
    localJobs,
    provisionalSummaryJobs
  ]);
  const producerApi = useMemo<IngestionQueueProducerApi>(() => ({
    jobsRef,
    appendJobs,
    bindServerJob,
    captureServerConnectionGeneration,
    observeCompletedIngestions,
    releaseResolvedServerJobs,
    server: {
      recoverAuthority: server.recoverAuthority
    },
    updateJob
  }), [
    appendJobs,
    bindServerJob,
    captureServerConnectionGeneration,
    jobsRef,
    observeCompletedIngestions,
    releaseResolvedServerJobs,
    server.recoverAuthority,
    updateJob
  ]);

  return {
    jobs: state.jobs,
    localJobs,
    jobsRef,
    queueType,
    server,
    serverNotice: serverNoticeState?.message ?? "",
    serverNoticeRetryable: serverNoticeState?.retryable ?? false,
    retryServerNotice,
    totalItems,
    page: state.page,
    totalPages,
    visibleJobs,
    summary,
    uncommittedCount: [
      ...localJobs,
      ...provisionalSummaryJobs
    ].filter(isUncommittedIngestionJob).length
      + Math.max(
          0,
          (effectiveServerSummary?.unfinished ?? 0)
            - (effectiveServerSummary?.committing ?? 0)
            - (effectiveServerSummary?.resolving ?? 0)
        ),
    actions,
    producerApi,
    setPage,
    appendJobs,
    captureBrowserActionJobs,
    bindServerJob,
    updateJob,
    observeCompletedIngestions,
    flushCompletedIngestionInvalidations,
    updateJobs,
    updateJobDraft: draftSync.updateJobDraft,
    flushPendingUpdates: draftSync.flushPendingUpdates,
    // Kept as a non-visual integration diagnostic; workflow controls no
    // longer derive disabled state from authority handoff progress.
    pendingAuthorityHandoff: handoffs.pending
      || handoffJobsRef.current.size > 0,
    hasPendingDraftUpdates: draftSync.hasPendingUpdates,
    updateDuplicateDecision: draftSync.updateDuplicateDecision,
    removeJob,
    clearJobIds,
    releaseResolvedServerJobs,
    projectCompletedCleanupBatch,
    recoverAfterSuccessfulAction,
    removeLibraryDuplicate,
    applyDefaultsToLocalJobs
  };
}

export type IngestionQueueController = ReturnType<typeof useIngestionQueue>;
