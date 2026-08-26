import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  importBatchHardLimit,
  type AdminImageListItemDto,
  importQueueSnapshotMaxItems,
  importStatusBatchMaxItems,
  type ImportQueueSummaryDto,
  type ImportQueueTypeDto,
  type ImportSessionPairDto
} from "@imageshow/shared/browser";
import type { ImportJob } from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import {
  browserDisplayPrefixJobs,
  combinedImportQueuePagePlan,
  importJobHasBrowserDisplayOrder,
  importQueuePageCount,
  importJobCanLeaveQueue,
  isUncommittedImportJob,
  reduceImportQueue,
  summarizeImportJobs,
  type ImportQueueAction,
  type ImportServerBinding,
  type ImportQueueState
} from "./import-queue-state.js";
import {
  completedImportObservations,
  type AppendImportQueueApi,
  type CompletedImportObservation
} from "./import-queue-api.js";
import {
  importJobFromServerItem,
  importJobFromKnownCompletedStatus,
  importJobAwaitsActionCoverage,
  importJobHasServerAuthority,
  importHandoffRetryDecision,
  serverImportJobsForCombinedPage,
  serverImportJobPairKey,
  serverImportPairKey
} from "./server-import-job.js";
import { useServerImportQueue } from "./useServerImportQueue.js";
import { useImportQueueActions } from "./useImportQueueActions.js";
import { getImportStatuses } from "./import-api.js";
import { importStatusEventPatch } from "./import-status-state.js";
import { invalidateImageDataAfterImport } from "../../../lib/api/query-invalidation.js";
import { invalidateImportDuplicateDetails } from "./useImportDuplicateDetails.js";
import { useStoredImportDraftSync } from "./useStoredImportDraftSync.js";
import { useImportAuthorityHandoffs } from "./useImportAuthorityHandoffs.js";
import { useOptionalAuthSessionRecovery } from "../../../hooks/useAuthSession.js";

function revokeObjectUrl(job: ImportJob) {
  if (job.objectUrl?.startsWith("blob:")) URL.revokeObjectURL(job.objectUrl);
}

function importPairBelongsToSession(pairKey: string, sessionId: string) {
  return pairKey.startsWith(`${sessionId}\0`);
}

type DetachedProvisionalHandoff = Readonly<{
  connectionGeneration: number;
  job: ImportJob;
}>;

type HandoffRetryGate = Readonly<{
  connectionGeneration: number;
  revision: number;
  mode: "state-change" | "coverage";
}>;

type StableServerQueueSummary = Readonly<{
  connectionGeneration: number;
  lastAcceptedOrder: number;
  summary: ImportQueueSummaryDto;
}>;

type ResolvedServerJobTarget = Readonly<{
  id: string;
  attemptKey: string;
  pair: ImportSessionPairDto;
}>;

function importJobMatchesResolvedServerTarget(
  job: ImportJob,
  target: ResolvedServerJobTarget
) {
  if (serverImportJobPairKey(job) !== serverImportPairKey(target.pair)) {
    return false;
  }
  if (job.id === target.id && job.attemptKey === target.attemptKey) return true;
  return importJobHasServerAuthority(job)
    && job.serverAttemptKey === target.attemptKey;
}

