import type { StorageType } from "@imageshow/shared/browser";
import type { StorageBackendConfigRow } from "./record.ts";
import { ApiError } from "../../core/api-error.ts";
import { pool } from "../../core/database/pools.ts";
import { countUnresolvedMoveCleanupJobs } from "../cleanup/repository.ts";
import { activeIngestionStorageCounts } from "../../images/ingestion/cleanup/storage-references.ts";

export type StorageBackendUsage = {
  image_count: number;
  ingestion_session_count: number;
  cleanup_job_count: number;
};

export type StorageBackendSnapshot = {
  slug: string;
  type: StorageType;
  config: unknown;
  namespace_identities: string[];
  is_default: boolean;
  image_count: number;
  ingestion_session_count: number;
  cleanup_job_count: number;
};

type StorageBackendSnapshotRow = Omit<
  StorageBackendSnapshot,
  "ingestion_session_count" | "cleanup_job_count"
>;

export function storageBackendUsage(row: Record<string, unknown>): StorageBackendUsage {
  return {
    image_count: Number(row.image_count ?? 0),
    ingestion_session_count: Number(row.ingestion_session_count ?? 0),
    cleanup_job_count: Number(row.cleanup_job_count ?? 0)
  };
}

export function assertPhysicalLocationChangeAllowed(
  changedFields: readonly string[],
  usage: StorageBackendUsage
) {
  if (
    !changedFields.length ||
    (!usage.image_count && !usage.ingestion_session_count && !usage.cleanup_job_count)
  ) {
    return;
  }
  throw new ApiError(
    409,
    "storage_location_change_requires_migration",
    "该后端仍有图片、未清理内容接入会话、旧对象删除任务，物理位置暂不可变更",
    { fields: changedFields, ...usage }
  );
}

export async function readStorageBackendSnapshot(
  slug: string,
  signal?: AbortSignal
): Promise<StorageBackendSnapshot> {
  signal?.throwIfAborted();
  const row = (
    await pool.query(
      `SELECT backend.slug,
            backend.type,
            backend.config,
            backend.namespace_identities,
            backend.is_default,
            (SELECT count(*)::int
               FROM metadata
              WHERE metadata.storage_slug=backend.slug) AS image_count
       FROM storage_backend AS backend
      WHERE backend.slug=$1`,
      [slug]
    )
  ).rows[0] as StorageBackendSnapshotRow | undefined;
  signal?.throwIfAborted();
  if (!row) {
    throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  }
  const [cleanupJobCount, activeIngestionCounts] = await Promise.all([
    countUnresolvedMoveCleanupJobs(slug),
    activeIngestionStorageCounts({ signal })
  ]);
  signal?.throwIfAborted();
  return {
    ...row,
    ingestion_session_count: activeIngestionCounts.get(slug) ?? 0,
    cleanup_job_count: cleanupJobCount
  };
}

/** Fresh configuration only; callers decide whether occupancy is relevant. */
export async function readStorageBackendConfiguration(
  slug: string,
  signal?: AbortSignal
): Promise<StorageBackendConfigRow> {
  signal?.throwIfAborted();
  const row = (
    await pool.query<StorageBackendConfigRow>(
      `SELECT slug, type, config, namespace_identities
       FROM storage_backend WHERE slug=$1`,
      [slug]
    )
  ).rows[0];
  signal?.throwIfAborted();
  if (!row) {
    throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  }
  return row;
}

export async function readStorageBackendUsage(
  slug: string,
  signal?: AbortSignal
): Promise<StorageBackendUsage> {
  signal?.throwIfAborted();
  const [images, cleanupJobCount, ingestionCounts] = await Promise.all([
    pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM metadata WHERE storage_slug=$1",
      [slug]
    ),
    countUnresolvedMoveCleanupJobs(slug),
    activeIngestionStorageCounts({ signal })
  ]);
  signal?.throwIfAborted();
  return {
    image_count: Number(images.rows[0]?.count ?? 0),
    ingestion_session_count: ingestionCounts.get(slug) ?? 0,
    cleanup_job_count: cleanupJobCount
  };
}
