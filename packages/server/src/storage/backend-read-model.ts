import { pool } from "../core/db.ts";
import { listStorageBackends } from "./backend-registry.ts";
import { listUnresolvedMoveCleanupJobCounts } from "./move-cleanup-repository.ts";

export async function listStorageBackendOptions() {
  return (await listStorageBackends()).map((backend) => ({
    slug: backend.slug,
    display_name: backend.display_name,
    enabled: backend.enabled,
    is_default: backend.is_default
  }));
}

export async function getStorageBackendsForAdmin() {
  const backends = await listStorageBackends();
  const [imageCountRows, importSessionCountRows, cleanupCountRows] =
    await Promise.all([
      pool.query(
        `SELECT storage_slug, count(*)::int AS image_count
           FROM metadata
          GROUP BY storage_slug`
      ),
      pool.query(
        `SELECT storage_slug, count(*)::int AS import_session_count
           FROM import_session
          GROUP BY storage_slug`
      ),
      listUnresolvedMoveCleanupJobCounts()
    ]);
  const imageCounts = new Map<string, number>(
    imageCountRows.rows.map((row) => [
      String(row.storage_slug),
      Number(row.image_count ?? 0)
    ])
  );
  const importSessionCounts = new Map<string, number>(
    importSessionCountRows.rows.map((row) => [
      String(row.storage_slug),
      Number(row.import_session_count ?? 0)
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
      type: backend.type,
      enabled: backend.enabled,
      is_default: backend.is_default,
      image_count: imageCounts.get(backend.slug) ?? 0,
      import_session_count: importSessionCounts.get(backend.slug) ?? 0,
      cleanup_job_count: cleanupCounts?.cleanup_job_count ?? 0,
      failed_cleanup_job_count:
        cleanupCounts?.failed_cleanup_job_count ?? 0,
      exhausted_cleanup_job_count:
        cleanupCounts?.exhausted_cleanup_job_count ?? 0
    };
    if (backend.type === "s3") {
      const { secret_access_key, ...s3 } = backend.s3;
      return {
        ...summary,
        s3: {
          ...s3,
          secret_access_key_configured: Boolean(secret_access_key)
        }
      };
    }
    if (backend.type === "webdav") {
      const { password, ...webdav } = backend.webdav;
      return {
        ...summary,
        webdav: {
          ...webdav,
          password_configured: Boolean(password)
        }
      };
    }
    return summary;
  });
}
