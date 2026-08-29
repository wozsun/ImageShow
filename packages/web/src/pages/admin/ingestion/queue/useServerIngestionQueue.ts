import { useCallback, useEffect, useRef, useState } from "react";
import {
  ingestionEventsPath,
  type IngestionQueueEventDto,
  type IngestionSessionPairDto,
  type IngestionQueueTypeDto
} from "@imageshow/shared/browser";
import { getIngestionQueueSnapshot } from "./ingestion-api.js";
import {
  baselineFromIngestionSnapshot,
  ingestionQueueBaselineCoversSelection,
  mergeIngestionQueueMutation,
  type IngestionQueueSnapshotSelection,
  type ServerIngestionQueueBaseline
} from "./model/server-ingestion-queue-state.js";
import type {
  CompletedIngestionObservation
} from "./ingestion-queue-api.js";
import {
  emptyServerIngestionQueueView,
  parseServerIngestionQueueEvent,
  readyServerIngestionQueueView,
  retainedServerIngestionQueueView,
  type ServerIngestionQueueStatus,
  type ServerIngestionQueueView
} from "./model/server-ingestion-queue-view.js";

const clientMutationBufferLimit = 1_000;
const snapshotRecoveryDelays = [100, 500, 1_500] as const;
const protocolReconnectDelays = [100, 500] as const;

type SnapshotRequestReason =
  | "refresh"
  | "parameters"
  | "reload"
  | "ready";

type SnapshotCoverageRequirements = {
  actionScope: string;
  connectionGeneration: number;
  currentScope: boolean;
  ordinarySnapshot: boolean;
  currentSelection: boolean;
  minimumRevision: number | null;
  minimumSnapshotSerial: number | null;
  postTriggerReason: Extract<SnapshotRequestReason, "refresh" | "reload"> | null;
};

type AuthorityRecovery = {
  minimumSnapshotSerial: number;
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
};

/**
 * Own exactly one SSE for one displayed owner + queue. Every ready event
 * starts a fresh action generation, while the last accepted page remains a
 * display-only baseline until the new bounded snapshot succeeds.
 */
