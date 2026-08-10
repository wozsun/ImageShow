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
  previewFallback: undefined,
  previewFull: undefined
};

const importStatusOrder = new Map<ImportJob["status"], number>([
  ["queued", 0],
  ["uploading", 1],
  ["downloading", 1],
  ["received", 2],
  ["processing", 3],
  ["ready", 4],
  ["committing", 5],
  ["done", 6]
]);

function orderedImportStatusPatch(
  job: ImportJob,
  patch: Partial<ImportJob>
) {
  if (!patch.status) return patch;
  const currentOrder = importStatusOrder.get(job.status);
  const nextOrder = importStatusOrder.get(patch.status);
  return currentOrder !== undefined
    && nextOrder !== undefined
    && nextOrder < currentOrder
    ? null
    : patch;
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
  const message = storedImportStatusMessage(state);
  if (state.phase === "materialize-waiting") {
    return orderedImportStatusPatch(job, { status: "queued", message });
  }
  if (state.status === "created") {
    return orderedImportStatusPatch(job, { status: "queued", message });
  }
  if (state.status === "materializing") {
    return orderedImportStatusPatch(job, job.kind === "local"
      ? { status: "uploading", message }
      : { status: "downloading", message, transferProgress: state.progress });
  }
  if (state.status === "received") {
    return orderedImportStatusPatch(job, {
      status: "received",
      message,
      transferProgress: undefined
    });
  }
  if (state.status === "preparing" || state.status === "ready") {
    return orderedImportStatusPatch(job, {
      status: "processing",
      message,
      transferProgress: undefined
    });
  }
  if (state.status === "committing") {
    return orderedImportStatusPatch(job, { status: "committing", message });
  }
  if (state.status === "finalized") {
    return orderedImportStatusPatch(job, {
      status: "committing",
      ...unavailablePreparedPreview,
      message: "服务端已完成提交，正在读取结果"
    });
  }
  if (state.status === "missing") return null;
  if (state.status === "failed") {
    return { status: "failed", failureStage: "prepare", message };
  }
  if (state.status === "cancelled") {
    return {
      status: "cancelled",
      ...unavailablePreparedPreview,
      message
    };
  }
  return null;
}

export type CommitRetryResolution =
  | { action: "commit" }
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
        message: "已确认提交尚未开始，请重试"
      }
    };
  }
  if (status?.status === "committing" || status?.status === "finalized") {
    return { action: "commit" };
  }
  return {
    action: "stop",
    patch: commitFailurePatchForStatus(status, error)
  };
}

export function commitFailurePatchForStatus(
  status: StoredImportStatus | undefined,
  error: unknown
): Partial<ImportJob> {
  const reason = commitErrorMessage(error);
  if (status?.status === "finalized") {
    return {
      status: "failed",
      failureStage: "commit",
      commitFailureCheckpoint: "committing",
      ...unavailablePreparedPreview,
      message: `服务端已完成提交，但结果读取失败：${reason}；请重试获取结果`
    };
  }
  if (status?.status === "cancelled") {
    return {
      status: "cancelled",
      failureStage: undefined,
      commitFailureCheckpoint: undefined,
      ...unavailablePreparedPreview,
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
    message
  };
}
