import type { ImportJob } from "../../../lib/types.js";
import {
  cancelStoredImport,
  createImportSession,
  getStoredImportStatus,
  prepareImportSession,
  type ImportSessionCreateInput,
  type ImportSessionHandle,
  type PreparedImport
} from "./import-api.js";
import {
  applyPreparedResult,
  isCurrentImportAttempt,
  type AppendImportQueueApi,
  type ImportQueueApi,
  type PreparedApplyResult
} from "./prepared-result.js";

export type ImportAttemptResult = {
  session: ImportSessionHandle;
  prepared: PreparedImport;
  acceptance: PreparedApplyResult;
};

const preparationAdmissionStatuses = new Set([
  "preparing",
  "ready",
  "committing",
  "finalized"
]);
const preparationAdmissionPollDelays = [100, 200, 400, 800, 1_000] as const;

function preparationAdmissionPollDelay(attempt: number) {
  return preparationAdmissionPollDelays[
    Math.min(Math.max(0, attempt), preparationAdmissionPollDelays.length - 1)
  ];
}

function abortableDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = globalThis.setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      globalThis.clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

async function waitForPreparationAdmission<T>(
  sessionId: string,
  preparation: Promise<T>,
  signal: AbortSignal,
  onAdmitted: () => void
) {
  const completion = preparation.then(
    (value) => ({ kind: "complete" as const, ok: true as const, value }),
    (error: unknown) => ({ kind: "complete" as const, ok: false as const, error })
  );
  let pollAttempt = 0;
  while (true) {
    const observed = await Promise.race([
      completion,
      getStoredImportStatus(sessionId, signal).then(
        (status) => ({ kind: "status" as const, status }),
        () => ({ kind: "status" as const, status: undefined })
      )
    ]);
    if (observed.kind === "complete") {
      onAdmitted();
      if (!observed.ok) throw observed.error;
      return observed.value;
    }
    if (observed.status
      && preparationAdmissionStatuses.has(observed.status.status)) {
      onAdmitted();
      return completion.then((result) => {
        if (!result.ok) throw result.error;
        return result.value;
      });
    }
    // Back off status polling while still returning immediately when the
    // prepare request completes during the delay.
    const delayed = await Promise.race([
      completion,
      abortableDelay(preparationAdmissionPollDelay(pollAttempt), signal)
        .then(() => ({ kind: "retry" as const }))
    ]);
    if (delayed.kind === "complete") {
      onAdmitted();
      if (!delayed.ok) throw delayed.error;
      return delayed.value;
    }
    pollAttempt += 1;
  }
}

export async function cancelImportAttempt(
  queue: ImportQueueApi,
  job: ImportJob,
  abort: (() => void) | undefined,
  cancelSession: (sessionId: string) => Promise<unknown> = cancelStoredImport
): Promise<boolean> {
  queue.updateJob(job.id, {
    status: "cancelling",
    failureStage: undefined,
    commitFailureCheckpoint: undefined,
    message: "正在取消并清理暂存数据",
    transferProgress: undefined
  });
  abort?.();

  const sessionId = queue.jobsRef.current.find((item) => item.id === job.id)?.sessionId
    ?? job.sessionId;
  if (!sessionId) return true;

  try {
    await cancelSession(sessionId);
    return true;
  } catch (error) {
    const current = queue.jobsRef.current.find((item) => item.id === job.id);
    if (current?.status === "cancelling") {
      const reason = error instanceof Error && error.message.trim()
        ? error.message
        : "未知错误";
      queue.updateJob(job.id, {
        status: "failed",
        failureStage: "cancel",
        commitFailureCheckpoint: undefined,
        message: `取消失败：${reason}`
      });
    }
    return false;
  }
}

export async function materializeImportAttempt(options: {
  queue: AppendImportQueueApi;
  job: ImportJob;
  controller: AbortController;
  createInput: ImportSessionCreateInput;
  session?: ImportSessionHandle;
  onSession: (session: ImportSessionHandle) => void;
  materialize: (session: ImportSessionHandle) => Promise<void>;
}): Promise<ImportSessionHandle | null> {
  const { queue, job, controller } = options;
  const attemptKey = job.attemptKey;
  const session = options.session
    ?? await createImportSession(options.createInput, controller.signal);
  if (!isCurrentImportAttempt(queue, job.id, attemptKey)) {
    await cancelStoredImport(session.id).catch(() => undefined);
    return null;
  }

  options.onSession(session);
  await options.materialize(session);
  if (!isCurrentImportAttempt(queue, job.id, attemptKey)) {
    await cancelStoredImport(session.id).catch(() => undefined);
    return null;
  }
  return session;
}

export async function prepareMaterializedImportAttempt(options: {
  queue: AppendImportQueueApi;
  job: ImportJob;
  controller: AbortController;
  session: ImportSessionHandle;
  onPreparing: () => void;
  startSuccessor: () => void;
}): Promise<ImportAttemptResult | null> {
  const { queue, job, controller, session } = options;
  const attemptKey = job.attemptKey;
  if (!isCurrentImportAttempt(queue, job.id, attemptKey)) {
    await cancelStoredImport(session.id).catch(() => undefined);
    return null;
  }
  options.onPreparing();
  const preparation = prepareImportSession(session, controller.signal);
  // The server can queue a prepare request behind its global limiter while the
  // session remains received. Open lookahead only after authoritative status
  // proves that this item entered (or already exited) preparing.
  const preparedPromise = waitForPreparationAdmission(
    session.id,
    preparation,
    controller.signal,
    options.startSuccessor
  );
  const prepared = await preparedPromise;
  const acceptance = applyPreparedResult(queue, job.id, attemptKey, prepared);
  if (acceptance.status === "stale") {
    await cancelStoredImport(session.id).catch(() => undefined);
    return null;
  }
  return { session, prepared, acceptance };
}

function importAttemptErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return "导入已取消";
  if (error instanceof Error && error.message.trim()) return error.message;
  return "导入处理失败";
}

export function applyImportAttemptFailure(
  queue: AppendImportQueueApi,
  jobId: string,
  attemptKey: string,
  error: unknown,
  failureStage: "create" | "prepare" = "prepare"
) {
  const current = queue.jobsRef.current.find((item) => item.id === jobId);
  if (current?.attemptKey === attemptKey && !["cancelling", "cancelled"].includes(current.status)) {
    queue.updateJob(jobId, {
      status: "failed",
      failureStage,
      commitFailureCheckpoint: undefined,
      message: importAttemptErrorMessage(error)
    });
  }
}
