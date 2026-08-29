import { useCallback, useEffect, useRef, useState } from "react";
import {
  ingestionStatusBatchMaxItems,
  type IngestionSessionPairDto
} from "@imageshow/shared/browser";
import type { IngestionJob } from "../../../../lib/types.js";
import type {
  IngestionQueueAction,
  IngestionServerBinding
} from "./model/ingestion-queue-state.js";
import { getIngestionStatuses } from "./ingestion-api.js";
import {
  completedIngestionObservations,
  type CompletedIngestionObservation
} from "./ingestion-queue-api.js";
import {
  ingestionJobAwaitsActionCoverage,
  ingestionJobHasServerAuthority,
  serverIngestionJobPairKey,
  serverIngestionPairKey
} from "./model/server-ingestion-job.js";
import type { ServerIngestionQueueController } from "./useServerIngestionQueue.js";

type AuthorityHandoffFence = Readonly<{
  pair: IngestionSessionPairDto;
  connectionGeneration: number;
  revision?: number;
  completionRequired: boolean;
  statusCheckRequired: boolean;
  externalStatusOwner: boolean;
  statusRetryAfterRevision?: number;
}>;

type ScheduledAuthorityCoverage = Readonly<{
  connectionGeneration: number;
  unknown: boolean;
  revision?: number;
}>;

/**
 * Keep HTTP -> status-channel ownership fences independent of the bounded
 * page DTOs. A pair may leave the mounted page before its accept/completed
 * revision reaches the signed action watermark, so card state cannot own
 * this lifecycle.
 */
