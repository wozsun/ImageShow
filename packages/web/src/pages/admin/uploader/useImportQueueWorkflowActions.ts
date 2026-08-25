import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ImportQueueActionResultDto,
  ImportSessionPairDto
} from "@imageshow/shared/browser";
import type { ImportJob } from "../../../lib/types.js";
import type { ImportAttributeDefaults } from "../../../lib/upload/upload-utils.js";
import type { ImportQueueCancelOutcome } from "./import-cancel.js";
import { importJobNeedsDuplicateConfirmation } from "./duplicate-match.js";
import {
  importAttributeDefaultsActionMetadata
} from "./import-attribute-policy.js";
import {
  importJobCanBeCancelled,
  importJobCanStartCommit,
  importJobCanLeaveQueue,
  isUncommittedImportJob
} from "./import-queue-state.js";
import { serverImportPairKey } from "./server-import-job.js";
import type { FrozenImportQueueAction } from "./useImportQueueActions.js";
import type { ImportQueueController } from "./useImportQueue.js";
import type { UploadCleanupActionId } from "./upload-cleanup-actions.js";

type CapturedLocalJob = Readonly<ImportJob>;

type CapturedServerAction =
  | Readonly<{ frozen: null; required: false }>
  | Readonly<{
      frozen: FrozenImportQueueAction | null;
      required: true;
    }>;

type UnresolvedLocalClear = Readonly<{
  id: string;
  attemptKey: string;
  outcome?: ImportQueueCancelOutcome;
}>;

type LocalClearResult = Readonly<{
  unresolved: readonly UnresolvedLocalClear[];
}>;

type FrozenLocalClearIntent = Readonly<{
  queueType: "upload" | "import";
  serverAction: CapturedServerAction;
  localJobs: readonly CapturedLocalJob[];
  unresolvedLocal: LocalClearResult;
  retryable: boolean;
}>;

type FrozenClearQueueIntent = FrozenLocalClearIntent;

type FrozenCleanupIntent = FrozenLocalClearIntent & Readonly<{
  action: UploadCleanupActionId;
  count: number;
}>;

type DeferredCompletedCleanup = {
  id: number;
  maxSemanticRevision: number;
  localJobs: readonly CapturedLocalJob[];
  unresolvedLocal: LocalClearResult;
  releaseConnection: () => void;
  running: boolean;
  retryAfterAuthority?: Readonly<{
    connectionGeneration: number;
    revision: number | null;
  }>;
};

function retainUnresolvedLocalJobs(
  captured: readonly CapturedLocalJob[],
  result: LocalClearResult
) {
  if (!result.unresolved.length) return [];
  const unresolvedAttempts = new Set(result.unresolved.map(
    (item) => `${item.id}\0${item.attemptKey}`
  ));
  return captured.filter((job) => (
    unresolvedAttempts.has(`${job.id}\0${job.attemptKey}`)
  ));
}

function preserveUnresolvedLocalOutcomes(
  current: LocalClearResult,
  previous: LocalClearResult
) {
  if (!current.unresolved.length || !previous.unresolved.length) return current;
  const previousByAttempt = new Map(previous.unresolved.map((item) => (
    [`${item.id}\0${item.attemptKey}`, item] as const
  )));
  return {
    unresolved: current.unresolved.map((item) => (
      item.outcome
        ? item
        : previousByAttempt.get(`${item.id}\0${item.attemptKey}`) ?? item
    ))
  } satisfies LocalClearResult;
}

function cleanupActionType(action: UploadCleanupActionId) {
  if (action === "duplicates") return "clear_duplicate_pending" as const;
  if (action === "uncommitted") return "clear_uncommitted" as const;
  return "clear_completed" as const;
}

function cleanupLocalPredicate(action: UploadCleanupActionId) {
  if (action === "duplicates") return importJobNeedsDuplicateConfirmation;
  if (action === "uncommitted") return isUncommittedImportJob;
  return (job: ImportJob) => job.status === "done";
}

