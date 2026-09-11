import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImageDraftDto,
  IngestionQueueActionResultDto,
  IngestionQueueActionTypeDto,
  IngestionSessionPairDto
} from "@imageshow/shared/browser";
import { webUuidV7 } from "./model/ingestion-identity.js";
import { isApiClientError } from "../../../../lib/api/client.js";
import { executeIngestionQueueAction } from "./ingestion-api.js";
import type {
  CompletedIngestionObservation
} from "./ingestion-queue-api.js";
import type { ServerIngestionQueueController } from "./useServerIngestionQueue.js";

export type FrozenIngestionQueueAction = Readonly<{
  queue: "upload" | "import";
  actionRequestId: string;
  action: IngestionQueueActionTypeDto;
  metadata?: Partial<ImageDraftDto>;
  items?: IngestionSessionPairDto[];
  maxSemanticRevision?: number;
  actionScope: string;
  actionWatermark: string;
  connectionGeneration: number;
}>;

export type IngestionQueueActionRunOptions = Readonly<{
  blockUi?: boolean;
  onBatchResult?: (result: IngestionQueueActionResultDto) => void;
  onSettled?: () => boolean | Promise<boolean>;
}>;

const maximumActionBatches = 10_000;

type UnconfirmedActionPage = {
  actionRequestId: string;
  actionScope: string;
  connectionGeneration: number;
  continuation: string | undefined;
  batch: number;
  processed: number;
  changed: number;
  failed: number;
  items: IngestionQueueActionResultDto["items"];
  seenContinuations: Set<string>;
};

function staleActionError() {
  return new Error("内容接入队列状态已变化，请刷新后重新执行");
}

function actionResultIsUnknown(error: unknown) {
  return !isApiClientError(error)
    || error.status >= 500
    || error.code === "invalid_json_response";
}

