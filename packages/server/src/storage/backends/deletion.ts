import {
  storageBackendDeletionStateFromBlockers,
  type StorageBackendDeleteBlocker,
  type StorageBackendDeletionState
} from "@imageshow/shared/browser";

type StorageBackendDeletionInput = {
  slug: string;
  is_default: boolean;
  image_count: number;
  ingestion_session_count: number;
  cleanup_job_count: number;
  staging_object_count?: number;
};

function positiveCount(value: number | undefined) {
  return Number(value ?? 0) > 0;
}

/**
 * 存储后端管理列表和最终删除命令共用的删除策略。
 *
 * 内置 local 直接返回 built_in 阻断；自定义后端有图片时优先建议迁移；
 * 迁移完成后，列表会继续展示默认项、会话或清理任务等剩余阻断原因。
 */
export function resolveStorageBackendDeletionState(
  input: StorageBackendDeletionInput
): StorageBackendDeletionState {
  if (input.slug === "local") {
    return storageBackendDeletionStateFromBlockers(["built_in"]);
  }

  const blockers: StorageBackendDeleteBlocker[] = [];
  if (input.is_default) blockers.push("default");
  if (positiveCount(input.image_count)) blockers.push("images");
  if (positiveCount(input.ingestion_session_count)) {
    blockers.push("ingestion_sessions");
  }
  if (positiveCount(input.cleanup_job_count)) blockers.push("cleanup_jobs");
  if (positiveCount(input.staging_object_count)) {
    blockers.push("staging_objects");
  }

  return storageBackendDeletionStateFromBlockers(blockers);
}