function serverIntentMatchesQueue(
  action: CapturedServerAction,
  status: ImportQueueController["server"]["status"],
  connectionGeneration: number,
  actionScope: string
) {
  if (!action.required) return true;
  const frozen = action.frozen;
  return frozen !== null && (
    status === "ready"
    && frozen.connectionGeneration === connectionGeneration
    && frozen.actionScope === actionScope
  );
}

export function useImportQueueWorkflowActions({
  queue,
  defaults,
  cancelJobs,
  commitJobs,
  onDone
}: {
  queue: ImportQueueController;
  defaults: ImportAttributeDefaults;
  cancelJobs: (
    jobs: readonly ImportJob[]
  ) => Promise<ReadonlyMap<string, ImportQueueCancelOutcome>>;
  commitJobs: (jobs: ImportJob[]) => Promise<boolean>;
  onDone: () => void;
}) {
  const clearQueueIntentRef = useRef<FrozenClearQueueIntent | null>(null);
  const cleanupIntentRef = useRef<FrozenCleanupIntent | null>(null);
  const deferredCompletedCleanupRef = useRef<DeferredCompletedCleanup[]>([]);
  const deferredCompletedCleanupIdRef = useRef(0);
  const runningCompletedCleanupRevisionsRef = useRef(new Set<number>());
  const [deferredCleanupEpoch, setDeferredCleanupEpoch] = useState(0);
  const completedCleanupCovered = useCallback((revision: number) => (
    [...runningCompletedCleanupRevisionsRef.current].some(
      (coveredRevision) => coveredRevision >= revision
    )
    || deferredCompletedCleanupRef.current.some(
      (pending) => pending.maxSemanticRevision >= revision
    )
  ), []);

  const captureServerAction = useCallback((
    action: Parameters<typeof queue.actions.freeze>[0],
    required: boolean,
    metadata?: Parameters<typeof queue.actions.freeze>[1]
  ) => {
    if (!required) {
      return { frozen: null, required: false } satisfies CapturedServerAction;
    }
    const frozen = queue.actions.freeze(action, metadata);
    return { frozen, required: true } satisfies CapturedServerAction;
  }, [queue.actions]);

  const serverRequiresCleanup = useCallback((action: UploadCleanupActionId) => {
    const summary = queue.server.summary;
    if (queue.server.status !== "ready" || !summary) return true;
    if (action === "duplicates") return summary.duplicate_pending > 0;
    if (action === "completed") return summary.completed > 0;
    return summary.unfinished - summary.committing - summary.resolving > 0;
  }, [
    queue.server.status,
    queue.server.summary
  ]);

  const captureLocalJobs = useCallback((
    predicate: (job: ImportJob) => boolean
  ): CapturedLocalJob[] => queue.captureBrowserActionJobs(predicate)
    .filter(importJobCanLeaveQueue), [queue.captureBrowserActionJobs]);

  const clearCapturedLocalJobs = useCallback(async (
    captured: readonly CapturedLocalJob[],
    stillMatches: (job: ImportJob) => boolean
  ) => {
    const removableIds = new Set<string>();
    const cancellationTargets: ImportJob[] = [];
    const unresolved: UnresolvedLocalClear[] = [];
    for (const target of captured) {
      let current = queue.jobsRef.current.find((job) => (
        job.id === target.id && job.attemptKey === target.attemptKey
      ));
      if (!current && queue.jobsRef.current.some((job) => job.id === target.id)) {
        // 同一 UI id 已进入新的 attempt；它不属于冻结集合，旧 attempt 也已不再
        // 由当前 owner 持有。保留新任务即可，不能让旧确认永久变成不可达重试。
        continue;
      }
      const targetNeedsOwner = target.status === "cancelling"
        || importJobCanBeCancelled(target);
      if (!current && targetNeedsOwner) {
        // placeholder 在冻结后可能已被 canonical 页面替换。把同一 attempt 的本地
        // 意图恢复给 owner，再由原幂等身份核对并取消已接管 pair。
        queue.appendJobs([target]);
        current = queue.jobsRef.current.find((job) => (
          job.id === target.id && job.attemptKey === target.attemptKey
        ));
      }
      if (!current) {
        if (targetNeedsOwner) {
          unresolved.push({ id: target.id, attemptKey: target.attemptKey });
        }
        continue;
      }
      // 冻结集合限定“最多处理哪些任务”，执行时仍须复核原动作谓词。
      // 其他窗口在确认期间推进的任务由当前卡片状态直接反映，不能按旧状态删除。
      if (!stillMatches(current)) continue;
      if (!importJobCanLeaveQueue(current)) {
        unresolved.push({ id: target.id, attemptKey: target.attemptKey });
        continue;
      }
      if (
        current.status === "cancelling"
        || importJobCanBeCancelled(current)
      ) {
        cancellationTargets.push(current);
      } else {
        removableIds.add(current.id);
      }
    }
    // 固定本地 ID 与 attemptKey；网络等待期间新加入或重试后的任务不会被误删，
    // 取消结果未知的占位继续留在队列中供用户重试。
    queue.clearJobIds(removableIds);
    const outcomes = await cancelJobs(cancellationTargets);
    const cancelledIds = new Set<string>();
    const resolvedServerTargets: Array<{
      id: string;
      attemptKey: string;
      pair: ImportSessionPairDto;
    }> = [];
    for (const target of cancellationTargets) {
      const current = queue.jobsRef.current.find((job) => job.id === target.id);
      const outcome = outcomes.get(target.id);
      if (current && current.attemptKey !== target.attemptKey) {
        // 取消等待期间产生的新 attempt 不属于冻结范围；其卡片必须原样保留。
        continue;
      }
      if (outcome?.succeeded === true) {
        if (outcome.pair) {
          resolvedServerTargets.push({
            id: target.id,
            attemptKey: target.attemptKey,
            pair: outcome.pair
          });
        } else if (current) {
          cancelledIds.add(target.id);
        }
      } else {
        unresolved.push({
          id: target.id,
          attemptKey: target.attemptKey,
          outcome
        });
      }
    }
    const released = queue.releaseResolvedServerJobs(resolvedServerTargets);
    for (const target of resolvedServerTargets) {
      if (!released.has(target.id)) {
        unresolved.push({ id: target.id, attemptKey: target.attemptKey });
      }
    }
    queue.clearJobIds(cancelledIds);
    return { unresolved } satisfies LocalClearResult;
  }, [
    cancelJobs,
    queue.appendJobs,
    queue.clearJobIds,
    queue.jobsRef,
    queue.releaseResolvedServerJobs
  ]);

  const reconcileLocalClear = useCallback((
    local: LocalClearResult,
    server: ImportQueueActionResultDto | null,
    frozenAction?: FrozenImportQueueAction,
    stillMatches?: (job: ImportJob) => boolean
  ) => {
    if (!local.unresolved.length) return local;
    const serverResults = new Map((server?.items ?? []).map((item) => (
      [serverImportPairKey(item), item.status] as const
    )));
    const releaseTargets: Array<Readonly<{
      item: UnresolvedLocalClear;
      pair: ImportSessionPairDto;
    }>> = [];
    const unresolved: UnresolvedLocalClear[] = [];
    for (const item of local.unresolved) {
      const current = queue.jobsRef.current.find((job) => job.id === item.id);
      if (current && current.attemptKey !== item.attemptKey) {
        // 对账只收敛冻结的旧 attempt，不能因同 id 新 attempt 存在而永久重试。
        continue;
      }
      const outcomePair = item.outcome?.pair;
      const serverStatus = outcomePair
        ? serverResults.get(serverImportPairKey(outcomePair))
        : undefined;
      if (
        outcomePair
        && (serverStatus === "changed" || serverStatus === "unchanged")
      ) {
        releaseTargets.push({ item, pair: outcomePair });
        continue;
      }
      if (serverStatus === "skipped" || serverStatus === "failed") {
        // Server 已明确保留该 pair；卡片状态/详情就是逐项结果，确认无需等待重试。
        continue;
      }
      if (current && stillMatches && !stillMatches(current)) {
        // status/cancel 在并行动作后把本地 owner 推进出原筛选集合；保留新状态。
        continue;
      }
      const coveredBySuccessfulClear = item.outcome?.terminal === "completed"
        && outcomePair
        && server !== null
        && frozenAction?.action === "clear_queue";
      if (coveredBySuccessfulClear) {
        releaseTargets.push({ item, pair: outcomePair });
      } else {
        unresolved.push(item);
      }
    }
    const released = queue.releaseResolvedServerJobs(releaseTargets.map(
      ({ item, pair }) => ({
        id: item.id,
        attemptKey: item.attemptKey,
        pair
      })
    ));
    for (const target of releaseTargets) {
      if (!released.has(target.item.id)) unresolved.push(target.item);
    }
    return { unresolved } satisfies LocalClearResult;
  }, [queue.jobsRef, queue.releaseResolvedServerJobs]);

  const executeFrozenLocalClear = useCallback(async (
    intent: FrozenLocalClearIntent,
    stillMatches: (job: ImportJob) => boolean
  ) => {
    const [serverResult, currentLocalResult] = await Promise.all([
      intent.serverAction.frozen
        ? queue.actions.run(intent.serverAction.frozen)
        : Promise.resolve(null),
      clearCapturedLocalJobs(intent.localJobs, stillMatches)
    ]);
    const localResult = preserveUnresolvedLocalOutcomes(
      currentLocalResult,
      intent.unresolvedLocal
    );
    const reconciledLocal = reconcileLocalClear(
      localResult,
      serverResult,
      intent.serverAction.frozen ?? undefined,
      stillMatches
    );
    return {
      serverResult,
      settled: (
        (!intent.serverAction.required || serverResult !== null)
        && reconciledLocal.unresolved.length === 0
      ),
      retainedLocalJobs: retainUnresolvedLocalJobs(
        intent.localJobs,
        reconciledLocal
      ),
      unresolvedLocal: reconciledLocal
    } as const;
  }, [clearCapturedLocalJobs, queue.actions, reconcileLocalClear]);

  const runCleanupAction = useCallback((action: UploadCleanupActionId) => {
    const completedCleanupRevision = action === "completed"
      ? queue.server.revision ?? -1
      : null;
    if (
      completedCleanupRevision !== null
      && completedCleanupCovered(completedCleanupRevision)
    ) return;
    const localPredicate = cleanupLocalPredicate(action);
    const localJobs = captureLocalJobs(localPredicate);
    const serverAction = captureServerAction(
      cleanupActionType(action),
      serverRequiresCleanup(action)
    );
    if (serverAction.required && !serverAction.frozen) {
      if (action === "completed") {
        const maxSemanticRevision = queue.server.revision;
        const knownServerCompletions = queue.server.summary?.completed ?? 0;
        if (maxSemanticRevision !== null && knownServerCompletions > 0) {
          deferredCompletedCleanupRef.current.push({
            id: ++deferredCompletedCleanupIdRef.current,
            maxSemanticRevision,
            localJobs,
            unresolvedLocal: { unresolved: [] },
            releaseConnection: queue.actions.retainConnection(),
            running: false
          });
          setDeferredCleanupEpoch((current) => current + 1);
          queue.server.refresh();
          return;
        }
        // Without an authoritative Server revision there is no safe way to
        // broaden a close-time cleanup later. Remove only the exact browser
        // completions captured now and let a later open expose unknown items.
        const localOnlyIntent: FrozenLocalClearIntent = {
          queueType: queue.queueType,
          serverAction: { frozen: null, required: false },
          localJobs,
          unresolvedLocal: { unresolved: [] },
          retryable: false
        };
        const localCoverageRevision = completedCleanupRevision ?? -1;
        runningCompletedCleanupRevisionsRef.current.add(
          localCoverageRevision
        );
        void executeFrozenLocalClear(localOnlyIntent, localPredicate)
          .then((result) => {
            if (result.settled && localJobs.length > 0) onDone();
          })
          .finally(() => {
            runningCompletedCleanupRevisionsRef.current.delete(
              localCoverageRevision
            );
          });
      }
      queue.server.refresh();
      return;
    }
    const intent: FrozenLocalClearIntent = {
      queueType: queue.queueType,
      serverAction,
      localJobs,
      unresolvedLocal: { unresolved: [] },
      retryable: false
    };
    if (completedCleanupRevision !== null) {
      runningCompletedCleanupRevisionsRef.current.add(
        completedCleanupRevision
      );
    }
    void executeFrozenLocalClear(intent, localPredicate)
      .then((result) => {
        if (action === "completed" && (
          (result.serverResult?.changed ?? 0) > 0 || localJobs.length > 0
        )) onDone();
      })
      .finally(() => {
        if (completedCleanupRevision !== null) {
          runningCompletedCleanupRevisionsRef.current.delete(
            completedCleanupRevision
          );
        }
      });
  }, [
    captureLocalJobs,
    captureServerAction,
    completedCleanupCovered,
    executeFrozenLocalClear,
    onDone,
    queue.queueType,
    queue.actions,
    queue.server.revision,
    queue.server.refresh,
    queue.server.summary,
    serverRequiresCleanup
  ]);

  useEffect(() => {
    if (queue.server.status === "error") {
      for (const pending of deferredCompletedCleanupRef.current) {
        pending.releaseConnection();
      }
      return;
    }
    const currentAuthority = {
      connectionGeneration: queue.server.connectionGeneration,
      revision: queue.server.revision
    };
    const pending = deferredCompletedCleanupRef.current.find((item) => {
      if (item.running) return false;
      const retryAfter = item.retryAfterAuthority;
      return !retryAfter
        || retryAfter.connectionGeneration !== currentAuthority.connectionGeneration
        || retryAfter.revision !== currentAuthority.revision;
    });
    if (!pending || queue.server.status !== "ready") return;
    const frozen = queue.actions.freeze(
      "clear_completed",
      undefined,
      { maxSemanticRevision: pending.maxSemanticRevision }
    );
    if (!frozen) {
      queue.server.refresh();
      return;
    }
    pending.running = true;
    const intent: FrozenLocalClearIntent = {
      queueType: queue.queueType,
      serverAction: { frozen, required: true },
      localJobs: pending.localJobs,
      unresolvedLocal: pending.unresolvedLocal,
      retryable: false
    };
    void executeFrozenLocalClear(
      intent,
      cleanupLocalPredicate("completed")
    ).then((result) => {
      const index = deferredCompletedCleanupRef.current.findIndex(
        (item) => item.id === pending.id
      );
      if (index < 0) return;
      if (result.settled) {
        deferredCompletedCleanupRef.current.splice(index, 1);
        pending.releaseConnection();
        if ((result.serverResult?.changed ?? 0) > 0 || pending.localJobs.length) {
          onDone();
        }
      } else {
        // A failed action already performs one bounded authority refresh in
        // useImportQueueActions. Do not self-trigger another action from the
        // same connection/revision: sustained 5xx responses would otherwise form
        // an action + snapshot loop while the window is hidden. Retain the
        // frozen close boundary and retry only after a new authority appears.
        pending.releaseConnection();
        deferredCompletedCleanupRef.current[index] = {
          ...pending,
          localJobs: result.retainedLocalJobs,
          unresolvedLocal: result.unresolvedLocal,
          running: false,
          retryAfterAuthority: currentAuthority
        };
      }
      if (result.settled) {
        setDeferredCleanupEpoch((current) => current + 1);
      }
    }).catch(() => {
      const index = deferredCompletedCleanupRef.current.findIndex(
        (item) => item.id === pending.id
      );
      if (index >= 0) {
        deferredCompletedCleanupRef.current.splice(index, 1);
        pending.releaseConnection();
      }
      queue.server.refresh();
      setDeferredCleanupEpoch((value) => value + 1);
    });
  }, [
    deferredCleanupEpoch,
    executeFrozenLocalClear,
    onDone,
    queue.actions,
    queue.queueType,
    queue.server.connectionGeneration,
    queue.server.refresh,
    queue.server.revision,
    queue.server.status
  ]);

  const armCleanupAction = useCallback((
    action: UploadCleanupActionId,
    confirmationCount?: number
  ) => {
    const retained = cleanupIntentRef.current;
    if (
      retained?.retryable
      && retained.queueType === queue.queueType
      && retained.action === action
      && serverIntentMatchesQueue(
        retained.serverAction,
        queue.server.status,
        queue.server.connectionGeneration,
        queue.server.actionScope
      )
    ) return { count: retained.count } as const;
    const serverAction = captureServerAction(
      cleanupActionType(action),
      serverRequiresCleanup(action)
    );
    if (serverAction.required && !serverAction.frozen) {
      queue.server.refresh();
      return false;
    }
    const localJobs = captureLocalJobs(cleanupLocalPredicate(action));
    cleanupIntentRef.current = {
      queueType: queue.queueType,
      action,
      count: confirmationCount ?? localJobs.length,
      serverAction,
      localJobs,
      unresolvedLocal: { unresolved: [] },
      retryable: false
    };
    return { count: cleanupIntentRef.current.count } as const;
  }, [
    captureLocalJobs,
    captureServerAction,
    queue.queueType,
    queue.server.actionScope,
    queue.server.connectionGeneration,
    queue.server.refresh,
    queue.server.status,
    serverRequiresCleanup
  ]);

  const confirmCleanupAction = useCallback(async (
    action: UploadCleanupActionId
  ) => {
    const frozen = cleanupIntentRef.current;
    if (
      !frozen
      || frozen.queueType !== queue.queueType
      || frozen.action !== action
    ) return false;
    const executing = frozen.retryable
      ? frozen
      : { ...frozen, retryable: true };
    if (cleanupIntentRef.current === frozen) {
      cleanupIntentRef.current = executing;
    }
    const result = await executeFrozenLocalClear(
      executing,
      cleanupLocalPredicate(executing.action)
    );
    if (action === "completed" && (
      (result.serverResult?.changed ?? 0) > 0 || executing.localJobs.length > 0
    )) onDone();
    if (!result.settled) {
      if (cleanupIntentRef.current === executing) {
        cleanupIntentRef.current = {
          ...executing,
          localJobs: result.retainedLocalJobs,
          unresolvedLocal: result.unresolvedLocal
        };
      }
      return false;
    }
    // 已取得终态响应后，failed/skipped 直接留给卡片状态与详情区域表达；
    // 只有网络/对账尚未收敛时才保留同一冻结意图供弹窗直接重试。
    if (cleanupIntentRef.current === executing) cleanupIntentRef.current = null;
    return true;
  }, [
    executeFrozenLocalClear,
    onDone,
    queue.queueType
  ]);

  const applyDefaultsToQueue = useCallback(() => {
    const summary = queue.server.summary;
    const serverAction = captureServerAction(
      "apply_metadata",
      queue.server.status !== "ready"
        || !summary
        || summary.unfinished - summary.committing - summary.resolving > 0,
      importAttributeDefaultsActionMetadata(defaults)
    );
    if (serverAction.required && !serverAction.frozen) {
      queue.server.refresh();
      return;
    }
    const localJobs = queue.captureBrowserActionJobs(() => true);
    queue.applyDefaultsToLocalJobs(defaults, localJobs);
    if (serverAction.frozen) {
      void queue.actions.run(
        serverAction.frozen,
        queue.flushPendingUpdates,
        { blockUi: false }
      );
    } else {
      void queue.flushPendingUpdates().catch(() => undefined);
    }
  }, [
    captureServerAction,
    defaults,
    queue.actions,
    queue.applyDefaultsToLocalJobs,
    queue.captureBrowserActionJobs,
    queue.flushPendingUpdates,
    queue.server.refresh,
    queue.server.status,
    queue.server.summary
  ]);

  const armClearQueue = useCallback(() => {
    const retained = clearQueueIntentRef.current;
    if (
      retained?.retryable
      && retained.queueType === queue.queueType
      && serverIntentMatchesQueue(
        retained.serverAction,
        queue.server.status,
        queue.server.connectionGeneration,
        queue.server.actionScope
      )
    ) {
      // 操作结果未知时，确认提交已经解除按钮武装。真实 UI 的下一次第一击
      // 必须恢复同一幂等动作和冻结集合，不能把等待期间的新任务纳入范围。
      return true;
    }
    const serverAction = captureServerAction(
      "clear_queue",
      queue.server.status !== "ready"
        || !queue.server.summary
        || queue.server.summary.total > 0
    );
    if (serverAction.required && !serverAction.frozen) {
      queue.server.refresh();
      return false;
    }
    clearQueueIntentRef.current = {
      queueType: queue.queueType,
      serverAction,
      localJobs: captureLocalJobs(() => true),
      unresolvedLocal: { unresolved: [] },
      retryable: false
    };
    return true;
  }, [
    captureLocalJobs,
    captureServerAction,
    queue.queueType,
    queue.server.actionScope,
    queue.server.connectionGeneration,
    queue.server.refresh,
    queue.server.summary?.total,
    queue.server.status
  ]);

  const confirmClearQueue = useCallback(async () => {
    const frozen = clearQueueIntentRef.current;
    if (
      !frozen
      || frozen.queueType !== queue.queueType
    ) return false;
    const executing = frozen.retryable
      ? frozen
      : { ...frozen, retryable: true };
    if (clearQueueIntentRef.current === frozen) {
      clearQueueIntentRef.current = executing;
    }
    const result = await executeFrozenLocalClear(executing, () => true);
    if (!result.settled) {
      if (clearQueueIntentRef.current === executing) {
        clearQueueIntentRef.current = {
          ...executing,
          localJobs: result.retainedLocalJobs,
          unresolvedLocal: result.unresolvedLocal
        };
      }
      return false;
    }
    if (clearQueueIntentRef.current === executing) {
      clearQueueIntentRef.current = null;
    }
    return true;
  }, [
    executeFrozenLocalClear,
    queue.queueType
  ]);

  const commitReadyJobs = useCallback(async () => {
    const capturedServerAction = captureServerAction(
      "commit_ready",
      queue.server.status !== "ready"
        || !queue.server.summary
        || queue.server.summary.ready > 0
    );
    if (capturedServerAction.required && !capturedServerAction.frozen) {
      queue.server.refresh();
      return;
    }
    const serverAction = capturedServerAction.frozen;
    const localJobs = queue.captureBrowserActionJobs((job) => (
      importJobCanStartCommit(job, job.commitIntent ? "resume" : "new")
    ));
    const commitCapturedLocalJobs = () => (
      localJobs.length ? commitJobs(localJobs) : Promise.resolve(false)
    );
    if (!serverAction) {
      const committed = await commitCapturedLocalJobs();
      if (committed) onDone();
      return;
    }
    let localCommitted = false;
    const result = await queue.actions.run(serverAction, async () => {
      localCommitted = await commitCapturedLocalJobs();
    });
    if (localCommitted || (result?.changed ?? 0) > 0) onDone();
  }, [
    onDone,
    captureServerAction,
    commitJobs,
    queue.actions,
    queue.captureBrowserActionJobs,
    queue.server.refresh,
    queue.server.summary?.ready,
    queue.server.status
  ]);

  const confirmationScope = useMemo(() => [
    queue.queueType,
    queue.server.connectionGeneration,
    queue.server.actionScope
  ].join("\0"), [
    queue.queueType,
    queue.server.actionScope,
    queue.server.connectionGeneration
  ]);

  const discardUnconfirmedIntents = useCallback(() => {
    if (!cleanupIntentRef.current?.retryable) cleanupIntentRef.current = null;
    if (!clearQueueIntentRef.current?.retryable) clearQueueIntentRef.current = null;
  }, []);

  useEffect(() => {
    // A scope generation is the authority boundary for every frozen action.
    // Once it changes even result-unknown retries can no longer be replayed.
    cleanupIntentRef.current = null;
    clearQueueIntentRef.current = null;
  }, [confirmationScope]);

  useEffect(() => () => {
    cleanupIntentRef.current = null;
    clearQueueIntentRef.current = null;
    deferredCompletedCleanupRef.current = [];
    runningCompletedCleanupRevisionsRef.current.clear();
  }, []);

  return {
    runCleanupAction,
    armCleanupAction,
    confirmCleanupAction,
    applyDefaultsToQueue,
    armClearQueue,
    confirmClearQueue,
    commitReadyJobs,
    confirmationScope,
    discardUnconfirmedIntents
  };
}
