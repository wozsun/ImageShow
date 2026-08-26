import { useCallback, useEffect, useRef, useState } from "react";
import {
  importEventsPath,
  type ImportQueueEventDto,
  type ImportSessionPairDto,
  type ImportQueueSummaryDto,
  type ImportQueueTypeDto,
  type ServerImportItemDto
} from "@imageshow/shared/browser";
import { getImportQueueSnapshot } from "./import-api.js";
import {
  baselineFromImportSnapshot,
  importQueueBaselineCoversSelection,
  mergeImportQueueMutation,
  type ImportQueueSnapshotSelection,
  type ServerImportQueueBaseline
} from "./server-import-queue-state.js";
import type {
  CompletedImportObservation
} from "./import-queue-api.js";

const clientMutationBufferLimit = 1_000;
const snapshotRecoveryDelays = [100, 500, 1_500] as const;
const protocolReconnectDelays = [100, 500] as const;

type ServerImportQueueStatus =
  | "idle"
  | "connecting"
  | "loading"
  | "ready"
  | "disconnected"
  | "error";

type SnapshotRequestReason =
  | "refresh"
  | "parameters"
  | "reload"
  | "ready";

type AuthorityRecovery = Readonly<{
  minimumSnapshotSerial: number;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}>;

const snapshotRequestPriority: Readonly<Record<SnapshotRequestReason, number>> = {
  parameters: 1,
  refresh: 2,
  ready: 3,
  reload: 4
};

export type ServerImportQueueView = Readonly<{
  status: ServerImportQueueStatus;
  connectionGeneration: number;
  actionScope: string;
  revision: number | null;
  lastAcceptedOrder: number | null;
  summary: ImportQueueSummaryDto | null;
  items: readonly ServerImportItemDto[];
  staleItems: readonly ImportSessionPairDto[];
  actionWatermark: string;
  error: string;
}>;

function emptyView(
  status: ServerImportQueueStatus,
  connectionGeneration: number,
  error = ""
): ServerImportQueueView {
  return {
    status,
    connectionGeneration,
    actionScope: "",
    revision: null,
    lastAcceptedOrder: null,
    summary: null,
    items: [],
    staleItems: [],
    actionWatermark: "",
    error
  };
}

function readyView(
  connectionGeneration: number,
  actionScope: string,
  baseline: ServerImportQueueBaseline
): ServerImportQueueView {
  return {
    status: "ready",
    connectionGeneration,
    actionScope,
    revision: baseline.revision,
    lastAcceptedOrder: baseline.lastAcceptedOrder,
    summary: baseline.summary,
    items: baseline.items,
    staleItems: baseline.staleItems,
    actionWatermark: baseline.actionWatermark,
    error: ""
  };
}

function retainedView(
  status: Extract<ServerImportQueueStatus, "loading" | "disconnected">,
  connectionGeneration: number,
  actionScope: string,
  baseline: ServerImportQueueBaseline
): ServerImportQueueView {
  return {
    ...readyView(connectionGeneration, actionScope, baseline),
    status
  };
}

function parseQueueEvent(
  raw: string,
  expectedType: ImportQueueEventDto["type"],
  expectedQueue: ImportQueueTypeDto
) {
  const parsed = JSON.parse(raw) as Partial<ImportQueueEventDto>;
  if (parsed.type !== expectedType || parsed.queue !== expectedQueue) {
    throw new Error("导入队列事件格式无效");
  }
  return parsed as ImportQueueEventDto;
}

/**
 * Own exactly one SSE for one displayed owner + queue. Every ready event
 * starts a fresh action generation, while the last accepted page remains a
 * display-only baseline until the new bounded snapshot succeeds.
 */
