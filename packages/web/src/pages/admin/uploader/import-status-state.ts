import type {
  CommitFailureCheckpoint,
  ImportJob
} from "../../../lib/types.js";
import {
  storedImportStatusMessage,
  type StoredImportStatus
} from "./import-api.js";

const preReadyServerStatuses = new Set<StoredImportStatus["status"]>([
  "created",
  "materializing",
  "received",
  "preparing",
  "failed",
  "missing"
]);

const unavailablePreparedPreview = {
  preview: "",
  previewFull: undefined
};

const importStatusOrder = new Map<ImportJob["status"], number>([
  ["queued", 0],
  ["uploading", 1],
  ["downloading", 1],
  ["received", 2],
  ["processing", 3],
  ["ready", 4],
  ["commit-queued", 5],
  ["committing", 6],
  ["finalized", 7],
  ["done", 8]
]);

const authoritativeStatusOrder = new Map<StoredImportStatus["status"], number>([
  ["created", 0],
  ["materializing", 1],
  ["received", 2],
  ["preparing", 3],
  ["ready", 4],
  ["committing", 5],
  ["finalized", 6]
]);

const authoritativePhaseOrder = new Map<string, number>([
  ["created", 0],
  ["materialize-waiting", 1],
  ["materializing", 0],
  ["uploading", 1],
  ["downloading", 1],
  ["received", 0],
  ["prepare-waiting", 1],
  ["preparing", 0],
  ["normalizing", 1],
  ["detecting", 2],
  ["staging", 3],
  ["ready", 0],
  ["committing", 0],
  ["finalized", 0],
  ["failed", 0],
  ["cancelled", 0]
]);

function clientStatusPatchMovesForward(
  job: ImportJob,
  patch: Partial<ImportJob>
) {
  if (!patch.status) return true;
  if (job.status === "done") return patch.status === "done";
  if (job.status === "finalized") {
    return patch.status === "finalized" || patch.status === "done";
  }
  if (job.status === "cancelled") return patch.status === "cancelled";
  if (job.status === "cancelling") {
    return patch.status === "cancelled"
      || (patch.status === "failed" && patch.failureStage === "cancel");
  }
  if (job.status === "failed") {
    if (patch.status === "failed") return true;
    if (
      job.failureStage === "cancel"
      && ["cancelling", "cancelled"].includes(patch.status)
    ) {
      return true;
    }
    return Boolean(job.commitIntent) && [
      "commit-queued",
      "committing",
      "finalized",
      "done"
    ].includes(patch.status);
  }
  if (patch.status === "failed") return true;
  const currentOrder = importStatusOrder.get(job.status);
  const nextOrder = importStatusOrder.get(patch.status);
  return !(currentOrder !== undefined
    && nextOrder !== undefined
    && nextOrder < currentOrder);
}

function authoritativeSnapshotMovesForward(
  job: ImportJob,
  patch: Partial<ImportJob>
) {
  const nextStatus = patch.serverStatus;
  const currentStatus = job.serverStatus;
  if (!nextStatus || !currentStatus) return true;
  if (nextStatus !== currentStatus) {
    if (["finalized", "failed", "cancelled", "missing"].includes(currentStatus)) {
      return false;
    }
    if (nextStatus === "failed" || nextStatus === "cancelled") return true;
    if (nextStatus === "missing") return false;
    const currentOrder = authoritativeStatusOrder.get(currentStatus);
    const nextOrder = authoritativeStatusOrder.get(nextStatus);
    return currentOrder !== undefined
      && nextOrder !== undefined
      && nextOrder > currentOrder;
  }

  const currentPhase = job.serverPhase;
  const nextPhase = patch.serverPhase;
  if (currentPhase && nextPhase && nextPhase !== currentPhase) {
    const currentOrder = authoritativePhaseOrder.get(currentPhase);
    const nextOrder = authoritativePhaseOrder.get(nextPhase);
    return currentOrder !== undefined
      && nextOrder !== undefined
      && nextOrder > currentOrder;
  }
  if (currentPhase && !nextPhase) return false;

  if (
    currentPhase === nextPhase
    && job.serverProgress !== undefined
    && (
      patch.serverProgress === undefined
      || patch.serverProgress < job.serverProgress
    )
  ) {
    return false;
  }
  return true;
}

export function importStatusPatchMovesForward(
  job: ImportJob,
  patch: Partial<ImportJob>
) {
  return clientStatusPatchMovesForward(job, patch)
    && authoritativeSnapshotMovesForward(job, patch);
}

function orderedImportStatusPatch(
  job: ImportJob,
  patch: Partial<ImportJob>
) {
  return importStatusPatchMovesForward(job, patch) ? patch : null;
}

function authoritativeStatusPatch(
  job: ImportJob,
  state: StoredImportStatus,
  patch: Partial<ImportJob>
) {
  if (
    !job.sessionId
    || job.sessionId.toLowerCase() !== state.id.toLowerCase()
  ) {
    return null;
  }
  return orderedImportStatusPatch(job, {
    ...patch,
    serverStatus: state.status,
    serverPhase: state.phase,
    serverError: state.error,
    serverProgress: state.progress,
    serverAttemptKey: job.attemptKey,
    serverSessionId: job.sessionId
  });
}

function commitErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "未知错误";
}

