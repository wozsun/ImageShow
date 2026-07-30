import {
  storageBackendDeletionStateFromBlockers,
  type StorageBackendDeleteAction,
  type StorageBackendDeleteBlocker
} from "@imageshow/shared/browser";
import { isApiClientError } from "../../../lib/api/client.js";
import type { StorageBackendAdmin } from "../../../lib/types.js";

const storageBackendDeleteBlockers = new Set<StorageBackendDeleteBlocker>([
  "built_in",
  "default",
  "images",
  "import_sessions",
  "cleanup_jobs",
  "staging_objects"
]);
const storageBackendDeleteActions = new Set<StorageBackendDeleteAction>([
  "delete",
  "migrate",
  "blocked"
]);

function countFromDetails(
  details: Record<string, unknown>,
  key: string,
  fallback: number
) {
  const value = details[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

export function storageBackendDeletionReasons(
  backend: StorageBackendAdmin
) {
  return backend.deletion.blockers.map((blocker) => {
    switch (blocker) {
      case "built_in":
        return "local 是内置本地存储后端，不能从注册表中删除。";
      case "default":
        return "它是当前默认上传后端；请先启用其他后端并将其设为默认。";
      case "images":
        return `仍有 ${backend.image_count} 张图片使用该后端；请先迁移这些图片。`;
      case "import_sessions":
        return `仍有 ${backend.import_session_count} 个未清理导入会话；请等待会话清理完成。`;
      case "cleanup_jobs":
        return `仍有 ${backend.cleanup_job_count} 个旧对象删除任务；请等待任务完成，耗尽重试的任务可在卡片上重新排队。`;
      case "staging_objects":
        return "后端仍有上传暂存对象；请先运行存储检查并清理无效暂存。";
    }
  });
}

export function storageBackendAfterDeleteRejection(
  backend: StorageBackendAdmin,
  error: unknown
): StorageBackendAdmin | null {
  if (!isApiClientError(error)) return null;
  if (
    error.code !== "storage_default_delete"
    && error.code !== "storage_backend_in_use"
  ) return null;

  const details = error.details
    && typeof error.details === "object"
    && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  const deletion = details.deletion
    && typeof details.deletion === "object"
    && !Array.isArray(details.deletion)
    ? details.deletion as Record<string, unknown>
    : {};
  const action = typeof deletion.action === "string"
    && storageBackendDeleteActions.has(
      deletion.action as StorageBackendDeleteAction
    )
    ? deletion.action as StorageBackendDeleteAction
    : null;
  const blockers = Array.isArray(deletion.blockers)
    ? deletion.blockers.filter(
      (blocker): blocker is StorageBackendDeleteBlocker =>
        typeof blocker === "string"
        && storageBackendDeleteBlockers.has(
          blocker as StorageBackendDeleteBlocker
        )
    )
    : [];
  if (!action || (action !== "delete" && !blockers.length)) return null;

  return {
    ...backend,
    image_count: countFromDetails(details, "image_count", backend.image_count),
    import_session_count: countFromDetails(
      details,
      "import_session_count",
      backend.import_session_count
    ),
    cleanup_job_count: countFromDetails(
      details,
      "cleanup_job_count",
      backend.cleanup_job_count
    ),
    deletion: {
      action,
      blockers
    }
  };
}

export function storageBackendWithHiddenStagingBlocker(
  backend: StorageBackendAdmin,
  responseBackend: StorageBackendAdmin | null
) {
  if (
    !responseBackend?.deletion.blockers.includes("staging_objects")
    || backend.deletion.blockers.includes("staging_objects")
  ) return backend;
  return {
    ...backend,
    deletion: storageBackendDeletionStateFromBlockers([
      ...backend.deletion.blockers,
      "staging_objects"
    ])
  };
}
