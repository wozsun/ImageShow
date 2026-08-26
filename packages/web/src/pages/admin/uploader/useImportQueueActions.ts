import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ImageDraftDto,
  ImportQueueActionResultDto,
  ImportQueueActionTypeDto
} from "@imageshow/shared/browser";
import { webUuidV7 } from "../../../lib/upload/upload-utils.js";
import { isApiClientError } from "../../../lib/api/client.js";
import { executeImportQueueAction } from "./import-api.js";
import type {
  CompletedImportObservation
} from "./import-queue-api.js";
import type { ServerImportQueueController } from "./useServerImportQueue.js";

export type FrozenImportQueueAction = Readonly<{
  queue: "upload" | "import";
  actionRequestId: string;
  action: ImportQueueActionTypeDto;
  metadata?: Partial<ImageDraftDto>;
  maxSemanticRevision?: number;
  actionScope: string;
  actionWatermark: string;
  connectionGeneration: number;
}>;

const maximumActionBatches = 10_000;

function staleActionError() {
  return new Error("导入队列状态已变化，请刷新后重新执行");
}

async function executeWithResponseRetry(
  frozen: FrozenImportQueueAction,
  continuation: string | undefined,
  signal: AbortSignal
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await executeImportQueueAction({
        queue: frozen.queue,
        action_request_id: frozen.actionRequestId,
        action: frozen.action,
        action_watermark: frozen.actionWatermark,
        ...(continuation ? { continuation } : {}),
        ...(frozen.metadata ? { metadata: frozen.metadata } : {}),
        ...(frozen.maxSemanticRevision === undefined
          ? {}
          : { max_semantic_revision: frozen.maxSemanticRevision })
      }, frozen.actionScope, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (isApiClientError(error) && error.status < 500) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

export function useImportQueueActions(
  queue: "upload" | "import",
  server: ServerImportQueueController,
  connectionHoldRef: { current: boolean },
  observeCompletedImports: (
    entries: readonly CompletedImportObservation[]
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
  const refreshRequestedRef = useRef(false);
  const lastActionTimestampRef = useRef(0);
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
    };
  }, [connectionHoldRef]);

  const freeze = useCallback((
    action: ImportQueueActionTypeDto,
    metadata?: Partial<ImageDraftDto>,
    options?: Readonly<{ maxSemanticRevision?: number }>
  ): FrozenImportQueueAction | null => {
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
    frozen: FrozenImportQueueAction,
    before?: () => Promise<void>,
    options?: Readonly<{ blockUi?: boolean }>
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
      try {
        await before?.();
        let continuation: string | undefined;
        let processed = 0;
        let changed = 0;
        let failed = 0;
        const items: ImportQueueActionResultDto["items"] = [];
        const completed: CompletedImportObservation[] = [];
        const seenContinuations = new Set<string>();
        try {
          for (let batch = 0; batch < maximumActionBatches; batch += 1) {
            const current = serverRef.current;
            if (
              current.connectionGeneration !== frozen.connectionGeneration
              || current.actionScope !== frozen.actionScope
            ) throw staleActionError();
            const response = await executeWithResponseRetry(
              frozen,
              continuation,
              controller.signal
            );
            completed.push(...response.items.flatMap((item) => (
              item.completed_item
                ? [{ pair: item, item: item.completed_item }]
                : []
            )));
            processed += response.processed;
            changed += response.changed;
            failed += response.failed;
            items.push(...response.items);
            if (!response.continuation) {
              const failures = items.filter((item) => item.status === "failed");
              setNotice(failures.length === 1
                ? failures[0]?.message || "队列操作失败"
                : failures.length > 1
                  ? `${failures.length} 项队列操作失败`
                  : "");
              return { processed, changed, failed, items };
            }
            if (seenContinuations.has(response.continuation)) {
              throw new Error("导入队列操作返回了重复游标");
            }
            seenContinuations.add(response.continuation);
            continuation = response.continuation;
          }
          throw new Error("导入队列操作批次数超过安全上限");
        } finally {
          if (completed.length) observeCompletedImports(completed);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setNotice(message);
        if (
          recoverAuthSession
          && isApiClientError(error)
          && error.status === 401
          && error.code === "invalid_import_token"
        ) {
          try {
            // The failed action is never replayed. Refresh the shared session
            // first so this owner's single authoritative snapshot carries the
            // current CSRF and replaces the expired signed watermark.
            await recoverAuthSession();
            await serverRef.current.recoverAuthority();
            if (mountedRef.current) setNotice("");
          } catch {
            // Keep the original credential error visible. Authentication and
            // queue controllers expose their own retry/login state.
          }
          return null;
        }
        refreshRequestedRef.current = true;
        return null;
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
        if (refreshRequestedRef.current) {
          refreshRequestedRef.current = false;
          serverRef.current.refresh();
        }
      }
    });
  }, [observeCompletedImports, recoverAuthSession, updateConnectionHold]);

  return {
    busy,
    notice,
    freeze,
    run,
    retainConnection
  };
}