export function importStatusEventPatch(
  job: ImportJob,
  state: StoredImportStatus
): Partial<ImportJob> | null {
  if (state.phase === "materialize-waiting") {
    return authoritativeStatusPatch(job, state, { status: "queued" });
  }
  if (state.status === "created") {
    return authoritativeStatusPatch(job, state, { status: "queued" });
  }
  if (state.status === "materializing") {
    return authoritativeStatusPatch(job, state, job.kind === "local"
      ? { status: "uploading" }
      : { status: "downloading", transferProgress: state.progress });
  }
  if (state.status === "received") {
    return authoritativeStatusPatch(job, state, {
      status: "received",
      transferProgress: undefined
    });
  }
  if (state.status === "preparing" || state.status === "ready") {
    if (job.commitIntent) {
      return authoritativeStatusPatch(job, state, {});
    }
    return authoritativeStatusPatch(job, state, {
      status: "processing",
      transferProgress: undefined
    });
  }
  if (state.status === "committing") {
    return authoritativeStatusPatch(job, state, { status: "committing" });
  }
  if (state.status === "finalized") {
    return authoritativeStatusPatch(job, state, {
      status: "finalized",
      resultState: job.resultState ?? "pending",
      ...unavailablePreparedPreview
    });
  }
  if (state.status === "missing") return null;
  if (state.status === "failed") {
    if (job.commitIntent) {
      return authoritativeStatusPatch(job, state, {
        status: "failed",
        failureStage: "commit",
        commitFailureCheckpoint: "unknown",
        message: storedImportStatusMessage(state)
      });
    }
    return authoritativeStatusPatch(job, state, {
      status: "failed",
      failureStage: "prepare",
      message: storedImportStatusMessage(state)
    });
  }
  if (state.status === "cancelled") {
    return authoritativeStatusPatch(job, state, {
      status: "cancelled",
      ...unavailablePreparedPreview,
      message: storedImportStatusMessage(state)
    });
  }
  return null;
}

export type CommitRetryResolution =
  | { action: "commit"; patch?: Partial<ImportJob> }
  | { action: "reconcile"; patch: Partial<ImportJob> }
  | { action: "stop"; patch: Partial<ImportJob> };

export function resolveCommitRetry(
  status: StoredImportStatus | undefined,
  error: unknown
): CommitRetryResolution {
  if (status?.status === "ready") {
    return {
      action: "reconcile",
      patch: {
        status: "failed",
        failureStage: "commit",
        commitFailureCheckpoint: "ready",
        resultState: undefined,
        resultError: undefined,
        message: "已确认提交尚未开始，请重试"
      }
    };
  }
  if (status?.status === "committing") {
    return { action: "commit", patch: { status: "committing" } };
  }
  if (status?.status === "finalized") {
    return {
      action: "commit",
      patch: {
        status: "finalized",
        resultState: "recovering",
        resultError: undefined,
        ...unavailablePreparedPreview
      }
    };
  }
  return {
    action: "stop",
    patch: commitFailurePatchForStatus(status, error)
  };
}

function commitFailurePatchForStatus(
  status: StoredImportStatus | undefined,
  error: unknown
): Partial<ImportJob> {
  const reason = commitErrorMessage(error);
  if (status?.status === "finalized") {
    return {
      status: "finalized",
      ...unavailablePreparedPreview,
      resultState: "error",
      resultError: reason,
      message: `服务端已完成提交，但结果读取失败：${reason}；请重试获取结果`
    };
  }
  if (status?.status === "cancelled") {
    return {
      status: "cancelled",
      failureStage: undefined,
      commitFailureCheckpoint: undefined,
      ...unavailablePreparedPreview,
      resultState: undefined,
      resultError: undefined,
      message: status.message || "导入已取消"
    };
  }
  if (status && preReadyServerStatuses.has(status.status)) {
    const message = status.status === "missing"
      ? "提交会话不存在，需要重新处理"
      : status.status === "failed"
        ? status.error || "服务端处理失败，需要重新处理"
        : "服务端尚未准备完成，需要重新处理";
    return {
      status: "failed",
      failureStage: "prepare",
      commitFailureCheckpoint: undefined,
      ...unavailablePreparedPreview,
      resultState: undefined,
      resultError: undefined,
      message
    };
  }

  const checkpoint: CommitFailureCheckpoint = status?.status === "ready"
    ? "ready"
    : status?.status === "committing"
      ? "committing"
      : "unknown";
  const message = checkpoint === "ready"
    ? `提交未开始：${reason}`
    : checkpoint === "committing"
      ? `提交中断：${reason}；属性已锁定，可重试继续提交`
      : `提交失败：${reason}`;
  return {
    status: "failed",
    failureStage: "commit",
    commitFailureCheckpoint: checkpoint,
    ...(checkpoint === "ready"
      ? {}
      : unavailablePreparedPreview),
    resultState: undefined,
    resultError: undefined,
    message
  };
}

export function commitResultFailurePatch(
  job: ImportJob,
  status: StoredImportStatus | undefined,
  error: unknown
): Partial<ImportJob> {
  if (job.status === "finalized" || job.serverStatus === "finalized") {
    return commitFailurePatchForStatus({
      id: job.sessionId ?? job.id,
      status: "finalized",
      phase: "finalized",
      error: "",
      message: "已写入图库"
    }, error);
  }
  const patch = commitFailurePatchForStatus(status, error);
  if (
    job.commitIntent
    && patch.status === "failed"
    && patch.failureStage !== "commit"
  ) {
    const reason = status?.status === "missing"
      ? "提交会话不存在"
      : status?.status === "failed"
        ? status.error || "服务端会话已失败"
        : "服务端会话回到了提交前状态";
    return {
      ...patch,
      failureStage: "commit",
      commitFailureCheckpoint: "unknown",
      message: `提交状态异常：${reason}；属性已锁定，可重试确认结果`
    };
  }
  return patch;
}
