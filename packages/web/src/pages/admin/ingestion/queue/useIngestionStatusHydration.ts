import { useEffect, type RefObject } from "react";
import {
  ingestionStatusBatchMaxItems,
  type IngestionSessionPairDto
} from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../../lib/types.js";
import { getIngestionStatuses } from "./ingestion-api.js";
import {
  completedIngestionObservations,
  type CompletedIngestionObservation
} from "./ingestion-queue-api.js";
import type { IngestionQueueAction } from "./model/ingestion-queue-state.js";
import {
  ingestionHandoffRetryDecision,
  ingestionJobFromKnownCompletedStatus,
  ingestionJobFromServerItem,
  serverIngestionJobPairKey
} from "./model/server-ingestion-job.js";
import { ingestionStatusEventPatch } from "./model/ingestion-status-state.js";
import type {
  DetachedProvisionalHandoff,
  HandoffRetryGate,
  ServerQueueConnectionSnapshot
} from "./model/ingestion-handoff-runtime.js";
import type { ServerIngestionQueueController } from "./useServerIngestionQueue.js";

/**
 * Owns the bounded status-read AbortController used while canonical authority
 * is outside the current snapshot. SSE and snapshot connection ownership stay
 * in useServerIngestionQueue; this Hook resolves the explicit handoff set and
 * compact completed receipts through the same bounded status request owner.
 */
