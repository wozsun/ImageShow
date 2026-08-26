import { pool } from "../../core/database/pools.ts";
import type {
  StorageBackendAdminDto,
  StorageBackendOptionDto
} from "@imageshow/shared/browser";
import { listStorageBackends } from "./registry.ts";
import { listUnresolvedMoveCleanupJobCounts } from "../cleanup/repository.ts";
import { resolveStorageBackendDeletionState } from "./deletion.ts";
import { activeIngestionStorageCounts } from "../../images/ingestion/cleanup/storage-references.ts";

export async function listStorageBackendOptions(): Promise<
  StorageBackendOptionDto[]
> {
  return (await listStorageBackends()).map((backend) => ({
    slug: backend.slug,
    display_name: backend.display_name,
    enabled: backend.enabled,
    is_default: backend.is_default
  }));
}

export async function getStorageBackendsForAdmin(): Promise<
  StorageBackendAdminDto[]
> {
  const backends = await listStorageBackends();
  const [imageCountRows, ingestionSessionCounts, cleanupCountRows] =
    await Promise.all([
      pool.query(
        `SELECT storage_slug, count(*)::int AS image_count
           FROM metadata
          GROUP BY storage_slug`
      ),
      activeIngestionStorageCounts(),
      listUnresolvedMoveCleanupJobCounts()
    ]);
  const imageCounts = new Map<string, number>(
    imageCountRows.rows.map((row) => [
      String(row.storage_slug),
      Number(row.image_count ?? 0)
    ])
  );
  const cleanupJobCounts = new Map(
    cleanupCountRows.map((row) => [row.storage_slug, row])
  );
  return backends.map((backend) => {
    const cleanupCounts = cleanupJobCounts.get(backend.slug);
    const summary = {
      slug: backend.slug,
      display_name: backend.display_name,
      enabled: backend.enabled,
      is_default: backend.is_default,
      image_count: imageCounts.get(backend.slug) ?? 0,
      ingestion_session_count: ingestionSessionCounts.get(backend.slug) ?? 0,
      cleanup_job_count: cleanupCounts?.cleanup_job_count ?? 0,
      failed_cleanup_job_count:
        cleanupCounts?.failed_cleanup_job_count ?? 0,
      exhausted_cleanup_job_count:
        cleanupCounts?.exhausted_cleanup_job_count ?? 0
    };
    const deletion = resolveStorageBackendDeletionState(summary);
    if (backend.type === "s3") {
      const { secret_access_key, ...s3 } = backend.s3;
      return {
        ...summary,
        type: "s3" as const,
        deletion,
        s3: {
          ...s3,
          secret_access_key_configured: Boolean(secret_access_key)
        }
      };
    }
    return { ...summary, type: "local" as const, deletion };
  });
}
