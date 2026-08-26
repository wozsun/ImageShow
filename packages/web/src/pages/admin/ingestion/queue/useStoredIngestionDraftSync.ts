import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject
} from "react";
import {
  ingestionBatchHardLimit,
  ingestionStatusBatchMaxItems
} from "@imageshow/shared/browser";
import type { ImageDraft, IngestionJob } from "../../../../lib/types.js";
import { isApiClientError } from "../../../../lib/api/client.js";
import type { IngestionQueueAction } from "./model/ingestion-queue-state.js";
import { ingestionDuplicateMessage } from "./model/duplicate-match.js";
import { getIngestionStatuses, updateStoredIngestions } from "./ingestion-api.js";
import {
  completedIngestionObservations,
  type CompletedIngestionObservation
} from "./ingestion-queue-api.js";
import {
  ingestionJobFromServerItem,
  serverIngestionPairKey
} from "./model/server-ingestion-job.js";
import type { ServerIngestionQueueController } from "./useServerIngestionQueue.js";
import {
  authoritativeDraftFromStatus,
  draftSyncMutationAttempts,
  draftSyncTarget,
  matchesDraftTarget,
  type DraftSyncTarget,
  type PendingDraftSync
} from "./model/stored-ingestion-draft-model.js";

async function updateStoredIngestionsWithResponseRetry(
  items: Parameters<typeof updateStoredIngestions>[0],
  captureConnectionGeneration: () => number
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const requestConnectionGeneration = captureConnectionGeneration();
    try {
      return {
        response: await updateStoredIngestions(items),
        requestConnectionGeneration
      };
    } catch (error) {
      if (isApiClientError(error) && error.status < 500) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export function useStoredIngestionDraftSync({
  jobsRef,
  dispatch,
  server,
  reportError,
  observeCompletedIngestions
}: {
  jobsRef: RefObject<IngestionJob[]>;
  dispatch: (action: IngestionQueueAction) => boolean;
  server: ServerIngestionQueueController;
  reportError: (message: string, retryable?: boolean) => void;
  observeCompletedIngestions: (
    entries: readonly CompletedIngestionObservation[]
  ) => void;
}) {
  const syncsRef = useRef(new Map<string, PendingDraftSync>());
  const flushRef = useRef<(id: string) => Promise<boolean>>(async () => true);
  const flushBatchRef = useRef<(
    ids: readonly string[]
  ) => Promise<ReadonlyMap<string, boolean>>>(async () => new Map());
  const executeBatchRef = useRef<(
    ids: readonly string[]
  ) => Promise<ReadonlyMap<string, boolean>>>(async () => new Map());
  const batchTailRef = useRef<Promise<void>>(Promise.resolve());
  const scheduledIdsRef = useRef(new Set<string>());
  const scheduledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRef = useRef<(id: string) => void>(() => undefined);
  const ensureSnapshotRef = useRef<(job: IngestionJob) => void>(() => undefined);
  const duplicateDecisionRef = useRef<(
    id: string,
    duplicateDecision: "upload" | "confirmed"
  ) => Promise<boolean>>(async () => false);
  const duplicateDecisionRequestsRef = useRef(new Map<string, Readonly<{
    target: DraftSyncTarget;
    duplicateDecision: "upload" | "confirmed";
    promise: Promise<boolean>;
  }>>());
  const publishSyncStateRef = useRef<() => void>(() => undefined);
  const mountedRef = useRef(true);
  const [, setSyncEpoch] = useState(0);
  const serverRef = useRef(server);
  serverRef.current = server;
  const reportErrorRef = useRef(reportError);
  reportErrorRef.current = reportError;
  const observeCompletedIngestionsRef = useRef(observeCompletedIngestions);
  observeCompletedIngestionsRef.current = observeCompletedIngestions;

  const hasPendingUpdates = useCallback(() => (
    syncsRef.current.size > 0
      || jobsRef.current.some((job) => (
        job.serverDraftPending === true && draftSyncTarget(job) !== null
      ))
  ), [jobsRef]);
  const hasRetryableUpdates = useCallback(() => (
    [...syncsRef.current.values()].some((sync) => sync.retryable)
  ), []);
  publishSyncStateRef.current = () => {
    if (mountedRef.current) setSyncEpoch((current) => current + 1);
  };

  const retireSync = useCallback((
    id: string,
    sync: PendingDraftSync,
    authoritativeDraft?: ImageDraft
  ) => {
    if (syncsRef.current.get(id) !== sync) return;
    syncsRef.current.delete(id);
    const latest = jobsRef.current.find((job) => (
      matchesDraftTarget(job, sync.target)
    ));
    if (mountedRef.current && latest) {
      dispatch({
        type: "patch",
        id,
        patch: {
          serverDraftPending: false,
          ...(authoritativeDraft ? { draft: authoritativeDraft } : {})
        }
      });
    }
  }, [dispatch, jobsRef]);

  executeBatchRef.current = async (requestedIds: readonly string[]) => {
    const ids = [...new Set(requestedIds)];
    const outcomes = new Map(ids.map((id) => [id, true]));
    const failureMessages = new Set<string>();
    for (const id of ids) scheduledIdsRef.current.delete(id);

    for (
      let chunkOffset = 0;
      chunkOffset < ids.length;
      chunkOffset += ingestionBatchHardLimit
    ) {
      const chunkIds = ids.slice(
        chunkOffset,
        chunkOffset + ingestionBatchHardLimit
      );
      let exhausted = false;
      for (
        let attempt = 0;
        attempt < draftSyncMutationAttempts;
        attempt += 1
      ) {
        const entries: Array<{
          id: string;
          sync: PendingDraftSync;
          target: DraftSyncTarget;
        }> = [];
        const frozenEntries: Array<{
          id: string;
          sync: PendingDraftSync;
          target: DraftSyncTarget;
        }> = [];
        for (const id of chunkIds) {
          const sync = syncsRef.current.get(id);
          if (!sync) continue;
          if (sync.running) await sync.running;
          if (syncsRef.current.get(id) !== sync) continue;
          const current = jobsRef.current.find((job) => job.id === id);
          if (current && current.attemptKey !== sync.target.attemptKey) {
            retireSync(id, sync);
            continue;
          }
          const currentTarget = current ? draftSyncTarget(current) : null;
          if (current && !currentTarget) {
            const pair = serverIngestionPairKey({
              session_id: sync.target.sessionId,
              image_id: sync.target.imageId
            });
            const serverItem = serverRef.current.items.find((item) => (
              serverIngestionPairKey(item) === pair
            ));
            if (serverItem) {
              retireSync(
                id,
                sync,
                ingestionJobFromServerItem(serverItem).draft
              );
              outcomes.set(id, false);
              failureMessages.add(
                "内容接入任务已冻结提交或完成，本地草稿未写入"
              );
              continue;
            }
            frozenEntries.push({ id, sync, target: sync.target });
            continue;
          }
          if (currentTarget) {
            sync.target = {
              ...currentTarget,
              expectedVersion: Math.max(
                currentTarget.expectedVersion,
                sync.target.expectedVersion
              )
            };
          }
          if (sync.retryable) {
            outcomes.set(id, false);
            continue;
          }
          if (sync.awaitingRevision !== null && !sync.dirty) continue;
          const target = sync.target;
          sync.dirty = false;
          sync.retryable = false;
          sync.awaitingRevision = null;
          sync.awaitingConnectionGeneration = null;
          entries.push({ id, sync, target });
        }
        if (frozenEntries.length) {
          try {
            const statuses: Awaited<ReturnType<typeof getIngestionStatuses>> = [];
            for (
              let offset = 0;
              offset < frozenEntries.length;
              offset += ingestionStatusBatchMaxItems
            ) {
              const statusChunk = frozenEntries.slice(
                offset,
                offset + ingestionStatusBatchMaxItems
              );
              const response = await getIngestionStatuses(statusChunk.map((entry) => ({
                session_id: entry.target.sessionId,
                image_id: entry.target.imageId
              })));
              observeCompletedIngestionsRef.current(
                completedIngestionObservations(response)
              );
              statuses.push(...response);
            }
            for (const [index, { id, sync }] of frozenEntries.entries()) {
              if (syncsRef.current.get(id) !== sync) continue;
              const status = statuses[index];
              const authoritativeDraft = authoritativeDraftFromStatus(status);
              if (authoritativeDraft) {
                retireSync(id, sync, authoritativeDraft);
              } else {
                sync.dirty = true;
                sync.retryable = true;
              }
              outcomes.set(id, false);
            }
            failureMessages.add(
              "内容接入任务已完成、丢失或冻结提交，本地草稿未写入"
            );
          } catch (error) {
            failureMessages.add(
              error instanceof Error ? error.message : String(error)
            );
            for (const { id, sync } of frozenEntries) {
              if (syncsRef.current.get(id) !== sync) continue;
              sync.dirty = true;
              sync.retryable = true;
              outcomes.set(id, false);
            }
          }
        }
        if (!entries.length) break;

        const request = updateStoredIngestionsWithResponseRetry(
          entries.map(({ target }) => ({
            session_id: target.sessionId,
            image_id: target.imageId,
            expected_version: target.expectedVersion,
            metadata: target.draft
          })),
          () => serverRef.current.connectionGeneration
        );
        const running = request.then(() => true, () => false);
        for (const { sync } of entries) sync.running = running;
        let update: Awaited<typeof request>;
        try {
          update = await request;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failureMessages.add(message);
          for (const { id, sync } of entries) {
            if (syncsRef.current.get(id) !== sync) continue;
            sync.dirty = true;
            sync.retryable = true;
            sync.awaitingRevision = null;
            sync.awaitingConnectionGeneration = null;
            outcomes.set(id, false);
          }
          break;
        } finally {
          for (const { sync } of entries) {
            if (sync.running === running) sync.running = null;
          }
        }

        const versionConflicts: typeof entries = [];
        for (const [index, entry] of entries.entries()) {
          const { id, sync, target } = entry;
          if (syncsRef.current.get(id) !== sync) continue;
          const result = update.response.items[index];
          if (!result || result.status === "failed") {
            if (result?.code === "ingestion_version_conflict") {
              versionConflicts.push(entry);
              continue;
            }
            sync.dirty = true;
            sync.retryable = true;
            sync.awaitingRevision = null;
            sync.awaitingConnectionGeneration = null;
            outcomes.set(id, false);
            failureMessages.add(
              result?.message ?? "内容接入草稿更新响应缺少当前任务"
            );
            continue;
          }
          const latest = jobsRef.current.find((job) => (
            matchesDraftTarget(job, target)
          ));
          sync.target = {
            ...target,
            expectedVersion: result.version,
            draft: latest?.draft ?? sync.target.draft
          };
          sync.awaitingRevision = result.last_semantic_revision;
          sync.awaitingConnectionGeneration =
            update.requestConnectionGeneration;
          if (mountedRef.current && latest) {
            dispatch({
              type: "patch",
              id,
              patch: {
                serverVersion: result.version,
                serverSemanticRevision: result.last_semantic_revision,
                serverDraftPending: true
              }
            });
          }
        }

        if (versionConflicts.length) {
          try {
            const statuses: Awaited<ReturnType<typeof getIngestionStatuses>> = [];
            for (
              let offset = 0;
              offset < versionConflicts.length;
              offset += ingestionStatusBatchMaxItems
            ) {
              const statusChunk = versionConflicts.slice(
                offset,
                offset + ingestionStatusBatchMaxItems
              );
              const response = await getIngestionStatuses(
                statusChunk.map(({ target }) => ({
                  session_id: target.sessionId,
                  image_id: target.imageId
                }))
              );
              observeCompletedIngestionsRef.current(
                completedIngestionObservations(response)
              );
              statuses.push(...response);
            }
            for (const [index, { id, sync }] of versionConflicts.entries()) {
              if (syncsRef.current.get(id) !== sync) continue;
              const status = statuses[index];
              if (status?.status === "present" && !status.item.commit) {
                sync.target = {
                  ...sync.target,
                  expectedVersion: Math.max(
                    sync.target.expectedVersion,
                    status.item.version
                  )
                };
                sync.dirty = true;
                continue;
              }
              retireSync(
                id,
                sync,
                authoritativeDraftFromStatus(status)
              );
              outcomes.set(id, false);
              failureMessages.add(
                "内容接入任务已完成、丢失或冻结提交，无法再写入保留草稿"
              );
            }
          } catch (error) {
            failureMessages.add(
              error instanceof Error ? error.message : String(error)
            );
            for (const { id, sync } of versionConflicts) {
              if (syncsRef.current.get(id) !== sync) continue;
              sync.dirty = true;
              sync.retryable = true;
              outcomes.set(id, false);
            }
            break;
          }
        }

        if (attempt === draftSyncMutationAttempts - 1) exhausted = true;
      }

      if (exhausted) {
        let exhaustedDirty = false;
        for (const id of chunkIds) {
          const sync = syncsRef.current.get(id);
          if (!sync?.dirty) continue;
          sync.retryable = true;
          outcomes.set(id, false);
          exhaustedDirty = true;
        }
        if (exhaustedDirty) {
          failureMessages.add(
            "内容接入草稿在连续版本变化后仍未能写入，请重试"
          );
        }
      }
    }

    if (failureMessages.size && mountedRef.current) {
      const messages = [...failureMessages];
      reportErrorRef.current(
        messages.length === 1
          ? messages[0]!
          : `${messages[0]}（另有 ${messages.length - 1} 个错误）`,
        [...syncsRef.current.values()].some((sync) => sync.retryable)
      );
      serverRef.current.refresh();
    }
    publishSyncStateRef.current();
    return outcomes;
  };

  flushBatchRef.current = (ids: readonly string[]) => {
    const run = batchTailRef.current.then(() => executeBatchRef.current(ids));
    batchTailRef.current = run.then(() => undefined, () => undefined);
    return run;
  };

  flushRef.current = async (id: string) => (
    (await flushBatchRef.current([id])).get(id) ?? true
  );

  const scheduleBatch = (id: string) => {
    scheduledIdsRef.current.add(id);
    if (scheduledTimerRef.current) clearTimeout(scheduledTimerRef.current);
    scheduledTimerRef.current = setTimeout(() => {
      scheduledTimerRef.current = null;
      const ids = [...scheduledIdsRef.current];
      scheduledIdsRef.current.clear();
      void flushBatchRef.current(ids);
    }, 250);
  };

  scheduleRef.current = (id: string) => {
    const current = jobsRef.current.find((job) => job.id === id);
    const target = current ? draftSyncTarget(current) : null;
    if (!target) return;
    const existing = syncsRef.current.get(id);
    const sync = existing?.target.attemptKey === target.attemptKey
      ? existing
      : {
          running: null,
          dirty: false,
          retryable: false,
          target,
          awaitingRevision: null,
          awaitingConnectionGeneration: null
        } satisfies PendingDraftSync;
    sync.target = existing?.target.attemptKey === target.attemptKey
      ? {
          ...target,
          expectedVersion: Math.max(
            target.expectedVersion,
            existing.target.expectedVersion
          )
        }
      : target;
    sync.dirty = true;
    sync.retryable = false;
    sync.awaitingRevision = null;
    sync.awaitingConnectionGeneration = null;
    syncsRef.current.set(id, sync);
    scheduleBatch(id);
    publishSyncStateRef.current();
  };
  ensureSnapshotRef.current = (job: IngestionJob) => {
    const target = draftSyncTarget(job);
    if (!target) return;
    const existing = syncsRef.current.get(job.id);
    if (existing?.target.attemptKey === target.attemptKey) return;
    const sync: PendingDraftSync = {
      running: null,
      dirty: true,
      retryable: false,
      target,
      awaitingRevision: null,
      awaitingConnectionGeneration: null
    };
    syncsRef.current.set(job.id, sync);
    scheduleBatch(job.id);
    publishSyncStateRef.current();
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (scheduledTimerRef.current) clearTimeout(scheduledTimerRef.current);
      scheduledTimerRef.current = null;
      scheduledIdsRef.current.clear();
      void flushBatchRef.current([...syncsRef.current.keys()]);
    };
  }, []);

  // 本地 placeholder 上的编辑可能与 accept 响应交叉。canonical 接管后即补写
  // 草稿；在此之前 serverDraftPending 也会阻止 snapshot 覆盖它。
  useEffect(() => {
    let changed = false;
    if (server.status === "ready" && server.revision !== null) {
      for (const [id, sync] of syncsRef.current) {
        if (
          sync.awaitingRevision === null
          || sync.dirty
          || sync.running
          || (
            (
              sync.awaitingConnectionGeneration === null
              || sync.awaitingConnectionGeneration === server.connectionGeneration
            )
            && server.revision < sync.awaitingRevision
          )
        ) continue;
        syncsRef.current.delete(id);
        const latest = jobsRef.current.find((job) => (
          matchesDraftTarget(job, sync.target)
        ));
        if (latest) {
          dispatch({
            type: "patch",
            id,
            patch: { serverDraftPending: false }
          });
        }
        changed = true;
      }
    }
    for (const job of jobsRef.current) {
      if (
        job.serverDraftPending
        && draftSyncTarget(job)
        && !syncsRef.current.has(job.id)
      ) scheduleRef.current(job.id);
    }
    if (changed) publishSyncStateRef.current();
  });

  const updateJobDraft = useCallback((
    id: string,
    patch: Partial<ImageDraft>
  ) => {
    const current = jobsRef.current.find((job) => job.id === id);
    dispatch({ type: "patch-draft", id, patch });
    if (!current) return;
    dispatch({ type: "patch", id, patch: { serverDraftPending: true } });
    publishSyncStateRef.current();
    if (draftSyncTarget(current)) scheduleRef.current(id);
  }, [dispatch, jobsRef]);

  const flushPendingUpdates = useCallback(async () => {
    if (scheduledTimerRef.current) clearTimeout(scheduledTimerRef.current);
    scheduledTimerRef.current = null;
    scheduledIdsRef.current.clear();
    const results = await flushBatchRef.current([...syncsRef.current.keys()]);
    if ([...results.values()].some((result) => !result)) {
      throw new Error("部分内容接入草稿未能同步，请刷新后重试");
    }
  }, []);

  const retryPendingUpdates = useCallback(async () => {
    const entries = [...syncsRef.current].filter(([, sync]) => (
      sync.retryable && !sync.running
    ));
    if (!entries.length) return true;
    try {
      const statuses: Awaited<ReturnType<typeof getIngestionStatuses>> = [];
      for (
        let offset = 0;
        offset < entries.length;
        offset += ingestionStatusBatchMaxItems
      ) {
        const chunk = entries.slice(offset, offset + ingestionStatusBatchMaxItems);
        const response = await getIngestionStatuses(chunk.map(([, sync]) => ({
          session_id: sync.target.sessionId,
          image_id: sync.target.imageId
        })));
        observeCompletedIngestionsRef.current(
          completedIngestionObservations(response)
        );
        statuses.push(...response);
      }
      const retryIds: string[] = [];
      let terminalFailures = 0;
      for (const [index, [id, original]] of entries.entries()) {
        const sync = syncsRef.current.get(id);
        if (!sync || sync !== original) continue;
        const status = statuses[index];
        if (status?.status === "present" && !status.item.commit) {
          sync.target = {
            ...sync.target,
            expectedVersion: Math.max(
              sync.target.expectedVersion,
              status.item.version
            )
          };
          sync.dirty = true;
          sync.retryable = false;
          sync.awaitingRevision = null;
          sync.awaitingConnectionGeneration = null;
          retryIds.push(id);
          continue;
        }
        retireSync(id, sync, authoritativeDraftFromStatus(status));
        terminalFailures += 1;
      }
      publishSyncStateRef.current();
      if (terminalFailures) {
        reportErrorRef.current(
          `${terminalFailures} 个内容接入任务已完成、丢失或冻结提交，无法再写入保留草稿`,
          false
        );
      }
      const retried = await flushBatchRef.current(retryIds);
      return terminalFailures === 0
        && [...retried.values()].every(Boolean);
    } catch (error) {
      for (const [id, sync] of entries) {
        if (syncsRef.current.get(id) === sync) {
          sync.dirty = true;
          sync.retryable = true;
        }
      }
      reportErrorRef.current(
        error instanceof Error ? error.message : String(error),
        true
      );
      serverRef.current.refresh();
      publishSyncStateRef.current();
      return false;
    }
  }, [retireSync]);

  const updateDuplicateDecision = useCallback((
    id: string,
    duplicateDecision: "upload" | "confirmed"
  ) => {
    const initial = jobsRef.current.find((job) => job.id === id);
    const initialTarget = initial ? draftSyncTarget(initial) : null;
    if (!initialTarget) return Promise.resolve(false);
    const existing = duplicateDecisionRequestsRef.current.get(id);
    if (existing && initial && matchesDraftTarget(initial, existing.target)) {
      if (existing.duplicateDecision === duplicateDecision) {
        return existing.promise;
      }
      return existing.promise.then(() => (
        duplicateDecisionRef.current(id, duplicateDecision)
      ));
    }

    const promise = (async () => {
      if (!await flushRef.current(id)) return false;
      const current = jobsRef.current.find((job) => job.id === id);
      const requestTarget = current ? draftSyncTarget(current) : null;
      if (
        !current
        || !requestTarget
        || !matchesDraftTarget(current, initialTarget)
      ) return false;
      let result;
      let requestConnectionGeneration: number;
      try {
        const update = await updateStoredIngestionsWithResponseRetry([{
          session_id: requestTarget.sessionId,
          image_id: requestTarget.imageId,
          expected_version: requestTarget.expectedVersion,
          duplicate_decision: duplicateDecision
        }], () => serverRef.current.connectionGeneration);
        result = update.response.items[0];
        requestConnectionGeneration = update.requestConnectionGeneration;
      } catch (error) {
        const latest = jobsRef.current.find((job) => job.id === id);
        if (latest && matchesDraftTarget(latest, requestTarget)) {
          reportErrorRef.current(
            error instanceof Error ? error.message : String(error),
            false
          );
        }
        serverRef.current.refresh();
        return false;
      }
      const latest = jobsRef.current.find((job) => job.id === id);
      if (!latest || !matchesDraftTarget(latest, requestTarget)) {
        serverRef.current.refresh();
        return false;
      }
      if (!result || result.status === "failed") {
        reportErrorRef.current(
          result?.message ?? "重复决定更新响应缺少当前任务",
          false
        );
        serverRef.current.refresh();
        return false;
      }
      if ((latest.serverVersion ?? 0) > result.version) {
        serverRef.current.refresh();
        return latest.duplicateDecision === result.duplicate_decision;
      }
      dispatch({
        type: "patch",
        id,
        patch: {
          duplicateDecision: result.duplicate_decision,
          duplicateCount: result.duplicate_count,
          ...(result.duplicate_count === 0 ? { duplicates: [] } : {}),
          serverVersion: result.version,
          serverSemanticRevision: result.last_semantic_revision,
          serverDraftPending: true,
          message: result.duplicate_decision === "confirmed"
            ? "已确认提交副本"
            : ingestionDuplicateMessage(result.duplicate_count)
        }
      });
      const patched = jobsRef.current.find((job) => job.id === id);
      const target = patched && matchesDraftTarget(patched, requestTarget)
        ? draftSyncTarget(patched)
        : null;
      if (target) {
        const existingSync = syncsRef.current.get(id);
        const sync = existingSync
          && patched
          && matchesDraftTarget(patched, existingSync.target)
          ? existingSync
          : {
              running: null,
              dirty: false,
              retryable: false,
              target,
              awaitingRevision: null,
              awaitingConnectionGeneration: null
            };
        sync.target = target;
        sync.retryable = false;
        sync.awaitingRevision = result.last_semantic_revision;
        sync.awaitingConnectionGeneration = requestConnectionGeneration;
        syncsRef.current.set(id, sync);
        publishSyncStateRef.current();
      }
      return true;
    })();
    const request = { target: initialTarget, duplicateDecision, promise };
    duplicateDecisionRequestsRef.current.set(id, request);
    void promise.then(
      () => {
        if (duplicateDecisionRequestsRef.current.get(id) === request) {
          duplicateDecisionRequestsRef.current.delete(id);
        }
      },
      () => {
        if (duplicateDecisionRequestsRef.current.get(id) === request) {
          duplicateDecisionRequestsRef.current.delete(id);
        }
      }
    );
    return promise;
  }, [dispatch, jobsRef]);
  duplicateDecisionRef.current = updateDuplicateDecision;
  const scheduleJob = useCallback((id: string) => {
    scheduleRef.current(id);
  }, []);
  const ensureJobSnapshot = useCallback((job: IngestionJob) => {
    ensureSnapshotRef.current(job);
  }, []);
  const retirePairOwners = useCallback((pairKeys: ReadonlySet<string>) => {
    if (!pairKeys.size) return;
    for (const [id, sync] of syncsRef.current) {
      const pairKey = serverIngestionPairKey({
        session_id: sync.target.sessionId,
        image_id: sync.target.imageId
      });
      if (!pairKeys.has(pairKey)) continue;
      syncsRef.current.delete(id);
      scheduledIdsRef.current.delete(id);
    }
    if (scheduledTimerRef.current && !scheduledIdsRef.current.size) {
      clearTimeout(scheduledTimerRef.current);
      scheduledTimerRef.current = null;
    }
    // The reducer may already have removed a serverDraftPending card even
    // when no debounce entry existed yet, so publish the latest retry state
    // after retiring an incarnation pair.
    publishSyncStateRef.current();
  }, []);
  const pairKeysForSession = useCallback((sessionId: string) => (
    new Set([...syncsRef.current.values()].flatMap((sync) => (
      sync.target.sessionId === sessionId
        ? [serverIngestionPairKey({
            session_id: sync.target.sessionId,
            image_id: sync.target.imageId
          })]
        : []
    )))
  ), []);

  return {
    updateJobDraft,
    flushPendingUpdates,
    updateDuplicateDecision,
    scheduleJob,
    ensureJobSnapshot,
    retirePairOwners,
    pairKeysForSession,
    retryPendingUpdates,
    hasPendingUpdates,
    hasRetryableUpdates
  };
}