export function useIngestionStatusHydration({
  server,
  serverConnectionRef,
  handoffJobsRef,
  retryGatesRef,
  detachedHandoffsRef,
  completedPairsRef,
  completedReceiptHydrationsRef,
  jobsRef,
  dispatch,
  ensureDraftSnapshot,
  retireDraftPairs,
  resolveExternalStatuses,
  verifyExternalStatusRevisions,
  observeCompletedIngestions,
  handoffEpoch,
  statusRetryEpoch,
  bumpHandoffEpoch,
  reportError,
  revokeObjectUrl
}: {
  server: ServerIngestionQueueController;
  serverConnectionRef: RefObject<ServerQueueConnectionSnapshot>;
  handoffJobsRef: RefObject<Map<string, IngestionJob>>;
  retryGatesRef: RefObject<Map<string, HandoffRetryGate>>;
  detachedHandoffsRef: RefObject<Map<string, DetachedProvisionalHandoff>>;
  completedPairsRef: RefObject<Set<string>>;
  completedReceiptHydrationsRef: RefObject<
    Map<string, IngestionSessionPairDto>
  >;
  jobsRef: RefObject<IngestionJob[]>;
  dispatch: (action: IngestionQueueAction) => boolean;
  ensureDraftSnapshot: (job: IngestionJob) => void;
  retireDraftPairs: (pairKeys: ReadonlySet<string>) => void;
  resolveExternalStatuses: (pairKeys: ReadonlySet<string>) => void;
  verifyExternalStatusRevisions: (revisions: ReadonlyMap<string, number>) => void;
  observeCompletedIngestions: (
    entries: readonly CompletedIngestionObservation[]
  ) => void;
  handoffEpoch: number;
  statusRetryEpoch: number;
  bumpHandoffEpoch: () => void;
  reportError: (message: string, retryable?: boolean) => void;
  revokeObjectUrl: (job: IngestionJob) => void;
}) {
  useEffect(() => {
    if (
      server.status !== "ready"
      || !handoffJobsRef.current.size
        && !completedReceiptHydrationsRef.current.size
    ) return;
    const controller = new AbortController();
    const requestRevision = serverConnectionRef.current.revision;
    const entriesByPair = new Map<string, {
      pairKey: string;
      pair: IngestionSessionPairDto;
      job?: IngestionJob;
      completedReceipt?: IngestionSessionPairDto;
    }>();
    for (const [pairKey, job] of handoffJobsRef.current) {
      const eligible = (() => {
        const retryAfter = retryGatesRef.current.get(pairKey);
        return retryAfter === undefined
          || retryAfter.connectionGeneration !== server.connectionGeneration
          || retryAfter.mode === "state-change"
            && requestRevision !== null
            && requestRevision > retryAfter.revision;
      })();
      if (!eligible) continue;
      entriesByPair.set(pairKey, {
        pairKey,
        job,
        pair: {
          session_id: job.sessionId!,
          image_id: job.imageId!
        }
      });
    }
    for (
      const [pairKey, completedReceipt]
      of completedReceiptHydrationsRef.current
    ) {
      entriesByPair.set(pairKey, {
        ...entriesByPair.get(pairKey),
        pairKey,
        pair: completedReceipt,
        completedReceipt
      });
    }
    const entries = [...entriesByPair.values()];
    if (!entries.length) return;
    void (async () => {
      const completedJobs: IngestionJob[] = [];
      const completedInvalidations: CompletedIngestionObservation[] = [];
      const completedPatches = new Map<string, Partial<IngestionJob>>();
      const presentPatches = new Map<string, Partial<IngestionJob>>();
      const resolvedExternalStatuses = new Set<string>();
      const verifiedExternalRevisions = new Map<string, number>();
      let handoffChanged = false;
      let retryImmediately = false;
      let minimumCoverageRevision: number | null = null;
      const requireSnapshotCoverage = (pairKey: string, revision: number) => {
        retryGatesRef.current.set(pairKey, {
          connectionGeneration: server.connectionGeneration,
          revision,
          mode: "coverage"
        });
        verifiedExternalRevisions.set(pairKey, revision);
        handoffChanged = true;
        if ((serverConnectionRef.current.revision ?? -1) < revision) {
          minimumCoverageRevision = Math.max(
            minimumCoverageRevision ?? 0,
            revision
          );
        }
      };
      try {
        // One effect owns exactly one bounded request. Applying this chunk may
        // advance handoffEpoch and therefore retire this effect; the next
        // effect consumes the remaining tail without racing an already-issued
        // request from the previous owner.
        const chunk = entries.slice(0, ingestionStatusBatchMaxItems);
        const statuses = await getIngestionStatuses(
          chunk.map((entry) => entry.pair),
          controller.signal
        );
        if (controller.signal.aborted) return;
        for (const [index, entry] of chunk.entries()) {
          const status = statuses[index];
          if (!status) continue;
          const activeHandoff = entry.job !== undefined
            && handoffJobsRef.current.get(entry.pairKey) === entry.job;
          const activeCompletedReceipt = entry.completedReceipt !== undefined
            && completedReceiptHydrationsRef.current.get(entry.pairKey)
              === entry.completedReceipt;
          if (!activeHandoff && !activeCompletedReceipt) continue;
          completedInvalidations.push(...completedIngestionObservations([status]));
          if (activeCompletedReceipt) {
            // Keep the compact pair owned until this successful chunk can
            // project all of its PostgreSQL DTOs. The shared completion
            // observer below then consumes the pair together with its card
            // update and pending image-data invalidation.
            if (status.status !== "completed" && !activeHandoff) {
              reportError("已完成图片的最终结果暂时无法读取", true);
              continue;
            }
          }
          const entryJob = entry.job;
          if (!activeHandoff || !entryJob) continue;
          const awaitsCompleted = completedPairsRef.current.has(entry.pairKey);
          if (
            status.status === "present"
            && entryJob.serverDraftPending === true
          ) {
            ensureDraftSnapshot(entryJob);
          }
          if (status.status === "present" && awaitsCompleted) {
            const retry = ingestionHandoffRetryDecision(
              requestRevision,
              serverConnectionRef.current.revision,
              status.item.last_semantic_revision
            );
            if (retry.retryImmediately) {
              retryGatesRef.current.delete(entry.pairKey);
              retryImmediately = true;
            } else {
              retryGatesRef.current.set(entry.pairKey, {
                connectionGeneration: server.connectionGeneration,
                revision: retry.retryAfterRevision,
                mode: "state-change"
              });
            }
            continue;
          }
          if (status.status === "present") {
            const current = jobsRef.current.find((job) => (
              job.id === entryJob.id
              && job.attemptKey === entryJob.attemptKey
            ));
            if (current) {
              const next = {
                ...ingestionJobFromServerItem(
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
              job.id === entryJob.id
              && job.attemptKey === entryJob.attemptKey
              && serverIngestionJobPairKey(job) === entry.pairKey
            ));
            const retainedJob = current ?? entryJob;
            const patch = ingestionStatusEventPatch(retainedJob, status);
            if (patch) {
              if (current) presentPatches.set(current.id, patch);
              else completedJobs.push({ ...retainedJob, ...patch });
            }
            handoffJobsRef.current.delete(entry.pairKey);
            retryGatesRef.current.delete(entry.pairKey);
            detachedHandoffsRef.current.delete(entry.pairKey);
            completedPairsRef.current.delete(entry.pairKey);
            retireDraftPairs(new Set([entry.pairKey]));
            handoffChanged = true;
            resolvedExternalStatuses.add(entry.pairKey);
            continue;
          }
          if (status.status === "completed") {
            if (status.redis_status === "active") {
              const retry = ingestionHandoffRetryDecision(
                requestRevision,
                serverConnectionRef.current.revision,
                status.redis_last_semantic_revision ?? 0
              );
              if (retry.retryImmediately) {
                retryGatesRef.current.delete(entry.pairKey);
                retryImmediately = true;
              } else {
                retryGatesRef.current.set(entry.pairKey, {
                  connectionGeneration: server.connectionGeneration,
                  revision: retry.retryAfterRevision,
                  mode: "state-change"
                });
              }
              continue;
            }
            if (status.redis_status === "completed") {
              const revision = status.redis_last_semantic_revision;
              if (revision === undefined) {
                const previous = retryGatesRef.current.get(entry.pairKey);
                retryGatesRef.current.set(entry.pairKey, {
                  connectionGeneration: server.connectionGeneration,
                  revision: Math.max(
                    previous?.connectionGeneration === server.connectionGeneration
                      ? previous.revision
                      : 0,
                    requestRevision ?? 0
                  ),
                  mode: "state-change"
                });
                continue;
              }
              requireSnapshotCoverage(entry.pairKey, revision);
              continue;
            }
            const current = jobsRef.current.find((job) => (
              job.id === entryJob.id
              && job.attemptKey === entryJob.attemptKey
              && serverIngestionJobPairKey(job) === entry.pairKey
            ));
            const completedJob = ingestionJobFromKnownCompletedStatus(
              current ?? entryJob,
              status
            );
            if (completedJob) {
              if (current) completedPatches.set(current.id, completedJob);
              else completedJobs.push(completedJob);
            }
          }
          handoffJobsRef.current.delete(entry.pairKey);
          retryGatesRef.current.delete(entry.pairKey);
          detachedHandoffsRef.current.delete(entry.pairKey);
          completedPairsRef.current.delete(entry.pairKey);
          handoffChanged = true;
          resolvedExternalStatuses.add(entry.pairKey);
          revokeObjectUrl(entryJob);
        }
        if (presentPatches.size) {
          dispatch({ type: "patch-many", patches: presentPatches });
        }
        if (completedPatches.size) {
          dispatch({ type: "patch-many", patches: completedPatches });
        }
        if (completedJobs.length) {
          dispatch({ type: "append", jobs: completedJobs });
        }
        // Let source-specific missing-receipt hydration release its Blob and
        // mount decisions first; the shared observer then updates any other
        // retained exact-pair owner and deduplicates image-data invalidation.
        observeCompletedIngestions(completedInvalidations);
        if (resolvedExternalStatuses.size) {
          resolveExternalStatuses(resolvedExternalStatuses);
        }
        if (verifiedExternalRevisions.size) {
          verifyExternalStatusRevisions(verifiedExternalRevisions);
        }
        if (
          handoffChanged
          || retryImmediately
          || entries.length > chunk.length
        ) bumpHandoffEpoch();
        if (minimumCoverageRevision !== null) {
          server.ensureRevision(
            minimumCoverageRevision,
            server.connectionGeneration
          );
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          reportError(
            error instanceof Error ? error.message : String(error),
            true
          );
        }
      }
    })();
    return () => controller.abort();
  }, [
    bumpHandoffEpoch,
    dispatch,
    ensureDraftSnapshot,
    handoffEpoch,
    observeCompletedIngestions,
    reportError,
    resolveExternalStatuses,
    retireDraftPairs,
    revokeObjectUrl,
    server.connectionGeneration,
    server.ensureRevision,
    server.status,
    statusRetryEpoch,
    verifyExternalStatusRevisions
  ]);
}