export function useImportQueue(
  pageSize: number,
  queueType: ImportQueueTypeDto,
  displayed: boolean
) {
  const queryClient = useQueryClient();
  const recoverAuthSession = useOptionalAuthSessionRecovery();
  const [state, setState] = useState<ImportQueueState>({ jobs: [], page: 1 });
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
  const stateRef = useRef(state);
  const jobsRef = useRef(state.jobs);
  const handoffJobsRef = useRef(new Map<string, ImportJob>());
  const detachedProvisionalHandoffsRef = useRef(
    new Map<string, DetachedProvisionalHandoff>()
  );
  const handoffRetryAfterRevisionRef = useRef(
    new Map<string, HandoffRetryGate>()
  );
  const completedHandoffPairsRef = useRef(new Set<string>());
  const handledStaleSnapshotRef = useRef("");
  const observedCompletedPairsRef = useRef(new Set<string>());
  const pendingCompletedItemsRef = useRef(
    new Map<string, CompletedImportObservation>()
  );
  const completionInvalidationPromiseRef = useRef<Promise<void> | null>(null);
  const completionInvalidationRequestedRef = useRef(false);
  const completionInvalidationScheduledRef = useRef(false);
  const completionQueueIdleRef = useRef(false);
  const actionConnectionHoldRef = useRef(false);
  const lastReadyGenerationRef = useRef(0);
  const flushCompletedImportInvalidations = useCallback(() => {
    if (!pendingCompletedItemsRef.current.size) {
      return completionInvalidationPromiseRef.current ?? Promise.resolve();
    }
    completionInvalidationRequestedRef.current = true;
    const active = completionInvalidationPromiseRef.current;
    if (active) return active;
    const run = async () => {
      while (completionInvalidationRequestedRef.current) {
        completionInvalidationRequestedRef.current = false;
        const pending = [...pendingCompletedItemsRef.current.entries()];
        if (!pending.length) continue;
        const completedTimes = pending.map(([, entry]) => entry.completedAt);
        const completedAt = completedTimes.every(
          (value): value is number => value !== undefined
        )
          ? Math.max(...completedTimes)
          : undefined;
        await invalidateImageDataAfterImport(
          queryClient,
          pending.map(([, entry]) => entry.item),
          { completedAt }
        );
        for (const [pairKey, entry] of pending) {
          if (pendingCompletedItemsRef.current.get(pairKey) === entry) {
            pendingCompletedItemsRef.current.delete(pairKey);
          }
        }
      }
    };
    const promise = run().finally(() => {
      if (completionInvalidationPromiseRef.current === promise) {
        completionInvalidationPromiseRef.current = null;
      }
      if (
        completionInvalidationRequestedRef.current
        && pendingCompletedItemsRef.current.size
      ) {
        void flushCompletedImportInvalidations().catch(() => undefined);
      }
    });
    completionInvalidationPromiseRef.current = promise;
    return promise;
  }, [queryClient]);
  const scheduleCompletedImportInvalidation = useCallback(() => {
    if (completionInvalidationScheduledRef.current) return;
    completionInvalidationScheduledRef.current = true;
    queueMicrotask(() => {
      completionInvalidationScheduledRef.current = false;
      if (!completionQueueIdleRef.current) return;
      void flushCompletedImportInvalidations().catch(() => undefined);
    });
  }, [flushCompletedImportInvalidations]);
  const observeCompletedImports = useCallback((
    entries: readonly CompletedImportObservation[]
  ) => {
    const items: AdminImageListItemDto[] = [];
    for (const entry of entries) {
      const pairKey = serverImportPairKey(entry.pair);
      if (observedCompletedPairsRef.current.has(pairKey)) continue;
      observedCompletedPairsRef.current.add(pairKey);
      pendingCompletedItemsRef.current.set(pairKey, entry);
      items.push(entry.item);
    }
    if (items.length) {
      for (const md5 of new Set(items.map((item) => item.md5))) {
        invalidateImportDuplicateDetails(md5);
      }
      scheduleCompletedImportInvalidation();
    }
  }, [scheduleCompletedImportInvalidation]);
  const localJobs = useMemo(
    () => state.jobs.filter((job) => !importJobHasServerAuthority(job)),
    [state.jobs]
  );
  const pagePlan = useMemo(() => combinedImportQueuePagePlan(
    state.jobs,
    state.page,
    pageSize,
    importQueueSnapshotMaxItems
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
  const server = useServerImportQueue({
    enabled: displayed || actionConnectionHoldRef.current,
    displayed,
    queue: queueType,
    offset: serverOffset,
    limit: serverLimit,
    requiredItems: serverDisplayLimit,
    excludeItems: excludedServerItems,
    includeItems: includedServerItems,
    onCompletedImports: observeCompletedImports
  });
  completionQueueIdleRef.current = server.status === "ready"
    && server.summary !== null
    && server.summary.committing === 0
    && server.summary.resolving === 0;
  const serverItemsRef = useRef(server.items);
  serverItemsRef.current = server.items;
  const serverConnectionRef = useRef({
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
    && server.lastAcceptedOrder !== null
  ) {
    lastStableServerSummaryRef.current = {
      connectionGeneration: server.connectionGeneration,
      lastAcceptedOrder: server.lastAcceptedOrder,
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
  const actions = useImportQueueActions(
    queueType,
    server,
    actionConnectionHoldRef,
    observeCompletedImports,
    recoverAuthSession
  );
  const currentServerJobs = useMemo(
    () => state.jobs.filter(importJobHasServerAuthority),
    [state.jobs]
  );
  const availableServerJobs = currentServerJobs;
  const snapshotItems = hasRetainedServerBaseline ? server.items : [];
  const snapshotPairs = new Set(snapshotItems.map(serverImportPairKey));
  const visibleHandoffPairs = new Set(availableServerJobs.flatMap((job) => {
    const pairKey = serverImportJobPairKey(job);
    return pairKey
      && !importJobHasBrowserDisplayOrder(job)
      && !snapshotPairs.has(pairKey)
      && job.serverHandoffDisplayPage === state.page
      && (
        server.status !== "ready"
        || job.serverHandoffPending === true
      )
      ? [pairKey]
      : [];
  }));
  // Current-document cards retain their browser batch/manifest positions while
  // authority moves item-by-item. The bounded snapshot supplies only the
  // remaining slots and keeps its own display-ZSET order.
  const displayedServerJobs = serverImportJobsForCombinedPage(
    availableServerJobs,
    snapshotItems,
    serverDisplayLimit,
    visibleHandoffPairs
  ).filter((job) => (
    !acceptedDisplayPairs.has(serverImportJobPairKey(job))
  )).slice(0, serverDisplayLimit);
  const detachedProvisionalJobs = [
    ...detachedProvisionalHandoffsRef.current.values()
  ].map((entry) => entry.job);
  const provisionalByPair = new Map([
    ...availableServerJobs,
    ...detachedProvisionalJobs,
    ...handoffJobsRef.current.values()
  ].map((job) => [serverImportJobPairKey(job), job]));
  const provisionalSummaryJobs = [...provisionalByPair.values()].filter((job) => (
    job.serverHandoffProvisionalTotal === true
    && job.serverHandoffPending === true
    && !snapshotPairs.has(serverImportJobPairKey(job))
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
  const effectiveServerSummary = server.summary ?? (
    server.status === "loading" && (
      hasCurrentCoverageGate || provisionalSummaryJobs.length > 0
    )
      ? lastStableServerSummaryRef.current?.summary ?? null
      : null
  );
  const serverTotal = effectiveServerSummary?.total ?? 0;
  const totalItems = localJobs.length
    + provisionalSummaryJobs.length
    + serverTotal;
  const totalItemsRef = useRef(totalItems);
  totalItemsRef.current = totalItems;

  const dispatch = useCallback((action: ImportQueueAction) => {
    // 上传/下载是异步并发流程，回调触发时 React state 可能已落后；ref 里同步维护最新队列供所有回调用。
    const current = stateRef.current;
    const next = reduceImportQueue(current, action);
    if (next === current) return false;
    stateRef.current = next;
    jobsRef.current = next.jobs;
    setState(next);
    return true;
  }, []);

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

  const draftSync = useStoredImportDraftSync({
    jobsRef,
    dispatch,
    server,
    reportError: reportDraftError,
    observeCompletedImports
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
          serverImportJobPairKey(job) === pairKey
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
        uploadIntentInput: undefined,
        remoteAcceptInput: undefined,
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
  const handoffs = useImportAuthorityHandoffs({
    jobs: state.jobs,
    jobsRef,
    dispatch,
    server,
    reportError: reportRecoverableStatusError,
    promoteReconnectOwners,
    observeCompletedImports
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
  }, []);
  useEffect(() => {
    if (server.status !== "ready") return;
    observeCompletedImports(server.items.flatMap((item) => (
      item.status === "completed"
        ? [{
            pair: item,
            item: item.completed_item,
            completedAt: item.completed_at
          }]
        : []
    )));
  }, [observeCompletedImports, server.items, server.status]);
  useEffect(() => {
    if (completionQueueIdleRef.current) {
      scheduleCompletedImportInvalidation();
    }
  }, [
    scheduleCompletedImportInvalidation,
    server.status,
    server.summary?.committing,
    server.summary?.resolving
  ]);
  useEffect(() => {
    if (!displayed) {
      void flushCompletedImportInvalidations().catch(() => undefined);
    }
  }, [displayed, flushCompletedImportInvalidations]);
  useEffect(() => () => {
    completionQueueIdleRef.current = false;
    void flushCompletedImportInvalidations().catch(() => undefined);
  }, [flushCompletedImportInvalidations]);
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
      importJobHasServerAuthority
    );
    if (server.status !== "ready") {
      const reconnecting = server.connectionGeneration
        !== lastReadyGenerationRef.current;
      if (reconnecting) {
        setStatusNotice(null);
      }
      const retainedVisibleHandoffs: ImportJob[] = [];
      let handoffChanged = false;
      for (const job of existingServerJobs) {
        const pairKey = serverImportJobPairKey(job);
        const retainVisible = pairKey
          && !importJobHasBrowserDisplayOrder(job)
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
            || job.uploadIntentInput
            || job.remoteAcceptInput
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
          && !importJobHasBrowserDisplayOrder(job)
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
      server.staleItems.map(serverImportPairKey)
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
      const collectObjectUrl = (job: ImportJob | undefined) => {
        if (job?.objectUrl?.startsWith("blob:")) objectUrls.add(job.objectUrl);
      };
      for (const job of stateRef.current.jobs) {
        if (stalePairKeys.has(serverImportJobPairKey(job))) {
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
      }
      for (const objectUrl of objectUrls) URL.revokeObjectURL(objectUrl);
      handoffs.resolvePairs(stalePairKeys);
      draftSync.retirePairOwners(stalePairKeys);
      existingServerJobs = existingServerJobs.filter((job) => (
        !stalePairKeys.has(serverImportJobPairKey(job))
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

    const existingByPair = new Map<string, ImportJob>();
    for (const job of stateRef.current.jobs) {
      const pairKey = serverImportJobPairKey(job);
      if (
        pairKey
        && !stalePairKeys.has(pairKey)
        && (
          !existingByPair.has(pairKey)
          || !importJobHasServerAuthority(job)
        )
      ) existingByPair.set(pairKey, job);
    }
    for (const [pairKey, job] of handoffJobsRef.current) {
      if (!existingByPair.has(pairKey)) existingByPair.set(pairKey, job);
    }
    const hydratedHandoffPairs = new Set<string>();
    let retainedServerDisplayItems = 0;
    const stateServerItems = server.items.filter((item) => {
      if (acceptedDisplayPairs.has(serverImportPairKey(item))) return true;
      if (retainedServerDisplayItems >= serverDisplayLimit) return false;
      retainedServerDisplayItems += 1;
      return true;
    });
    const nextServerJobs = stateServerItems.map((item) => {
      const pairKey = serverImportPairKey(item);
      const existing = existingByPair.get(pairKey);
      const next = importJobFromServerItem(item, existing, server.revision);
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
      } else if (handoffJobsRef.current.delete(pairKey)) {
        handoffRetryAfterRevisionRef.current.delete(pairKey);
        detachedProvisionalHandoffsRef.current.delete(pairKey);
        completedHandoffPairsRef.current.delete(pairKey);
        handoffChanged = true;
        hydratedHandoffPairs.add(pairKey);
      }
      return next;
    });
    const nextPairs = new Set(stateServerItems.map(serverImportPairKey));
    const retainedVisibleHandoffs: ImportJob[] = [];
    for (const job of existingServerJobs) {
      const pairKey = serverImportJobPairKey(job);
      if (!pairKey || nextPairs.has(pairKey)) continue;
      if (importJobHasBrowserDisplayOrder(job)) continue;
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
    server.connectionGeneration,
    server.items,
    server.revision,
    server.staleItems,
    server.status,
    serverDisplayLimit,
    hasRetainedServerBaseline
  ]);

  useEffect(() => {
    if (server.status !== "ready") return;
    const snapshotPairs = new Set(server.items.map(serverImportPairKey));
    const staleVisibleHandoffs = currentServerJobs.filter((job) => (
      job.serverHandoffDisplayPage !== undefined
      && !importJobHasBrowserDisplayOrder(job)
      && job.serverHandoffPending !== true
      && !snapshotPairs.has(serverImportJobPairKey(job))
    ));
    if (!staleVisibleHandoffs.length) return;
    const staleIds = new Set(staleVisibleHandoffs.map((job) => job.id));
    staleVisibleHandoffs.forEach(revokeObjectUrl);
    dispatch({
      type: "replace-server-page",
      jobs: currentServerJobs.filter((job) => !staleIds.has(job.id))
    });
  }, [currentServerJobs, dispatch, server.items, server.status]);

  useEffect(() => {
    if (server.status !== "ready" || server.revision === null) return;
    let retry = false;
    const coveredExternalPairs = new Set<string>();
    const snapshotPairs = new Set(server.items.map(serverImportPairKey));
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
        revokeObjectUrl(job);
        coveredExternalPairs.add(pairKey);
      }
    }
    if (coveredExternalPairs.size) {
      const currentServerJobs = stateRef.current.jobs
        .filter(importJobHasServerAuthority);
      currentServerJobs
        .filter((job) => coveredExternalPairs.has(serverImportJobPairKey(job)))
        .forEach(revokeObjectUrl);
      const retainedServerJobs = currentServerJobs.filter(
        (job) => !coveredExternalPairs.has(serverImportJobPairKey(job))
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
    server.items,
    server.revision,
    server.status
  ]);

  useEffect(() => {
    if (server.status !== "ready" || !handoffJobsRef.current.size) return;
    const controller = new AbortController();
    const requestRevision = serverConnectionRef.current.revision;
    const entries = [...handoffJobsRef.current]
      .filter(([pairKey]) => {
        const retryAfter = handoffRetryAfterRevisionRef.current.get(pairKey);
        return retryAfter === undefined
          || retryAfter.connectionGeneration !== server.connectionGeneration
          || retryAfter.mode === "state-change"
            && requestRevision !== null
            && requestRevision > retryAfter.revision;
      })
      .map(([pairKey, job]) => ({
        pairKey,
        job,
        pair: {
          session_id: job.sessionId!,
          image_id: job.imageId!
        }
      }));
    if (!entries.length) return;
    void (async () => {
      const completedJobs: ImportJob[] = [];
      const completedInvalidations: CompletedImportObservation[] = [];
      const completedPatches = new Map<string, Partial<ImportJob>>();
      const presentPatches = new Map<string, Partial<ImportJob>>();
      const resolvedExternalStatuses = new Set<string>();
      const verifiedExternalRevisions = new Map<string, number>();
      let handoffChanged = false;
      let retryImmediately = false;
      let refreshForCoverage = false;
      const requireSnapshotCoverage = (pairKey: string, revision: number) => {
        handoffRetryAfterRevisionRef.current.set(pairKey, {
          connectionGeneration: server.connectionGeneration,
          revision,
          mode: "coverage"
        });
        verifiedExternalRevisions.set(pairKey, revision);
        handoffChanged = true;
        if ((serverConnectionRef.current.revision ?? -1) < revision) {
          refreshForCoverage = true;
        }
      };
      try {
        for (
          let offset = 0;
          offset < entries.length;
          offset += importStatusBatchMaxItems
        ) {
          const chunk = entries.slice(offset, offset + importStatusBatchMaxItems);
          const statuses = await getImportStatuses(
            chunk.map((entry) => entry.pair),
            controller.signal
          );
          if (controller.signal.aborted) return;
          for (const [index, entry] of chunk.entries()) {
            if (handoffJobsRef.current.get(entry.pairKey) !== entry.job) {
              continue;
            }
            const status = statuses[index];
            if (!status) continue;
            completedInvalidations.push(...completedImportObservations([status]));
            const awaitsCompleted =
              completedHandoffPairsRef.current.has(entry.pairKey);
            if (
              status.status === "present"
              && entry.job.serverDraftPending === true
            ) {
              draftSync.ensureJobSnapshot(entry.job);
            }
            if (status.status === "present" && awaitsCompleted) {
              const retry = importHandoffRetryDecision(
                requestRevision,
                serverConnectionRef.current.revision,
                status.item.last_semantic_revision
              );
              if (retry.retryImmediately) {
                handoffRetryAfterRevisionRef.current.delete(entry.pairKey);
                retryImmediately = true;
              } else {
                handoffRetryAfterRevisionRef.current.set(
                  entry.pairKey,
                  {
                    connectionGeneration: server.connectionGeneration,
                    revision: retry.retryAfterRevision,
                    mode: "state-change"
                  }
                );
              }
              continue;
            }
            if (status.status === "present") {
              const current = jobsRef.current.find((job) => (
                job.id === entry.job.id
                && job.attemptKey === entry.job.attemptKey
              ));
              if (current) {
                const next = {
                  ...importJobFromServerItem(
                    status.item,
                    current,
                    serverConnectionRef.current.revision
                  ),
                  serverHandoffPending: true,
                  serverHandoffRevision: status.item.last_semantic_revision
                };
                if (
                  current.objectUrl?.startsWith("blob:")
                  && !next.objectUrl?.startsWith("blob:")
                ) revokeObjectUrl(current);
                presentPatches.set(current.id, next);
              }
              requireSnapshotCoverage(
                entry.pairKey,
                status.item.last_semantic_revision
              );
              continue;
            }
            if (status.status === "missing") {
              const current = jobsRef.current.find((job) => (
                job.id === entry.job.id
                && job.attemptKey === entry.job.attemptKey
                && serverImportJobPairKey(job) === entry.pairKey
              ));
              const retainedJob = current ?? entry.job;
              const patch = importStatusEventPatch(retainedJob, status);
              if (patch) {
                if (current) presentPatches.set(current.id, patch);
                else completedJobs.push({ ...retainedJob, ...patch });
              }
              handoffJobsRef.current.delete(entry.pairKey);
              handoffRetryAfterRevisionRef.current.delete(entry.pairKey);
              detachedProvisionalHandoffsRef.current.delete(entry.pairKey);
              completedHandoffPairsRef.current.delete(entry.pairKey);
              draftSync.retirePairOwners(new Set([entry.pairKey]));
              handoffChanged = true;
              resolvedExternalStatuses.add(entry.pairKey);
              continue;
            }
            if (status.status === "completed") {
              if (status.redis_status === "active") {
                const retry = importHandoffRetryDecision(
                  requestRevision,
                  serverConnectionRef.current.revision,
                  status.redis_last_semantic_revision ?? 0
                );
                if (retry.retryImmediately) {
                  handoffRetryAfterRevisionRef.current.delete(entry.pairKey);
                  retryImmediately = true;
                } else {
                  handoffRetryAfterRevisionRef.current.set(
                    entry.pairKey,
                    {
                      connectionGeneration: server.connectionGeneration,
                      revision: retry.retryAfterRevision,
                      mode: "state-change"
                    }
                  );
                }
                continue;
              }
              if (status.redis_status === "completed") {
                const revision = status.redis_last_semantic_revision;
                if (revision === undefined) {
                  const previous =
                    handoffRetryAfterRevisionRef.current.get(entry.pairKey);
                  handoffRetryAfterRevisionRef.current.set(
                    entry.pairKey,
                    {
                      connectionGeneration: server.connectionGeneration,
                      revision: Math.max(
                        previous?.connectionGeneration
                          === server.connectionGeneration
                          ? previous.revision
                          : 0,
                        requestRevision ?? 0
                      ),
                      mode: "state-change"
                    }
                  );
                  continue;
                }
                requireSnapshotCoverage(entry.pairKey, revision);
                continue;
              }
              const current = jobsRef.current.find((job) => (
                job.id === entry.job.id
                && job.attemptKey === entry.job.attemptKey
                && serverImportJobPairKey(job) === entry.pairKey
              ));
              const completedJob = importJobFromKnownCompletedStatus(
                current ?? entry.job,
                status
              );
              if (completedJob) {
                if (current) completedPatches.set(current.id, completedJob);
                else completedJobs.push(completedJob);
              }
            }
            handoffJobsRef.current.delete(entry.pairKey);
            handoffRetryAfterRevisionRef.current.delete(entry.pairKey);
            detachedProvisionalHandoffsRef.current.delete(entry.pairKey);
            completedHandoffPairsRef.current.delete(entry.pairKey);
            handoffChanged = true;
            resolvedExternalStatuses.add(entry.pairKey);
            revokeObjectUrl(entry.job);
          }
        }
        observeCompletedImports(completedInvalidations);
        if (presentPatches.size) {
          dispatch({ type: "patch-many", patches: presentPatches });
        }
        if (completedPatches.size) {
          dispatch({ type: "patch-many", patches: completedPatches });
        }
        if (completedJobs.length) {
          dispatch({ type: "append", jobs: completedJobs });
        }
        if (resolvedExternalStatuses.size) {
          handoffs.resolveExternalStatuses(resolvedExternalStatuses);
        }
        if (verifiedExternalRevisions.size) {
          handoffs.verifyExternalStatusRevisions(verifiedExternalRevisions);
        }
        if (handoffChanged || retryImmediately) {
          setHandoffEpoch((current) => current + 1);
        }
        if (refreshForCoverage) server.refresh();
      } catch (error) {
        if (!controller.signal.aborted) {
          setStatusNotice({
            message: error instanceof Error ? error.message : String(error),
            retryable: true
          });
        }
      }
    })();
    return () => controller.abort();
  }, [
    dispatch,
    draftSync.ensureJobSnapshot,
    handoffEpoch,
    handoffs.resolveExternalStatuses,
    handoffs.verifyExternalStatusRevisions,
    observeCompletedImports,
    server.connectionGeneration,
    server.refresh,
    server.status,
    statusRetryEpoch
  ]);

  const retryServerNotice = useCallback(() => {
    setDraftNotice(null);
    setStatusNotice(null);
    setStatusRetryEpoch((current) => current + 1);
    handoffs.retry();
    void draftSync.retryPendingUpdates();
    server.refresh();
  }, [draftSync.retryPendingUpdates, handoffs.retry, server.refresh]);

  const appendJobs = useCallback((jobs: ImportJob[]) => {
    if (!jobs.length) return true;
    const browserOwned = browserDisplayPrefixJobs([
      ...jobs,
      ...stateRef.current.jobs
    ]);
    if (browserOwned.length > importBatchHardLimit) return false;
    dispatch({ type: "append", jobs });
    return true;
  }, [dispatch]);

  const captureBrowserActionJobs = useCallback((
    predicate: (job: ImportJob) => boolean
  ) => {
    const serverRevision = serverConnectionRef.current.revision;
    const candidates = [
      ...stateRef.current.jobs,
      ...handoffJobsRef.current.values(),
      ...[...detachedProvisionalHandoffsRef.current.values()].map(
        ({ job }) => job
      )
    ];
    const captured: ImportJob[] = [];
    const owners = new Set<string>();
    for (const job of candidates) {
      if (
        importJobHasServerAuthority(job)
        && !importJobAwaitsActionCoverage(job, serverRevision)
      ) continue;
      if (!predicate(job)) continue;
      const pairKey = serverImportJobPairKey(job);
      const ownerKey = pairKey || `${job.id}\0${job.attemptKey}`;
      if (owners.has(ownerKey)) continue;
      owners.add(ownerKey);
      captured.push(job);
    }
    return captured;
  }, []);

  const updateJob = useCallback((id: string, patch: Partial<ImportJob>) => {
    dispatch({ type: "patch", id, patch });
  }, [dispatch]);

  const bindServerJob = useCallback((
    id: string,
    binding: ImportServerBinding,
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
    const visibleBinding: ImportServerBinding = {
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
    const pair = serverImportPairKey({
      session_id: visibleBinding.sessionId,
      image_id: visibleBinding.imageId
    });
    const staleIncarnationPairs = new Set<string>();
    const includeStalePair = (pairKey: string) => {
      if (
        pairKey !== pair
        && importPairBelongsToSession(pairKey, visibleBinding.sessionId)
      ) staleIncarnationPairs.add(pairKey);
    };
    for (const job of stateRef.current.jobs) {
      if (importJobHasServerAuthority(job)) {
        includeStalePair(serverImportJobPairKey(job));
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
      const collectObjectUrl = (job: ImportJob | undefined) => {
        if (job?.objectUrl?.startsWith("blob:")) {
          staleObjectUrls.add(job.objectUrl);
        }
      };
      for (const job of stateRef.current.jobs) {
        if (staleIncarnationPairs.has(serverImportJobPairKey(job))) {
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
      }
      for (const objectUrl of staleObjectUrls) {
        URL.revokeObjectURL(objectUrl);
      }
      handoffs.resolvePairs(staleIncarnationPairs);
      setHandoffEpoch((value) => value + 1);
    }
    const canonical = jobsRef.current.find((job) => (
      job.id !== id
      && importJobHasServerAuthority(job)
      && serverImportJobPairKey(job) === pair
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
          uploadIntentInput: undefined,
          remoteAcceptInput: undefined,
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
      (item) => serverImportPairKey(item) === pair
    );
    if (
      current
      && !wasVisibleBrowserCard
      && !canonical
      && !snapshotHasPair
      && bound
      && importJobHasServerAuthority(bound)
    ) {
      // A covered response can bind an item outside the current combined
      // page without changing serverLimit. Move any pending draft into its
      // detached owner, then release browser-only bytes immediately instead
      // of waiting for an unrelated snapshot/render to notice the DTO.
      if (bound.serverDraftPending === true) {
        draftSync.ensureJobSnapshot(bound);
      }
      revokeObjectUrl(bound);
      if (importJobHasBrowserDisplayOrder(bound)) {
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
            uploadIntentInput: undefined,
            remoteAcceptInput: undefined,
            duplicates: []
          }
        });
        if (bound.serverDraftPending === true) draftSync.scheduleJob(bound.id);
        return;
      }
      dispatch({
        type: "replace-server-page",
        jobs: jobsRef.current.filter((job) => (
          importJobHasServerAuthority(job)
          && serverImportJobPairKey(job) !== pair
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
    patches: ReadonlyMap<string, Partial<ImportJob>>
  ) => {
    if (patches.size) dispatch({ type: "patch-many", patches });
  }, [dispatch]);

  const releaseJob = useCallback((job: ImportJob) => {
    // 本地预览 URL 由前端创建，任务离队时必须释放；服务端 preview_url 不需要 revoke。
    revokeObjectUrl(job);
  }, []);

  const removeJob = useCallback((id: string) => {
    const job = jobsRef.current.find((item) => item.id === id);
    if (!job || !importJobCanLeaveQueue(job)) return false;
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
      ids.has(job.id) && importJobCanLeaveQueue(job)
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
    if (md5) invalidateImportDuplicateDetails(md5);
  }, []);

  const applyDefaultsToLocalJobs = useCallback((
    defaults: ImportAttributeDefaults,
    jobs: readonly Pick<ImportJob, "id" | "attemptKey">[]
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

  const releaseResolvedServerJobs = useCallback((
    targets: readonly ResolvedServerJobTarget[]
  ) => {
    const resolved = new Set<string>();
    const releasedPairs = new Map<string, ResolvedServerJobTarget>();
    for (const target of targets) {
      const pairKey = serverImportPairKey(target.pair);
      const handoff = handoffJobsRef.current.get(pairKey);
      const detached = detachedProvisionalHandoffsRef.current.get(pairKey)?.job;
      const candidates = new Set([
        ...stateRef.current.jobs.filter((job) => (
          job.id === target.id
          || importJobHasServerAuthority(job)
            && serverImportJobPairKey(job) === pairKey
        )),
        ...(handoff ? [handoff] : []),
        ...(detached ? [detached] : [])
      ]);
      const pairHasIdentityFreeOwner =
        handoffRetryAfterRevisionRef.current.has(pairKey)
        || completedHandoffPairsRef.current.has(pairKey)
        || handoffs.hasPair(pairKey);
      if (
        [...candidates].some((job) => (
          !importJobMatchesResolvedServerTarget(job, target)
        ))
        || !candidates.size && pairHasIdentityFreeOwner
      ) continue;
      resolved.add(target.id);
      if (candidates.size) releasedPairs.set(pairKey, target);
    }
    if (!releasedPairs.size) return resolved;

    const removedStateTargets = new Map<string, {
      attemptKey: string;
      pairKey: string;
    }>();
    for (const job of stateRef.current.jobs) {
      const target = releasedPairs.get(serverImportJobPairKey(job));
      if (target && importJobMatchesResolvedServerTarget(job, target)) {
        removedStateTargets.set(job.id, {
          attemptKey: job.attemptKey,
          pairKey: serverImportJobPairKey(job)
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
    }
    handoffs.resolvePairs(new Set(releasedPairs.keys()));
    if (removedStateTargets.size) {
      dispatch({
        type: "release-resolved",
        targets: removedStateTargets,
        pageSize,
        totalItems: totalItemsRef.current
      });
    }
    setHandoffEpoch((current) => current + 1);
    return resolved;
  }, [dispatch, handoffs.hasPair, handoffs.resolvePairs, pageSize]);

  const totalPages = importQueuePageCount(totalItems, pageSize);
  const visibleJobs = useMemo(
    () => [...visibleDisplayPrefixJobs, ...displayedServerJobs],
    [displayedServerJobs, visibleDisplayPrefixJobs]
  );
  const summary = useMemo(() => {
    const local = summarizeImportJobs([
      ...localJobs,
      ...provisionalSummaryJobs
    ]);
    const provisionalPairs = new Set(
      provisionalSummaryJobs.map(serverImportJobPairKey)
    );
    const currentServer = summarizeImportJobs(displayedServerJobs.filter(
      (job) => !provisionalPairs.has(serverImportJobPairKey(job))
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
  const workerApi = useMemo<AppendImportQueueApi>(() => ({
    jobsRef,
    appendJobs,
    bindServerJob,
    captureServerConnectionGeneration,
    observeCompletedImports,
    releaseResolvedServerJobs,
    server: { refresh: server.refresh },
    updateJob
  }), [
    appendJobs,
    bindServerJob,
    captureServerConnectionGeneration,
    jobsRef,
    observeCompletedImports,
    releaseResolvedServerJobs,
    server.refresh,
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
    ].filter(isUncommittedImportJob).length
      + Math.max(
          0,
          (effectiveServerSummary?.unfinished ?? 0)
            - (effectiveServerSummary?.committing ?? 0)
            - (effectiveServerSummary?.resolving ?? 0)
        ),
    actions,
    workerApi,
    setPage,
    appendJobs,
    captureBrowserActionJobs,
    bindServerJob,
    updateJob,
    observeCompletedImports,
    flushCompletedImportInvalidations,
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
    removeLibraryDuplicate,
    applyDefaultsToLocalJobs
  };
}

export type ImportQueueController = ReturnType<typeof useImportQueue>;