async function executeWithResponseRetry(
  frozen: FrozenIngestionQueueAction,
  continuation: string | undefined,
  signal: AbortSignal
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await executeIngestionQueueAction({
        queue: frozen.queue,
        action_request_id: frozen.actionRequestId,
        action: frozen.action,
        action_watermark: frozen.actionWatermark,
        ...(continuation ? { continuation } : {}),
        ...(frozen.metadata ? { metadata: frozen.metadata } : {}),
        ...(frozen.items ? { items: frozen.items } : {}),
        ...(frozen.maxSemanticRevision === undefined
          ? {}
          : { max_semantic_revision: frozen.maxSemanticRevision })
      }, frozen.actionScope, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (!actionResultIsUnknown(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export function useIngestionQueueActions(
  queue: "upload" | "import",
  server: ServerIngestionQueueController,
  connectionHoldRef: { current: boolean },
  observeCompletedIngestions: (
    entries: readonly CompletedIngestionObservation[]
  ) => void,
  recoverAuthSession?: () => Promise<void>
) {
  const serverRef = useRef(server);
  serverRef.current = server;
  const pendingRunsRef = useRef(0);
  const blockingRunsRef = useRef(0);
  const retainedConnectionsRef = useRef(0);
  const mountedRef = useRef(true);
  const actionTailRef = useRef<Promise<void>>(Promise.resolve());
  const authorityRecoveryRequestedRef = useRef(false);
  const lastActionTimestampRef = useRef(0);
  const unconfirmedPageRef = useRef<UnconfirmedActionPage | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [, setConnectionRetainEpoch] = useState(0);

  const updateConnectionHold = useCallback(() => {
    connectionHoldRef.current = pendingRunsRef.current > 0
      || retainedConnectionsRef.current > 0;
  }, [connectionHoldRef]);

  const retainConnection = useCallback(() => {
    retainedConnectionsRef.current += 1;
    updateConnectionHold();
    setConnectionRetainEpoch((current) => current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      retainedConnectionsRef.current = Math.max(
        0,
        retainedConnectionsRef.current - 1
      );
      updateConnectionHold();
      if (mountedRef.current) {
        setConnectionRetainEpoch((current) => current + 1);
      }
    };
  }, [updateConnectionHold]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      retainedConnectionsRef.current = 0;
      pendingRunsRef.current = 0;
      blockingRunsRef.current = 0;
      connectionHoldRef.current = false;
      unconfirmedPageRef.current = null;
    };
  }, [connectionHoldRef]);

  useEffect(() => {
    unconfirmedPageRef.current = null;
  }, [server.actionScope, server.connectionGeneration]);

  const freeze = useCallback((
    action: IngestionQueueActionTypeDto,
    metadata?: Partial<ImageDraftDto>,
    options?: Readonly<{ maxSemanticRevision?: number }>
  ): FrozenIngestionQueueAction | null => {
    const current = serverRef.current;
    if (
      current.status !== "ready"
      || !current.actionScope
      || !current.actionWatermark
    ) {
      setNotice("");
      return null;
    }
    const actionTimestamp = Math.max(
      Date.now(),
      lastActionTimestampRef.current + 1
    );
    lastActionTimestampRef.current = actionTimestamp;
    return {
      queue,
      actionRequestId: webUuidV7(actionTimestamp),
      action,
      ...(metadata ? { metadata } : {}),
      ...(options?.maxSemanticRevision === undefined
        ? {}
        : { maxSemanticRevision: options.maxSemanticRevision }),
      actionScope: current.actionScope,
      actionWatermark: current.actionWatermark,
      connectionGeneration: current.connectionGeneration
    };
  }, [queue]);

  const run = useCallback(async (
    frozen: FrozenIngestionQueueAction,
    before?: () => Promise<void>,
    options?: IngestionQueueActionRunOptions
  ) => {
    const blocksUi = options?.blockUi !== false;
    pendingRunsRef.current += 1;
    if (pendingRunsRef.current === 1) {
      updateConnectionHold();
    }
    if (blocksUi) {
      blockingRunsRef.current += 1;
      if (blockingRunsRef.current === 1) setBusy(true);
    }
    const execute = async () => {
      setNotice("");
      const controller = new AbortController();
      const retained = unconfirmedPageRef.current;
      const resumed = retained?.actionRequestId === frozen.actionRequestId
        && retained.actionScope === frozen.actionScope
        && retained.connectionGeneration === frozen.connectionGeneration
        ? retained : null;
      if (!resumed) unconfirmedPageRef.current = null;
      let requiresAuthorityRecovery = false;
      let authSessionRecovered = false;
      try {
        await before?.();
        let continuation = resumed?.continuation;
        let processed = resumed?.processed ?? 0;
        let changed = resumed?.changed ?? 0;
        let failed = resumed?.failed ?? 0;
        const items: IngestionQueueActionResultDto["items"] = resumed?.items.slice() ?? [];
        const completed: CompletedIngestionObservation[] = [];
        const seenContinuations = new Set(resumed?.seenContinuations);
        try {
          for (let batch = resumed?.batch ?? 0; batch < maximumActionBatches; batch += 1) {
            const current = serverRef.current;
            if (
              current.connectionGeneration !== frozen.connectionGeneration
              || current.actionScope !== frozen.actionScope
            ) throw staleActionError();
            let response: IngestionQueueActionResultDto;
            try {
              response = await executeWithResponseRetry(frozen, continuation, controller.signal);
            } catch (error) {
              // The server replays only its last action page. Keep that exact
              // cursor and earlier results when a response is still unknown;
              // returning to page one would lose the server's replay boundary.
              unconfirmedPageRef.current = !controller.signal.aborted
                && actionResultIsUnknown(error)
                ? {
                    actionRequestId: frozen.actionRequestId,
                    actionScope: frozen.actionScope,
                    connectionGeneration: frozen.connectionGeneration,
                    continuation, batch, processed, changed, failed, items, seenContinuations
                  } : null;
              throw error;
            }
            completed.push(...response.items.flatMap((item) => (
              item.completed_item
                ? [{ pair: item, item: item.completed_item }]
                : []
            )));
            processed += response.processed;
            changed += response.changed;
            failed += response.failed;
            items.push(...response.items);
            // The action endpoint is paginated. Let its owner consume exact
            // per-item success evidence before the next continuation can be
            // delayed or fail; the callback must not start a proof snapshot.
            options?.onBatchResult?.(response);
            if (!response.continuation) {
              unconfirmedPageRef.current = null;
              const failures = items.filter((item) => item.status === "failed");
              setNotice(failures.length === 1
                ? failures[0]?.message || "队列操作失败"
                : failures.length > 1
                  ? `${failures.length} 项队列操作失败`
                  : "");
              return { processed, changed, failed, items };
            }
            if (seenContinuations.has(response.continuation)) {
              throw new Error("内容接入队列操作返回了重复游标");
            }
            seenContinuations.add(response.continuation);
            continuation = response.continuation;
          }
          throw new Error("内容接入队列操作批次数超过安全上限");
        } finally {
          if (completed.length) observeCompletedIngestions(completed);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNotice(message);
        if (
          recoverAuthSession
          && isApiClientError(error)
          && error.status === 401
          && error.code === "invalid_ingestion_token"
        ) {
          try {
            // The failed action is never replayed. Refresh the shared session
            // first. The common settlement below then lets a caller with
            // earlier successful pages own the single post-action snapshot;
            // otherwise this action performs the ordinary owner recovery.
            await recoverAuthSession();
            authSessionRecovered = true;
          } catch {
            // Keep the original credential error visible. Authentication and
            // queue controllers expose their own retry/login state.
          }
          return null;
        }
        requiresAuthorityRecovery = true;
        return null;
      } finally {
        // A caller that projected per-batch success may perform one stronger
        // post-action recovery here. Await it while this run still owns the
        // connection, and suppress the ordinary failure recovery only when
        // that owner confirms it handled convergence.
        const recoveryHandled = await options?.onSettled?.() ?? false;
        if (authSessionRecovered) {
          if (recoveryHandled) {
            if (mountedRef.current) setNotice("");
          } else {
            try {
              await serverRef.current.recoverAuthority();
              if (mountedRef.current) setNotice("");
            } catch {
              // The owner exposes its bounded retry/error state. Preserve the
              // credential notice until a later authoritative read succeeds.
            }
          }
        }
        if (requiresAuthorityRecovery && !recoveryHandled) {
          authorityRecoveryRequestedRef.current = true;
        }
      }
    };
    const result = actionTailRef.current.then(execute, execute);
    actionTailRef.current = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      pendingRunsRef.current = Math.max(0, pendingRunsRef.current - 1);
      if (blocksUi) {
        blockingRunsRef.current = Math.max(0, blockingRunsRef.current - 1);
        if (blockingRunsRef.current === 0 && mountedRef.current) setBusy(false);
      }
      if (pendingRunsRef.current === 0) {
        updateConnectionHold();
        if (authorityRecoveryRequestedRef.current) {
          authorityRecoveryRequestedRef.current = false;
          void serverRef.current.recoverAuthority().catch(() => undefined);
        }
      }
    });
  }, [observeCompletedIngestions, recoverAuthSession, updateConnectionHold]);

  return {
    busy,
    notice,
    freeze,
    run,
    retainConnection
  };
}
