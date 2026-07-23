import type { StorageType } from "@imageshow/shared";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { countUnresolvedMoveCleanupJobs } from "./move-cleanup-repository.ts";

export type StorageBackendUsage = {
  image_count: number;
  import_session_count: number;
  cleanup_job_count: number;
  staging_object_count: number;
};

export type StorageBackendSnapshot = {
  slug: string;
  type: StorageType;
  config: unknown;
  namespace_identities: string[];
  is_default: boolean;
  image_count: number;
  import_session_count: number;
  cleanup_job_count: number;
};

export function storageBackendUsage(
  row: Record<string, unknown>,
  stagingObjectCount = 0
): StorageBackendUsage {
  return {
    image_count: Number(row.image_count ?? 0),
    import_session_count: Number(row.import_session_count ?? 0),
    cleanup_job_count: Number(row.cleanup_job_count ?? 0),
    staging_object_count: stagingObjectCount
  };
}

export function assertPhysicalLocationChangeAllowed(
  changedFields: readonly string[],
  usage: StorageBackendUsage
) {
  if (
    !changedFields.length
    || (!usage.image_count
      && !usage.import_session_count
      && !usage.cleanup_job_count
      && !usage.staging_object_count)
  ) {
    return;
  }
  throw new ApiError(
    409,
    "storage_location_change_requires_migration",
    "该后端仍有图片、未清理导入会话、旧对象删除任务或暂存对象，物理位置暂不可变更",
    { fields: changedFields, ...usage }
  );
}

export async function readStorageBackendSnapshot(
  slug: string
): Promise<StorageBackendSnapshot> {
  const row = (await pool.query(
    `SELECT backend.slug,
            backend.type,
            backend.config,
            backend.namespace_identities,
            backend.is_default,
            (SELECT count(*)::int
               FROM metadata
              WHERE metadata.storage_slug=backend.slug) AS image_count,
            (SELECT count(*)::int
               FROM import_session
              WHERE import_session.storage_slug=backend.slug)
              AS import_session_count
       FROM storage_backend AS backend
      WHERE backend.slug=$1`,
    [slug]
  )).rows[0] as StorageBackendSnapshot | undefined;
  if (!row) {
    throw new ApiError(
      404,
      "storage_backend_not_found",
      `Unknown storage backend: ${slug}`
    );
  }
  row.cleanup_job_count = await countUnresolvedMoveCleanupJobs(slug);
  return row;
}