export function useServerIngestionQueue(input: Readonly<{
  enabled: boolean;
  displayed: boolean;
  queue: IngestionQueueTypeDto;
  offset: number;
  limit: number;
  requiredItems: number;
  excludeItems: readonly IngestionSessionPairDto[];
  includeItems: readonly IngestionSessionPairDto[];
  onCompletedIngestions?: (
    entries: readonly CompletedIngestionObservation[]
  ) => void;
}>) {
  const [view, setView] = useState<ServerIngestionQueueView>(() => (
    emptyServerIngestionQueueView("idle", 0)
  ));
  const excludeKey = input.excludeItems.map((item) => (
    `${item.session_id}\0${item.image_id.toLowerCase()}`
  )).join("\u0001");
  const includeKey = input.includeItems.map((item) => (
    `${item.session_id}\0${item.image_id.toLowerCase()}`
  )).join("\u0001");
  const filterKey = `${excludeKey}\u0002${includeKey}`;
  const parametersRef = useRef({
    offset: input.offset,
    limit: input.limit,
    requiredItems: input.requiredItems,
    excludeItems: input.excludeItems,
    includeItems: input.includeItems
  });
  parametersRef.current = {
    offset: input.offset,
    limit: input.limit,
    requiredItems: input.requiredItems,
    excludeItems: input.excludeItems,
    includeItems: input.includeItems
  };
  const requestSnapshotRef = useRef<(
    (reason?: SnapshotRequestReason) => void
  ) | null>(null);
  const recoverAuthorityRef = useRef<(() => Promise<void>) | null>(null);
  const ensureRevisionRef = useRef<(
    (revision?: number, connectionGeneration?: number) => boolean
  ) | null>(null);
  const onCompletedIngestionsRef = useRef(input.onCompletedIngestions);
  onCompletedIngestionsRef.current = input.onCompletedIngestions;
  const displayedRef = useRef(input.displayed);
  displayedRef.current = input.displayed;
  const generationCounterRef = useRef(0);

  useEffect(() => {
    if (!input.enabled) {
      requestSnapshotRef.current = null;
      recoverAuthorityRef.current = null;
      setView((current) => emptyServerIngestionQueueView("idle", current.connectionGeneration));
      return;
    }

    const query = new URLSearchParams({ queue: input.queue });
    let source: EventSource | null = null;
    let disposed = false;
    let connectionGeneration = generationCounterRef.current;
    let actionScope = "";
    let baseline: ServerIngestionQueueBaseline | null = null;
    let baselineOffset: number | null = null;
    let baselineParameters: IngestionQueueSnapshotSelection | null = null;
    let retainedBaseline: ServerIngestionQueueBaseline | null = null;
    let retainedOffset: number | null = null;
    let snapshotSerial = 0;
    let activeSnapshot: Readonly<{
      controller: AbortController;
      offset: number;
    }> | null = null;
    let snapshotRequirements: SnapshotCoverageRequirements = {
      actionScope,
      connectionGeneration,
      currentScope: false,
      ordinarySnapshot: false,
      currentSelection: false,
      minimumRevision: null,
      minimumSnapshotSerial: null,
      postTriggerReason: null
    };
    let immediateSnapshotFollowup = false;
    let buffered: Array<Extract<IngestionQueueEventDto, { type: "mutation" }>> = [];
    let bufferedAuthorityBaseline: ServerIngestionQueueBaseline | null = null;
    let snapshotRecoveryAttempt = 0;
    let snapshotRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let readySnapshotScheduled = false;
    let authorityRecoverySnapshotScheduled = false;
    let protocolReconnectAttempt = 0;
    let protocolReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let authorityRecovery: AuthorityRecovery | null = null;

    const completeAuthorityRecovery = (serial: number) => {
      if (
        authorityRecovery === null
        || serial < authorityRecovery.minimumSnapshotSerial
      ) return;
      const completed = authorityRecovery;
      authorityRecovery = null;
      completed.resolve();
    };

    const failAuthorityRecovery = (error: unknown) => {
      if (authorityRecovery === null) return;
      const failed = authorityRecovery;
      authorityRecovery = null;
      failed.reject(error);
    };

    const cancelSnapshotRecoveryTimer = () => {
      if (snapshotRecoveryTimer !== null) {
        clearTimeout(snapshotRecoveryTimer);
        snapshotRecoveryTimer = null;
      }
    };

    const clearSnapshotRecovery = () => {
      cancelSnapshotRecoveryTimer();
      snapshotRecoveryAttempt = 0;
    };

    const clearBaseline = () => {
      baseline = null;
      baselineOffset = null;
      baselineParameters = null;
    };

    const alignSnapshotRequirements = (currentScope = false) => {
      if (
        snapshotRequirements.actionScope === actionScope
        && snapshotRequirements.connectionGeneration === connectionGeneration
      ) {
        if (currentScope) snapshotRequirements.currentScope = true;
        return;
      }
      snapshotRequirements = {
        actionScope,
        connectionGeneration,
        currentScope,
        ordinarySnapshot: snapshotRequirements.ordinarySnapshot,
        currentSelection: snapshotRequirements.currentSelection,
        // Semantic revisions belong to one Redis connection generation. A
        // new ready scope must establish its own baseline before handoff
        // owners can publish a new generation-specific revision requirement.
        minimumRevision: null,
        minimumSnapshotSerial: snapshotRequirements.minimumSnapshotSerial,
        postTriggerReason: snapshotRequirements.postTriggerReason
      };
    };

    const hasSnapshotRequirements = () => (
      snapshotRequirements.actionScope === actionScope
      && snapshotRequirements.connectionGeneration === connectionGeneration
      && (
        snapshotRequirements.currentScope
        || snapshotRequirements.ordinarySnapshot
        || snapshotRequirements.currentSelection
        || snapshotRequirements.minimumRevision !== null
        || snapshotRequirements.minimumSnapshotSerial !== null
      )
    );

    const nextSnapshotReason = (): SnapshotRequestReason | null => {
      if (!hasSnapshotRequirements()) return null;
      if (snapshotRequirements.postTriggerReason === "reload") return "reload";
      if (snapshotRequirements.currentScope) return "ready";
      if (
        snapshotRequirements.minimumSnapshotSerial !== null
        || snapshotRequirements.minimumRevision !== null
        || snapshotRequirements.ordinarySnapshot
      ) return "refresh";
      return snapshotRequirements.currentSelection ? "parameters" : null;
    };

    const requireSnapshotCoverage = (reason: SnapshotRequestReason) => {
      alignSnapshotRequirements(reason === "ready");
      if (reason === "refresh") {
        snapshotRequirements.ordinarySnapshot = true;
      } else if (reason === "parameters") {
        snapshotRequirements.currentSelection = true;
      } else if (reason === "reload") {
        snapshotRequirements.minimumSnapshotSerial = Math.max(
          snapshotRequirements.minimumSnapshotSerial ?? 0,
          snapshotSerial + 1
        );
        snapshotRequirements.postTriggerReason = "reload";
      }
    };

    const satisfySnapshotCoverage = (
      serial: number,
      requestedScope: string,
      requestedGeneration: number,
      merged: ServerIngestionQueueBaseline
    ) => {
      if (
        snapshotRequirements.actionScope !== requestedScope
        || snapshotRequirements.connectionGeneration !== requestedGeneration
      ) return;
      snapshotRequirements.currentScope = false;
      snapshotRequirements.ordinarySnapshot = false;
      snapshotRequirements.currentSelection = false;
      if (
        snapshotRequirements.minimumRevision !== null
        && merged.revision >= snapshotRequirements.minimumRevision
      ) snapshotRequirements.minimumRevision = null;
      if (
        snapshotRequirements.minimumSnapshotSerial !== null
        && serial >= snapshotRequirements.minimumSnapshotSerial
      ) {
        snapshotRequirements.minimumSnapshotSerial = null;
        snapshotRequirements.postTriggerReason = null;
      }
      immediateSnapshotFollowup = false;
    };

    const abortSnapshotRequest = (keepOffset?: number) => {
      if (
        activeSnapshot === null
        || keepOffset !== undefined && activeSnapshot.offset === keepOffset
      ) return;
      activeSnapshot.controller.abort();
      activeSnapshot = null;
      immediateSnapshotFollowup = false;
    };

    const invalidateSnapshotScope = () => {
      // A snapshot is authoritative only inside the SSE scope that started it.
      // Cancel exactly that obsolete request so a new ready generation cannot
      // wait forever behind a slow response from the previous scope.
      snapshotSerial += 1;
      abortSnapshotRequest();
      buffered = [];
      bufferedAuthorityBaseline = null;
    };

    const publishSnapshotState = (offset: number) => {
      if (baseline !== null && baselineOffset === offset) {
        // 同一 SSE scope 的旧 watermark 仍是有效且有界的点击边界：它最多
        // 处理旧 accepted-order 集合，绝不会纳入触发本次重读的新任务。
        // 因此同页后台收敛只替换卡片，不应让操作按钮暂时失去权威。
        setView(readyServerIngestionQueueView(connectionGeneration, actionScope, baseline));
        return;
      }
      const loadingBaseline = retainedBaseline !== null
        && retainedOffset === offset
        ? retainedBaseline
        : null;
      setView(loadingBaseline
        ? retainedServerIngestionQueueView(
          "loading",
          connectionGeneration,
          actionScope,
          loadingBaseline
        )
        : {
          ...emptyServerIngestionQueueView("loading", connectionGeneration),
          actionScope
        });
    };

    const mergeBufferedMutations = (current: ServerIngestionQueueBaseline) => {
      let merged = current;
      let reload = false;
      for (const event of buffered) {
        const result = mergeIngestionQueueMutation(merged, event);
        merged = result.baseline;
        if (result.kind === "reload") {
          reload = true;
          break;
        }
      }
      buffered = [];
      bufferedAuthorityBaseline = null;
      return { merged, reload };
    };

    const startSnapshot = (reason: SnapshotRequestReason) => {
      if (disposed) return;
      const {
        offset,
        limit,
        requiredItems,
        excludeItems,
        includeItems
      } = parametersRef.current;
      // Offset changes cancel the obsolete page. Same-scope, same-page reloads
      // share the active request. Its response is allowed to prove every
      // compatible requirement that accumulated while it was in flight.
      abortSnapshotRequest(offset);
      if (!actionScope) {
        if (source === null && protocolReconnectTimer === null) {
          protocolReconnectAttempt = 0;
          openEventSource();
        }
        if (retainedBaseline !== null && retainedOffset !== offset) {
          retainedBaseline = null;
          retainedOffset = null;
          setView(emptyServerIngestionQueueView("disconnected", connectionGeneration));
        }
        return;
      }
      alignSnapshotRequirements();
      if (
        snapshotRequirements.currentSelection
        && baseline !== null
        && baselineOffset === offset
        && baselineParameters !== null
        && ingestionQueueBaselineCoversSelection(
          baseline,
          baselineParameters,
          { offset, limit, requiredItems, excludeItems, includeItems }
        )
      ) {
        // The combined owner slices retained Server items and consumes exact
        // browser-owned pairs locally. A covered selection change therefore
        // must not issue a second snapshot for the same queue revision.
        snapshotRequirements.currentSelection = false;
      }
      if (!hasSnapshotRequirements()) return;
      if (activeSnapshot !== null && activeSnapshot.offset === offset) {
        if (reason === "reload" || reason === "ready") {
          publishSnapshotState(offset);
        }
        return;
      }
      const requestedScope = actionScope;
      const requestedGeneration = connectionGeneration;
      // 同页重读只在成功后原位替换稳定基线。limit 会随本地前缀增减，
      // 但 offset 不变时旧页仍可安全裁切展示，不能把普通收敛伪装成重连。
      const refreshInPlace = baseline !== null && baselineOffset === offset;
      const retainDuringLoad = !refreshInPlace
        && retainedBaseline !== null
        && retainedOffset === offset;
      const serial = ++snapshotSerial;
      const controller = new AbortController();
      // A mutation or explicit refresh may recover before the bounded retry
      // fires. Starting that authoritative request consumes the old timer but
      // retains the attempt count until a snapshot actually succeeds.
      cancelSnapshotRecoveryTimer();
      activeSnapshot = { controller, offset };
      immediateSnapshotFollowup = false;
      buffered = [];
      bufferedAuthorityBaseline = refreshInPlace ? baseline : null;
      if (!refreshInPlace) {
        clearBaseline();
      }
      if (!refreshInPlace || reason === "reload") {
        publishSnapshotState(offset);
      }
      let deferSuccessor = false;

      void getIngestionQueueSnapshot(
        {
          queue: input.queue,
          offset,
          limit,
          exclude_items: [...excludeItems],
          include_items: [...includeItems]
        },
        requestedScope,
        controller.signal
      ).then((snapshot) => {
        if (
          disposed
          || controller.signal.aborted
          || serial !== snapshotSerial
          || requestedScope !== actionScope
          || requestedGeneration !== connectionGeneration
        ) return;
        if (
          snapshot.queue !== input.queue
          || snapshot.offset !== offset
          || snapshot.limit !== limit
        ) throw new Error("内容接入队列快照与请求页面不一致");
        const currentParameters = parametersRef.current;
        const capturedParameters = {
          offset,
          limit,
          requiredItems,
          excludeItems,
          includeItems
        } satisfies IngestionQueueSnapshotSelection;
        const snapshotBaseline = baselineFromIngestionSnapshot(snapshot);
        if (!ingestionQueueBaselineCoversSelection(
          snapshotBaseline,
          capturedParameters,
          currentParameters
        )) {
          // The same-page request still completes normally so rapid handoff
          // changes never create cancelled fetches. Its page selection is no
          // longer authoritative, however, so keep the previous stable view
          // until the queued request reads the current exclusion set.
          buffered = [];
          bufferedAuthorityBaseline = null;
          const stableCoversCurrent = baseline !== null
            && baselineOffset === currentParameters.offset
            && baselineParameters !== null
            && ingestionQueueBaselineCoversSelection(
              baseline,
              baselineParameters,
              currentParameters
            );
          if (stableCoversCurrent) {
            snapshotRequirements.currentSelection = false;
          } else {
            requireSnapshotCoverage("parameters");
          }
          return;
        }
        const { merged, reload } = mergeBufferedMutations(snapshotBaseline);
        if (reload) {
          requireSnapshotCoverage("reload");
          publishSnapshotState(offset);
          return;
        }
        baseline = merged;
        baselineOffset = offset;
        baselineParameters = {
          offset,
          limit,
          requiredItems,
          excludeItems: [...excludeItems],
          includeItems: [...includeItems]
        };
        retainedBaseline = merged;
        retainedOffset = offset;
        satisfySnapshotCoverage(
          serial,
          requestedScope,
          requestedGeneration,
          merged
        );
        clearSnapshotRecovery();
        const rerun = nextSnapshotReason();
        if (rerun === "reload" || rerun === "ready") {
          publishSnapshotState(offset);
          return;
        }
        setView(readyServerIngestionQueueView(connectionGeneration, actionScope, merged));
        completeAuthorityRecovery(serial);
      }).catch((error: unknown) => {
        if (disposed || controller.signal.aborted || serial !== snapshotSerial) {
          return;
        }
        const immediateFollowup = immediateSnapshotFollowup
          && hasSnapshotRequirements();
        if (!hasSnapshotRequirements()) {
          // A parameter request can become unnecessary while it is in flight.
          // If that obsolete request then fails, retain the documented bounded
          // authority recovery instead of leaving a display-only baseline with
          // no remaining requirement capable of starting the retry.
          requireSnapshotCoverage("reload");
        }
        immediateSnapshotFollowup = false;
        const retainWithoutAuthority = (
          recoveryBaseline: ServerIngestionQueueBaseline
        ) => {
          clearBaseline();
          retainedBaseline = recoveryBaseline;
          retainedOffset = offset;
          return retainedServerIngestionQueueView(
            "disconnected",
            requestedGeneration,
            requestedScope,
            recoveryBaseline
          );
        };
        if (immediateFollowup) {
          const recoveryBaseline = baseline !== null && baselineOffset === offset
            ? mergeBufferedMutations(baseline).merged
            : retainedBaseline !== null && retainedOffset === offset
              ? retainedBaseline
              : null;
          if (recoveryBaseline) {
            setView(retainWithoutAuthority(recoveryBaseline));
          } else {
            buffered = [];
            bufferedAuthorityBaseline = null;
            setView({
              ...emptyServerIngestionQueueView("loading", requestedGeneration),
              actionScope: requestedScope
            });
          }
          return;
        }
        const recoverWithBaseline = (
          recoveryBaseline: ServerIngestionQueueBaseline
        ) => {
          const retryDelay = snapshotRecoveryDelays[snapshotRecoveryAttempt];
          const recoveryView = retainWithoutAuthority(recoveryBaseline);
          if (retryDelay !== undefined) {
            deferSuccessor = true;
            snapshotRecoveryAttempt += 1;
            snapshotRecoveryTimer = setTimeout(() => {
              snapshotRecoveryTimer = null;
              const retryReason = nextSnapshotReason();
              if (retryReason && actionScope) startSnapshot(retryReason);
            }, retryDelay);
            setView(recoveryView);
          } else {
            deferSuccessor = true;
            setView({
              ...recoveryView,
              status: "error",
              error: error instanceof Error ? error.message : String(error)
            });
            failAuthorityRecovery(error);
          }
        };
        if (
          refreshInPlace
          && baseline !== null
          && baselineOffset === offset
          && requestedScope === actionScope
          && requestedGeneration === connectionGeneration
        ) {
          const retained = mergeBufferedMutations(baseline);
          recoverWithBaseline(retained.merged);
          return;
        }
        if (
          retainDuringLoad
          && retainedBaseline !== null
          && retainedOffset === offset
          && requestedScope === actionScope
          && requestedGeneration === connectionGeneration
        ) {
          buffered = [];
          clearBaseline();
          recoverWithBaseline(retainedBaseline);
          return;
        }
        buffered = [];
        clearBaseline();
        const retryDelay = snapshotRecoveryDelays[snapshotRecoveryAttempt];
        if (retryDelay !== undefined) {
          deferSuccessor = true;
          snapshotRecoveryAttempt += 1;
          snapshotRecoveryTimer = setTimeout(() => {
            snapshotRecoveryTimer = null;
            const retryReason = nextSnapshotReason();
            if (retryReason && actionScope) startSnapshot(retryReason);
          }, retryDelay);
          setView({
            ...emptyServerIngestionQueueView("loading", connectionGeneration),
            actionScope
          });
        } else {
          deferSuccessor = true;
          setView({
            ...emptyServerIngestionQueueView(
              "error",
              connectionGeneration,
              error instanceof Error ? error.message : String(error)
            ),
            actionScope
          });
          failAuthorityRecovery(error);
        }
      }).finally(() => {
        if (activeSnapshot?.controller !== controller) return;
        activeSnapshot = null;
        const rerun = nextSnapshotReason();
        immediateSnapshotFollowup = false;
        if (
          !disposed
          && !deferSuccessor
          && snapshotRecoveryTimer === null
          && rerun
          && actionScope
        ) startSnapshot(rerun);
      });
    };
    const requestSnapshot = (
      reason: SnapshotRequestReason = "refresh"
    ) => {
      if (disposed) return;
      if (reason === "refresh" || reason === "parameters") {
        clearSnapshotRecovery();
      }
      requireSnapshotCoverage(reason);
      const requiredReason = nextSnapshotReason();
      if (requiredReason) startSnapshot(requiredReason);
    };
    requestSnapshotRef.current = requestSnapshot;
    const scheduleAuthorityRecoverySnapshot = () => {
      if (authorityRecoverySnapshotScheduled) return;
      authorityRecoverySnapshotScheduled = true;
      queueMicrotask(() => {
        authorityRecoverySnapshotScheduled = false;
        if (disposed) return;
        const reason = nextSnapshotReason();
        if (reason) startSnapshot(reason);
      });
    };
    recoverAuthorityRef.current = () => {
      const minimumSnapshotSerial = snapshotSerial + 1;
      if (authorityRecovery === null) {
        let resolve!: () => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<void>((resolvePromise, rejectPromise) => {
          resolve = resolvePromise;
          reject = rejectPromise;
        });
        authorityRecovery = {
          minimumSnapshotSerial,
          promise,
          resolve,
          reject
        };
      } else {
        // A second unknown outcome can arrive after the shared recovery read
        // has already started. Keep one promise/owner, but move its proof
        // fence forward so that older in-flight data cannot settle it.
        authorityRecovery.minimumSnapshotSerial = Math.max(
          authorityRecovery.minimumSnapshotSerial,
          minimumSnapshotSerial
        );
      }
      alignSnapshotRequirements();
      snapshotRequirements.minimumSnapshotSerial = Math.max(
        snapshotRequirements.minimumSnapshotSerial ?? 0,
        authorityRecovery.minimumSnapshotSerial
      );
      if (snapshotRequirements.postTriggerReason !== "reload") {
        snapshotRequirements.postTriggerReason = "refresh";
      }
      if (activeSnapshot !== null) immediateSnapshotFollowup = true;
      clearSnapshotRecovery();
      scheduleAuthorityRecoverySnapshot();
      return authorityRecovery.promise;
    };
    ensureRevisionRef.current = (
      revision?: number,
      expectedConnectionGeneration = connectionGeneration
    ) => {
      if (
        disposed
        || expectedConnectionGeneration !== connectionGeneration
      ) return false;
      alignSnapshotRequirements();
      if (
        revision !== undefined
        && baseline !== null
        && baseline.revision >= revision
      ) return true;
      if (revision === undefined) {
        const minimumSnapshotSerial = snapshotSerial + 1;
        const strengthened = snapshotRequirements.minimumSnapshotSerial === null
          || snapshotRequirements.minimumSnapshotSerial < minimumSnapshotSerial;
        snapshotRequirements.minimumSnapshotSerial = Math.max(
          snapshotRequirements.minimumSnapshotSerial ?? 0,
          minimumSnapshotSerial
        );
        if (snapshotRequirements.postTriggerReason !== "reload") {
          snapshotRequirements.postTriggerReason = "refresh";
        }
        if (strengthened && activeSnapshot !== null) {
          immediateSnapshotFollowup = true;
        }
      } else {
        snapshotRequirements.minimumRevision = Math.max(
          snapshotRequirements.minimumRevision ?? 0,
          revision
        );
      }
      if (activeSnapshot === null) {
        clearSnapshotRecovery();
        const reason = nextSnapshotReason();
        if (reason) startSnapshot(reason);
      }
      return true;
    };

    const disconnect = (
      status: Extract<ServerIngestionQueueStatus, "disconnected" | "error">,
      error = ""
    ) => {
      connectionGeneration = ++generationCounterRef.current;
      if (baseline !== null && baselineOffset !== null) {
        retainedBaseline = baseline;
        retainedOffset = baselineOffset;
      }
      clearBaseline();
      actionScope = "";
      invalidateSnapshotScope();
      alignSnapshotRequirements();
      clearSnapshotRecovery();
      const { offset } = parametersRef.current;
      const retained = retainedBaseline !== null && retainedOffset === offset
        ? retainedBaseline
        : null;
      setView(retained
        ? {
          ...retainedServerIngestionQueueView(
            "disconnected",
            connectionGeneration,
            "",
            retained
          ),
          status,
          error
        }
        : emptyServerIngestionQueueView(status, connectionGeneration, error));
    };

    const restartEventSource = (error: unknown) => {
      source?.close();
      source = null;
      if (protocolReconnectTimer !== null) {
        clearTimeout(protocolReconnectTimer);
        protocolReconnectTimer = null;
      }
      const delay = protocolReconnectDelays[protocolReconnectAttempt];
      if (delay === undefined) {
        disconnect(
          "error",
          error instanceof Error ? error.message : String(error)
        );
        failAuthorityRecovery(error);
        return;
      }
      protocolReconnectAttempt += 1;
      disconnect("disconnected");
      protocolReconnectTimer = setTimeout(() => {
        protocolReconnectTimer = null;
        openEventSource();
      }, delay);
    };

    const recoverMalformedEvent = (error: unknown, reload: boolean) => {
      if (actionScope) {
        if (reload) requestSnapshot("reload");
        return;
      }
      restartEventSource(error);
    };

    const scheduleReadySnapshot = () => {
      if (readySnapshotScheduled) return;
      readySnapshotScheduled = true;
      queueMicrotask(() => {
        readySnapshotScheduled = false;
        if (!disposed && actionScope) requestSnapshot("ready");
      });
    };

    const handleReady = (message: MessageEvent<string>) => {
      try {
        const event = parseServerIngestionQueueEvent(
          message.data,
          "ready",
          input.queue
        ) as Extract<IngestionQueueEventDto, { type: "ready" }>;
        if (!event.action_scope) throw new Error("内容接入队列事件缺少作用域");
        protocolReconnectAttempt = 0;
        clearSnapshotRecovery();
        connectionGeneration = ++generationCounterRef.current;
        if (baseline !== null && baselineOffset !== null) {
          retainedBaseline = baseline;
          retainedOffset = baselineOffset;
        }
        actionScope = event.action_scope;
        clearBaseline();
        invalidateSnapshotScope();
        alignSnapshotRequirements(true);
        const { offset } = parametersRef.current;
        setView(
          retainedBaseline !== null && retainedOffset === offset
            ? retainedServerIngestionQueueView(
              "loading",
              connectionGeneration,
              actionScope,
              retainedBaseline
            )
            : {
              ...emptyServerIngestionQueueView("loading", connectionGeneration),
              actionScope
            }
        );
        // Browser reconnect bursts can deliver several generations in one
        // turn. Start only the latest snapshot, while a later-turn scope still
        // preempts an obsolete in-flight request immediately.
        scheduleReadySnapshot();
      } catch (error) {
        recoverMalformedEvent(error, true);
      }
    };
    const handleMutation = (message: MessageEvent<string>) => {
      try {
        const event = parseServerIngestionQueueEvent(
          message.data,
          "mutation",
          input.queue
        ) as Extract<IngestionQueueEventDto, { type: "mutation" }>;
        if (!actionScope) return;
        if (
          event.kind === "semantic"
          && event.session.status === "completed"
          && "completed_item" in event.session
        ) {
          // Completion invalidation belongs to the queue owner, not to the
          // bounded page. A completed mutation outside this page still changes
          // the image list, overview, gallery, and duplicate projections.
          onCompletedIngestionsRef.current?.([{
            pair: event.session,
            item: event.session.completed_item,
            completedAt: event.session.completed_at
          }]);
        }
        // 关闭时的冻结动作会短暂保留 SSE action scope。此时不再为已
        // 隐藏的页面追逐 removed/reordered 成员变化；动作结束会断开，
        // 若期间重开则由 displayed effect 读取一次当前权威页面。
        if (!displayedRef.current) return;
        if (activeSnapshot !== null) {
          if (buffered.length >= clientMutationBufferLimit) {
            requestSnapshot("reload");
          } else {
            if (bufferedAuthorityBaseline !== null) {
              const preview = mergeIngestionQueueMutation(
                bufferedAuthorityBaseline,
                event
              );
              if (preview.kind === "reload") {
                bufferedAuthorityBaseline = null;
                // The active snapshot may already contain the mutation that
                // the previous baseline cannot merge (notably a newly accepted
                // session). Buffer it and let the returned snapshot decide;
                // pre-queuing a reload here creates a duplicate tail read even
                // when that snapshot closes the gap exactly.
              } else {
                bufferedAuthorityBaseline = preview.baseline;
              }
            }
            buffered.push(event);
          }
          return;
        }
        if (!baseline) {
          requestSnapshot("reload");
          return;
        }
        const result = mergeIngestionQueueMutation(baseline, event);
        if (result.kind === "reload") {
          requestSnapshot("reload");
          return;
        }
        baseline = result.baseline;
        if (result.kind === "accepted") {
          retainedBaseline = baseline;
          retainedOffset = baselineOffset;
          setView(readyServerIngestionQueueView(connectionGeneration, actionScope, baseline));
        }
      } catch (error) {
        recoverMalformedEvent(error, true);
      }
    };
    const handlePing = (message: MessageEvent<string>) => {
      try {
        parseServerIngestionQueueEvent(message.data, "ping", input.queue);
      } catch (error) {
        recoverMalformedEvent(error, false);
      }
    };
    const handleError = () => {
      disconnect("disconnected");
    };

    function openEventSource() {
      if (disposed || source !== null) return;
      const next = new EventSource(`${ingestionEventsPath}?${query}`);
      source = next;
      next.addEventListener("ready", handleReady as EventListener);
      next.addEventListener("mutation", handleMutation as EventListener);
      next.addEventListener("ping", handlePing as EventListener);
      next.addEventListener("error", handleError);
    }

    openEventSource();
    setView((current) => emptyServerIngestionQueueView(
      "connecting",
      current.connectionGeneration
    ));

    return () => {
      disposed = true;
      requestSnapshotRef.current = null;
      recoverAuthorityRef.current = null;
      ensureRevisionRef.current = null;
      failAuthorityRecovery(new Error("内容接入队列连接已关闭"));
      snapshotSerial += 1;
      clearSnapshotRecovery();
      if (protocolReconnectTimer !== null) {
        clearTimeout(protocolReconnectTimer);
        protocolReconnectTimer = null;
      }
      abortSnapshotRequest();
      source?.close();
      source = null;
    };
  }, [input.enabled, input.queue]);

  useEffect(() => {
    requestSnapshotRef.current?.("parameters");
  }, [filterKey, input.limit, input.offset, input.requiredItems]);

  useEffect(() => {
    if (input.displayed) requestSnapshotRef.current?.("refresh");
  }, [input.displayed]);

  const refresh = useCallback(() => {
    requestSnapshotRef.current?.("refresh");
  }, []);
  const recoverAuthority = useCallback(() => {
    const recover = recoverAuthorityRef.current;
    return recover
      ? recover()
      : Promise.reject(new Error("内容接入队列连接尚未就绪"));
  }, []);
  const ensureRevision = useCallback((
    revision?: number,
    connectionGeneration?: number
  ) => {
    return ensureRevisionRef.current?.(revision, connectionGeneration) ?? false;
  }, []);

  return { ...view, ensureRevision, recoverAuthority, refresh };
}

export type ServerIngestionQueueController = ReturnType<
  typeof useServerIngestionQueue
>;
