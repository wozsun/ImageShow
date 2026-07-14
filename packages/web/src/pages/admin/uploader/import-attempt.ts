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
  type PreparedApplyResult
} from "./prepared-result.js";

export type ImportAttemptResult = {
  session: ImportSessionHandle;
  prepared: PreparedImport;
  acceptance: PreparedApplyResult;
};

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
  error: unknown
) {
  const current = queue.jobsRef.current.find((item) => item.id === jobId);
  if (current?.attemptKey === attemptKey && current.status !== "cancelled") {
    queue.updateJob(jobId, {
      status: "failed",
      failureStage: "prepare",
      message: importAttemptErrorMessage(error)
    });
  }
}