export function useServerImportQueue(input: Readonly<{
  enabled: boolean;
  displayed: boolean;
  queue: ImportQueueTypeDto;
  offset: number;
  limit: number;
  requiredItems: number;
  excludeItems: readonly ImportSessionPairDto[];
  includeItems: readonly ImportSessionPairDto[];
  onCompletedImports?: (
    entries: readonly CompletedImportObservation[]
  ) => void;
}>) {
  const [view, setView] = useState<ServerImportQueueView>(() => (
    emptyView("idle", 0)
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
    includeItems: input.includeItems,
    filterKey
  });
  parametersRef.current = {
    offset: input.offset,
    limit: input.limit,
    requiredItems: input.requiredItems,
    excludeItems: input.excludeItems,
    includeItems: input.includeItems,
    filterKey
  };
  const requestSnapshotRef = useRef<(
    (reason?: SnapshotRequestReason) => void
  ) | null>(null);
  const recoverAuthorityRef = useRef<(() => Promise<void>) | null>(null);
  const ensureRevisionRef = useRef<((revision?: number) => void) | null>(null);
  const onCompletedImportsRef = useRef(input.onCompletedImports);
  onCompletedImportsRef.current = input.onCompletedImports;
  const displayedRef = useRef(input.displayed);
  displayedRef.current = input.displayed;
  const generationCounterRef = useRef(0);

  useEffect(() => {
    if (!input.enabled) {
      requestSnapshotRef.current = null;
      recoverAuthorityRef.current = null;
      setView((current) => emptyView("idle", current.connectionGeneration));
      return;
    }

    const query = new URLSearchParams({ queue: input.queue });
    let source: EventSource | null = null;
    let disposed = false;
    let connectionGeneration = generationCounterRef.current;
    let actionScope = "";
    let baseline: ServerImportQueueBaseline | null = null;
    let baselineOffset: number | null = null;
    let baselineParameters: ImportQueueSnapshotSelection | null = null;
    let retainedBaseline: ServerImportQueueBaseline | null = null;
    let retainedOffset: number | null = null;
    let snapshotSerial = 0;
    let activeSnapshot: Readonly<{
      controller: AbortController;
      offset: number;
      limit: number;
      filterKey: string;
    }> | null = null;
    let snapshotQueued: SnapshotRequestReason | null = null;
    let buffered: Array<Extract<ImportQueueEventDto, { type: "mutation" }>> = [];
    let bufferedAuthorityBaseline: ServerImportQueueBaseline | null = null;
    let snapshotRecoveryAttempt = 0;
    let snapshotRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
    let readySnapshotScheduled = false;
    let protocolReconnectAttempt = 0;
    let protocolReconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let pendingCoverageRevision: number | null = null;
    let pendingUnknownCoverage = false;
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

    const abortSnapshotRequest = (keepOffset?: number) => {
      if (
        activeSnapshot === null
        || keepOffset !== undefined && activeSnapshot.offset === keepOffset
      ) return;
      activeSnapshot.controller.abort();
      activeSnapshot = null;
      snapshotQueued = null;
    };

    const invalidateSnapshotScope = () => {
      // A snapshot is authoritative only inside the SSE scope that started it.
      // Cancel exactly that obsolete request so a new ready generation cannot
      // wait forever behind a slow response from the previous scope.
      snapshotSerial += 1;
      abortSnapshotRequest();
      snapshotQueued = null;
      buffered = [];
      bufferedAuthorityBaseline = null;
    };

    const publishSnapshotState = (offset: number) => {
      if (baseline !== null && baselineOffset === offset) {
        // 同一 SSE scope 的旧 watermark 仍是有效且有界的点击边界：它最多
        // 处理旧 accepted-order 集合，绝不会纳入触发本次重读的新任务。
        // 因此同页后台收敛只替换卡片，不应让操作按钮暂时失去权威。
        setView(readyView(connectionGeneration, actionScope, baseline));
        return;
      }
      const loadingBaseline = retainedBaseline !== null
        && retainedOffset === offset
        ? retainedBaseline
        : null;
      setView(loadingBaseline
        ? retainedView(
          "loading",
          connectionGeneration,
          actionScope,
          loadingBaseline
        )
        : {
          ...emptyView("loading", connectionGeneration),
          actionScope
        });
    };

    const queueSnapshotRequest = (reason: SnapshotRequestReason) => {
      if (
        snapshotQueued === null
        || snapshotRequestPriority[reason]
          > snapshotRequestPriority[snapshotQueued]
      ) {
        snapshotQueued = reason;
      }
    };

    const mergeBufferedMutations = (current: ServerImportQueueBaseline) => {
      let merged = current;
      let reload = false;
      for (const event of buffered) {
        const result = mergeImportQueueMutation(merged, event);
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

    const requestSnapshot = (
      reason: SnapshotRequestReason = "refresh"
    ) => {
      if (disposed) return;
      if (reason === "refresh" || reason === "parameters") {
        clearSnapshotRecovery();
      }
      const {
        offset,
        limit,
        requiredItems,
        excludeItems,
        includeItems,
        filterKey: requestedFilterKey
      } = parametersRef.current;
      // Offset changes cancel the obsolete page. Same-scope, same-page reloads
      // share the active request and queue at most one necessary successor.
      abortSnapshotRequest(offset);
      if (!actionScope) {
        if (source === null && protocolReconnectTimer === null) {
          protocolReconnectAttempt = 0;
          openEventSource();
        }
        if (retainedBaseline !== null && retainedOffset !== offset) {
          retainedBaseline = null;
          retainedOffset = null;
          setView(emptyView("disconnected", connectionGeneration));
        }
        return;
      }
      if (
        reason === "parameters"
        && baseline !== null
        && baselineOffset === offset
        && baselineParameters !== null
        && importQueueBaselineCoversSelection(
          baseline,
          baselineParameters,
          { offset, limit, requiredItems, excludeItems, includeItems }
        )
      ) {
        // The combined owner slices retained Server items and consumes exact
        // browser-owned pairs locally. A covered selection change therefore
        // must not issue a second snapshot for the same queue revision.
        if (snapshotQueued === "parameters") snapshotQueued = null;
        return;
      }
      if (activeSnapshot !== null && activeSnapshot.offset === offset) {
        if (reason === "parameters") {
          if (
            requestedFilterKey === activeSnapshot.filterKey
            && limit <= activeSnapshot.limit
          ) {
            if (snapshotQueued === "parameters") snapshotQueued = null;
            return;
          }
        }
        queueSnapshotRequest(reason);
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
      activeSnapshot = {
        controller,
        offset,
        limit,
        filterKey: requestedFilterKey
      };
      snapshotQueued = null;
      buffered = [];
      bufferedAuthorityBaseline = refreshInPlace ? baseline : null;
      if (!refreshInPlace) {
        clearBaseline();
      }
      if (!refreshInPlace || reason === "reload") {
        publishSnapshotState(offset);
      }

      void getImportQueueSnapshot(
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
        ) throw new Error("导入队列快照与请求页面不一致");
        const currentParameters = parametersRef.current;
        const capturedParameters = {
          offset,
          limit,
          requiredItems,
          excludeItems,
          includeItems
        } satisfies ImportQueueSnapshotSelection;
        const snapshotBaseline = baselineFromImportSnapshot(snapshot);
        if (!importQueueBaselineCoversSelection(
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
          queueSnapshotRequest("parameters");
          return;
        }
        if (snapshotQueued === "parameters") snapshotQueued = null;
        const { merged, reload } = mergeBufferedMutations(snapshotBaseline);
        if (reload) {
          queueSnapshotRequest("reload");
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
        if (pendingUnknownCoverage) {
          pendingUnknownCoverage = false;
          pendingCoverageRevision = null;
        } else if (pendingCoverageRevision !== null) {
          if (merged.revision >= pendingCoverageRevision) {
            pendingCoverageRevision = null;
          } else {
            queueSnapshotRequest("refresh");
          }
        }
        clearSnapshotRecovery();
        if (snapshotQueued === "reload" || snapshotQueued === "ready") {
          publishSnapshotState(offset);
          return;
        }
        setView(readyView(connectionGeneration, actionScope, merged));
        completeAuthorityRecovery(serial);
      }).catch((error: unknown) => {
        if (disposed || controller.signal.aborted || serial !== snapshotSerial) {
          return;
        }
        const retainWithoutAuthority = (
          recoveryBaseline: ServerImportQueueBaseline
        ) => {
          clearBaseline();
          retainedBaseline = recoveryBaseline;
          retainedOffset = offset;
          return retainedView(
            "disconnected",
            requestedGeneration,
            requestedScope,
            recoveryBaseline
          );
        };
        if (snapshotQueued === "parameters" || snapshotQueued === "refresh") {
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
              ...emptyView("loading", requestedGeneration),
              actionScope: requestedScope
            });
          }
          return;
        }
        if (snapshotQueued === "reload" || snapshotQueued === "ready") {
          snapshotQueued = null;
        }
        const recoverWithBaseline = (
          recoveryBaseline: ServerImportQueueBaseline
        ) => {
          const retryDelay = snapshotRecoveryDelays[snapshotRecoveryAttempt];
          const recoveryView = retainWithoutAuthority(recoveryBaseline);
          if (retryDelay !== undefined) {
            snapshotRecoveryAttempt += 1;
            snapshotRecoveryTimer = setTimeout(() => {
              snapshotRecoveryTimer = null;
              requestSnapshot("reload");
            }, retryDelay);
            setView(recoveryView);
          } else {
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
          snapshotRecoveryAttempt += 1;
          snapshotRecoveryTimer = setTimeout(() => {
            snapshotRecoveryTimer = null;
            requestSnapshot("reload");
          }, retryDelay);
          setView({
            ...emptyView("loading", connectionGeneration),
            actionScope
          });
        } else {
          setView({
            ...emptyView(
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
        const rerun = snapshotQueued;
        snapshotQueued = null;
        if (!disposed && rerun && actionScope) requestSnapshot(rerun);
      });
    };
    requestSnapshotRef.current = requestSnapshot;
    recoverAuthorityRef.current = () => {
      if (authorityRecovery !== null) return authorityRecovery.promise;
      let resolve!: () => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      authorityRecovery = {
        minimumSnapshotSerial: snapshotSerial + 1,
        promise,
        resolve,
        reject
      };
      requestSnapshot("refresh");
      return promise;
    };
    ensureRevisionRef.current = (revision?: number) => {
      if (disposed) return;
      if (
        revision !== undefined
        && baseline !== null
        && baseline.revision >= revision
      ) return;
      if (revision === undefined) {
        pendingUnknownCoverage = true;
      } else {
        pendingCoverageRevision = Math.max(
          pendingCoverageRevision ?? 0,
          revision
        );
      }
      if (activeSnapshot === null) requestSnapshot("refresh");
    };

    const disconnect = (
      status: Extract<ServerImportQueueStatus, "disconnected" | "error">,
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
      clearSnapshotRecovery();
      const { offset } = parametersRef.current;
      const retained = retainedBaseline !== null && retainedOffset === offset
        ? retainedBaseline
        : null;
      setView(retained
        ? {
          ...retainedView(
            "disconnected",
            connectionGeneration,
            "",
            retained
          ),
          status,
          error
        }
        : emptyView(status, connectionGeneration, error));
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
        const event = parseQueueEvent(
          message.data,
          "ready",
          input.queue
        ) as Extract<ImportQueueEventDto, { type: "ready" }>;
        if (!event.action_scope) throw new Error("导入队列事件缺少作用域");
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
        const { offset } = parametersRef.current;
        setView(
          retainedBaseline !== null && retainedOffset === offset
            ? retainedView(
              "loading",
              connectionGeneration,
              actionScope,
              retainedBaseline
            )
            : {
              ...emptyView("loading", connectionGeneration),
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
        const event = parseQueueEvent(
          message.data,
          "mutation",
          input.queue
        ) as Extract<ImportQueueEventDto, { type: "mutation" }>;
        if (!actionScope) return;
        if (
          event.kind === "semantic"
          && event.session.status === "completed"
          && "completed_item" in event.session
        ) {
          // Completion invalidation belongs to the queue owner, not to the
          // bounded page. A completed mutation outside this page still changes
          // the image list, overview, gallery, and duplicate projections.
          onCompletedImportsRef.current?.([{
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
              const preview = mergeImportQueueMutation(
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
        const result = mergeImportQueueMutation(baseline, event);
        if (result.kind === "reload") {
          requestSnapshot("reload");
          return;
        }
        baseline = result.baseline;
        if (result.kind === "accepted") {
          retainedBaseline = baseline;
          retainedOffset = baselineOffset;
          setView(readyView(connectionGeneration, actionScope, baseline));
        }
      } catch (error) {
        recoverMalformedEvent(error, true);
      }
    };
    const handlePing = (message: MessageEvent<string>) => {
      try {
        parseQueueEvent(message.data, "ping", input.queue);
      } catch (error) {
        recoverMalformedEvent(error, false);
      }
    };
    const handleError = () => {
      disconnect("disconnected");
    };

    function openEventSource() {
      if (disposed || source !== null) return;
      const next = new EventSource(`${importEventsPath}?${query}`);
      source = next;
      next.addEventListener("ready", handleReady as EventListener);
      next.addEventListener("mutation", handleMutation as EventListener);
      next.addEventListener("ping", handlePing as EventListener);
      next.addEventListener("error", handleError);
    }

    openEventSource();
    setView((current) => emptyView(
      "connecting",
      current.connectionGeneration
    ));

    return () => {
      disposed = true;
      requestSnapshotRef.current = null;
      recoverAuthorityRef.current = null;
      ensureRevisionRef.current = null;
      failAuthorityRecovery(new Error("导入队列连接已关闭"));
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
      : Promise.reject(new Error("导入队列连接尚未就绪"));
  }, []);
  const ensureRevision = useCallback((revision?: number) => {
    ensureRevisionRef.current?.(revision);
  }, []);

  return { ...view, ensureRevision, recoverAuthority, refresh };
}

export type ServerImportQueueController = ReturnType<
  typeof useServerImportQueue
>;
