import type { ImportJob } from "../../../lib/types.js";
import {
  cancelStoredImport,
  createImportSession,
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

export async function cancelImportAttempt(
  queue: ImportQueueApi,
  job: ImportJob,
  abort: (() => void) | undefined,
  cancelSession: (sessionId: string) => Promise<unknown> = cancelStoredImport
): Promise<boolean> {
  queue.updateJob(job.id, {
    status: "cancelling",
    failureStage: undefined,
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
        message: `取消失败：${reason}`
      });
    }
    return false;
  }
}

export async function runImportAttempt(options: {
  queue: AppendImportQueueApi;
  job: ImportJob;
  controller: AbortController;
  createInput: ImportSessionCreateInput;
  session?: ImportSessionHandle;
  onSession: (session: ImportSessionHandle) => void;
  transfer?: (session: ImportSessionHandle) => Promise<void>;
  onPreparing: () => void;
}): Promise<ImportAttemptResult | null> {
  const { queue, job, controller } = options;
  const attemptKey = job.attemptKey;
  const session = options.session
    ?? await createImportSession(options.createInput, controller.signal);
  if (!isCurrentImportAttempt(queue, job.id, attemptKey)) {
    await cancelStoredImport(session.id).catch(() => undefined);
    return null;
  }

  options.onSession(session);
  if (options.transfer) {
    await options.transfer(session);
    if (!isCurrentImportAttempt(queue, job.id, attemptKey)) {
      await cancelStoredImport(session.id).catch(() => undefined);
      return null;
    }
  }

  options.onPreparing();
  const prepared = await prepareImportSession(session, controller.signal);
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
      message: importAttemptErrorMessage(error)
    });
  }
}
