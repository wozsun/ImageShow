import type {
  CommitFailureCheckpoint,
  ImportJob
} from "../../../lib/types.js";
import type { StoredImportStatus } from "./import-api.js";

const preReadyServerStatuses = new Set<StoredImportStatus["status"]>([
  "created",
  "receiving",
  "preparing",
  "failed",
  "missing"
]);

function commitErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "未知错误";
}

export function commitFailurePatchForStatus(
  status: StoredImportStatus | undefined,
  error: unknown
): Partial<ImportJob> {
  const reason = commitErrorMessage(error);
  if (status?.status === "finalized") {
    return {
      status: "done",
      failureStage: undefined,
      commitFailureCheckpoint: undefined,
      message: "服务端已完成提交"
    };
  }
  if (status?.status === "cancelled") {
    return {
      status: "cancelled",
      failureStage: undefined,
      commitFailureCheckpoint: undefined,
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
    message
  };
}