export function useIngestionAuthorityHandoffs(input: Readonly<{
  jobs: readonly IngestionJob[];
  jobsRef: Readonly<{ current: readonly IngestionJob[] }>;
  dispatch: (action: IngestionQueueAction) => boolean;
  server: ServerIngestionQueueController;
  reportError: (message: string, retryable?: boolean) => void;
  promoteReconnectOwners: (
    pairKeys: ReadonlySet<string>
  ) => ReadonlySet<string>;
  observeCompletedIngestions: (
    entries: readonly CompletedIngestionObservation[]
  ) => void;
}>) {
  const fencesRef = useRef(new Map<string, AuthorityHandoffFence>());
  const serverRef = useRef(input.server);
  serverRef.current = input.server;
  const reportErrorRef = useRef(input.reportError);
  reportErrorRef.current = input.reportError;
  const dispatchRef = useRef(input.dispatch);
  dispatchRef.current = input.dispatch;
  const jobsRefRef = useRef(input.jobsRef);
  jobsRefRef.current = input.jobsRef;
  const observeCompletedIngestionsRef = useRef(input.observeCompletedIngestions);
  observeCompletedIngestionsRef.current = input.observeCompletedIngestions;
  const scheduledCoverageRef = useRef<Map<
    string,
    ScheduledAuthorityCoverage
  > | null>(
    null
  );
  const [fenceEpoch, setFenceEpoch] = useState(0);

  const clearFences = useCallback((pairKeys: ReadonlySet<string>) => {
    let changed = false;
    for (const pairKey of pairKeys) {
      changed = fencesRef.current.delete(pairKey) || changed;
      scheduledCoverageRef.current?.delete(pairKey);
    }
    if (scheduledCoverageRef.current?.size === 0) {
      scheduledCoverageRef.current = null;
    }
    if (!changed) return;
    const patches = new Map<string, Partial<IngestionJob>>();
    for (const job of jobsRefRef.current.current) {
      if (
        job.serverHandoffPending === true
        && pairKeys.has(serverIngestionJobPairKey(job))
      ) {
        patches.set(job.id, {
          serverHandoffPending: false,
          serverHandoffRevision: undefined
        });
      }
    }
    if (patches.size) dispatchRef.current({ type: "patch-many", patches });
    setFenceEpoch((current) => current + 1);
  }, []);

  const verifyFenceRevisions = useCallback((
    revisions: ReadonlyMap<string, number>
  ) => {
    let changed = false;
    for (const [pairKey, revision] of revisions) {
      const current = fencesRef.current.get(pairKey);
      if (!current) continue;
      if (
        current.revision === revision
        && !current.statusCheckRequired
      ) continue;
      fencesRef.current.set(pairKey, {
        ...current,
        revision,
        statusCheckRequired: false,
        statusRetryAfterRevision: undefined
      });
      changed = true;
    }
    if (changed) setFenceEpoch((current) => current + 1);
  }, []);

  const deferFenceStatusChecks = useCallback((
    revisions: ReadonlyMap<string, number>
  ) => {
    let changed = false;
    for (const [pairKey, revision] of revisions) {
      const current = fencesRef.current.get(pairKey);
      if (!current || current.externalStatusOwner) continue;
      fencesRef.current.set(pairKey, {
        ...current,
        statusCheckRequired: false,
        statusRetryAfterRevision: revision
      });
      changed = true;
    }
    if (changed) setFenceEpoch((current) => current + 1);
  }, []);

  const prepareBinding = useCallback((
    binding: IngestionServerBinding,
    requestConnectionGeneration?: number | null,
    externalStatusOwner = false
  ) => {
    const server = serverRef.current;
    const requestGeneration = requestConnectionGeneration === undefined
      ? server.connectionGeneration
      : requestConnectionGeneration;
    const responseBelongsToCurrentGeneration = requestGeneration !== null
      && requestGeneration === server.connectionGeneration;
    if (binding.serverHandoffPending !== true) return binding;

    const pairKey = serverIngestionPairKey({
      session_id: binding.sessionId,
      image_id: binding.imageId
    });
    const current = fencesRef.current.get(pairKey);
    const sameGeneration = current?.connectionGeneration
      === server.connectionGeneration;
    const existingRevision = sameGeneration ? current?.revision : undefined;
    const responseRevision = responseBelongsToCurrentGeneration
      ? binding.serverHandoffRevision
      : undefined;
    const revision = existingRevision !== undefined
      && responseRevision !== undefined
      ? Math.max(existingRevision, responseRevision)
      : existingRevision ?? responseRevision;
    const responseCompletionRequired = binding.serverHandoffRevision === undefined;
    const completionRequired = sameGeneration
      ? current?.completionRequired === true || responseCompletionRequired
      : responseCompletionRequired;
    const effectiveExternalStatusOwner = sameGeneration
      ? current.externalStatusOwner || externalStatusOwner
      : externalStatusOwner;
    const statusCheckRequired = !effectiveExternalStatusOwner && (
      sameGeneration
        ? current.statusCheckRequired
          || revision === undefined
          || requestGeneration === null
          || requestGeneration !== server.connectionGeneration
        : revision === undefined
          || requestGeneration === null
          || requestGeneration !== server.connectionGeneration
    );
    fencesRef.current.set(pairKey, {
      pair: {
        session_id: binding.sessionId,
        image_id: binding.imageId
      },
      connectionGeneration: server.connectionGeneration,
      completionRequired,
      statusCheckRequired,
      externalStatusOwner: effectiveExternalStatusOwner,
      statusRetryAfterRevision: statusCheckRequired
        ? undefined
        : current?.statusRetryAfterRevision,
      ...(revision === undefined ? {} : { revision })
    });
    setFenceEpoch((value) => value + 1);

    if (responseBelongsToCurrentGeneration) {
      const coverageAlreadyScheduled = scheduledCoverageRef.current !== null;
      const scheduledCoverage = scheduledCoverageRef.current
        ?? new Map<string, ScheduledAuthorityCoverage>();
      const scheduled = scheduledCoverage.get(pairKey);
      const scheduledRevision = scheduled?.connectionGeneration
        === server.connectionGeneration
        ? scheduled.revision
        : undefined;
      const hadScheduledPair = scheduled?.connectionGeneration
        === server.connectionGeneration;
      const unknown = (
        hadScheduledPair && scheduled.unknown
      ) || revision === undefined;
      let combinedRevision: number | undefined;
      if (!hadScheduledPair) {
        combinedRevision = revision;
      } else {
        combinedRevision = scheduledRevision !== undefined
          && revision !== undefined
          ? Math.max(scheduledRevision, revision)
          : scheduledRevision ?? revision;
      }
      scheduledCoverage.set(pairKey, {
        connectionGeneration: server.connectionGeneration,
        unknown,
        ...(combinedRevision === undefined ? {} : { revision: combinedRevision })
      });
      scheduledCoverageRef.current = scheduledCoverage;
      if (!coverageAlreadyScheduled) {
        queueMicrotask(() => {
          const coverage = scheduledCoverageRef.current;
          scheduledCoverageRef.current = null;
          if (!coverage?.size) return;
          const currentGeneration = serverRef.current.connectionGeneration;
          const currentCoverage = [...coverage.values()].filter((entry) => (
            entry.connectionGeneration === currentGeneration
          ));
          if (!currentCoverage.length) return;
          const unknown = currentCoverage.some((entry) => entry.unknown);
          const hasKnownRevision = currentCoverage.some((entry) => (
            entry.revision !== undefined
          ));
          const maximumRevision = currentCoverage.reduce<number>(
            (maximum, entry) => entry.revision === undefined
              ? maximum
              : Math.max(maximum, entry.revision),
            0
          );
          if (unknown) {
            serverRef.current.ensureRevision(undefined, currentGeneration);
          }
          if (hasKnownRevision) {
            serverRef.current.ensureRevision(
              maximumRevision,
              currentGeneration
            );
          }
        });
      }
    }
    return binding;
  }, []);

  const retry = useCallback(() => {
    let changed = false;
    for (const [pairKey, fence] of fencesRef.current) {
      if (fence.externalStatusOwner || fence.statusCheckRequired) continue;
      fencesRef.current.set(pairKey, {
        ...fence,
        statusCheckRequired: true,
        statusRetryAfterRevision: undefined
      });
      changed = true;
    }
    if (changed || fencesRef.current.size) {
      setFenceEpoch((current) => current + 1);
    }
  }, []);

  const resolveExternalStatuses = useCallback((
    pairKeys: ReadonlySet<string>
  ) => {
    const owned = new Set([...pairKeys].filter((pairKey) => (
      fencesRef.current.get(pairKey)?.externalStatusOwner === true
    )));
    if (owned.size) clearFences(owned);
  }, [clearFences]);

  const hasPair = useCallback((pairKey: string) => (
    fencesRef.current.has(pairKey)
  ), []);
  const hasExternalPair = useCallback((pairKey: string) => (
    fencesRef.current.get(pairKey)?.externalStatusOwner === true
  ), []);
  const pairKeysForSession = useCallback((sessionId: string) => (
    new Set([...fencesRef.current].flatMap(([pairKey, fence]) => (
      fence.pair.session_id === sessionId ? [pairKey] : []
    )))
  ), []);

  const verifyExternalStatusRevisions = useCallback((
    revisions: ReadonlyMap<string, number>
  ) => {
    const owned = new Map([...revisions].filter(([pairKey]) => (
      fencesRef.current.get(pairKey)?.externalStatusOwner === true
    )));
    if (owned.size) verifyFenceRevisions(owned);
  }, [verifyFenceRevisions]);

  useEffect(() => {
    if (input.server.status !== "ready") return;
    const covered = new Set<string>();
    let retryChanged = false;
    const reconnectPairs = new Set([...fencesRef.current].flatMap(
      ([pairKey, fence]) => (
        fence.connectionGeneration !== input.server.connectionGeneration
        && !fence.completionRequired
        && !fence.externalStatusOwner
          ? [pairKey]
          : []
      )
    ));
    const promotedPairs = reconnectPairs.size
      ? input.promoteReconnectOwners(reconnectPairs)
      : new Set<string>();
    for (const [pairKey, fence] of fencesRef.current) {
      if (fence.connectionGeneration !== input.server.connectionGeneration) {
        const externalStatusOwner = fence.externalStatusOwner
          || promotedPairs.has(pairKey);
        fencesRef.current.set(pairKey, {
          ...fence,
          connectionGeneration: input.server.connectionGeneration,
          externalStatusOwner,
          statusCheckRequired: !externalStatusOwner,
          statusRetryAfterRevision: undefined,
          revision: undefined
        });
        retryChanged = true;
      } else if (
          !fence.externalStatusOwner
          && !fence.statusCheckRequired
          && fence.statusRetryAfterRevision === undefined
          && fence.revision !== undefined
          && input.server.revision !== null
          && fence.revision <= input.server.revision
      ) {
        covered.add(pairKey);
      } else if (
        !fence.externalStatusOwner
        && !fence.statusCheckRequired
        && fence.statusRetryAfterRevision !== undefined
        && input.server.revision !== null
        && input.server.revision > fence.statusRetryAfterRevision
      ) {
        fencesRef.current.set(pairKey, {
          ...fence,
          statusCheckRequired: true,
          statusRetryAfterRevision: undefined
        });
        retryChanged = true;
      }
    }
    if (covered.size) clearFences(covered);
    if (retryChanged) setFenceEpoch((current) => current + 1);
  }, [
    clearFences,
    fenceEpoch,
    input.server.connectionGeneration,
    input.promoteReconnectOwners,
    input.server.revision,
    input.server.status
  ]);

  useEffect(() => {
    if (input.server.status !== "ready") return;
    const generation = input.server.connectionGeneration;
    const entries = [...fencesRef.current].filter(([, fence]) => (
      fence.connectionGeneration === generation
      && fence.statusCheckRequired
    ));
    if (!entries.length) return;
    const controller = new AbortController();
    const requestRevision = serverRef.current.revision;
    void (async () => {
      const resolved = new Set<string>();
      const revisions = new Map<string, number>();
      const deferred = new Map<string, number>();
      try {
        for (
          let offset = 0;
          offset < entries.length;
          offset += ingestionStatusBatchMaxItems
        ) {
          const chunk = entries.slice(offset, offset + ingestionStatusBatchMaxItems);
          const statuses = await getIngestionStatuses(
            chunk.map(([, fence]) => fence.pair),
            controller.signal
          );
          if (controller.signal.aborted) return;
          observeCompletedIngestionsRef.current(
            completedIngestionObservations(statuses)
          );
          for (const [index, [pairKey]] of chunk.entries()) {
            const current = fencesRef.current.get(pairKey);
            if (
              !current
              || current.connectionGeneration !== generation
              || !current.statusCheckRequired
            ) continue;
            const status = statuses[index];
            if (!status) continue;
            if (status.status === "present") {
              if (current.completionRequired) {
                resolved.add(pairKey);
              } else {
                revisions.set(
                  pairKey,
                  status.item.last_semantic_revision
                );
              }
              continue;
            }
            if (status.status === "missing") {
              resolved.add(pairKey);
              continue;
            }
            if (status.redis_status === "missing") {
              resolved.add(pairKey);
            } else if (
              (
                status.redis_status === "completed"
                || !current.completionRequired
              )
              && status.redis_last_semantic_revision !== undefined
            ) {
              revisions.set(
                pairKey,
                status.redis_last_semantic_revision
              );
            } else if (
              current.completionRequired
              && status.redis_status === "active"
            ) {
              deferred.set(pairKey, Math.max(
                requestRevision ?? 0,
                status.redis_last_semantic_revision ?? 0
              ));
            }
          }
        }
        if (revisions.size) {
          verifyFenceRevisions(revisions);
          const maximumRevision = [...revisions.values()].reduce(
            (maximum, revision) => Math.max(maximum, revision),
            0
          );
          serverRef.current.ensureRevision(
            maximumRevision,
            generation
          );
        }
        if (deferred.size) deferFenceStatusChecks(deferred);
        if (resolved.size) clearFences(resolved);
      } catch (error) {
        if (!controller.signal.aborted) {
          reportErrorRef.current(
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    })();
    return () => controller.abort();
  }, [
    clearFences,
    deferFenceStatusChecks,
    fenceEpoch,
    input.server.connectionGeneration,
    input.server.status,
    verifyFenceRevisions
  ]);

  useEffect(() => () => {
    fencesRef.current.clear();
  }, []);

  return {
    prepareBinding,
    hasExternalPair,
    hasPair,
    pairKeysForSession,
    resolvePairs: clearFences,
    resolveExternalStatuses,
    verifyExternalStatusRevisions,
    retry,
    // This internal diagnostic is consumed by the queue integration tests to
    // assert that HTTP-to-snapshot fences settle. It no longer drives visible
    // button state.
    pending: fencesRef.current.size > 0 || input.jobs.some((job) => (
      ingestionJobHasServerAuthority(job)
      && ingestionJobAwaitsActionCoverage(job, input.server.revision)
    ))
  };
}
