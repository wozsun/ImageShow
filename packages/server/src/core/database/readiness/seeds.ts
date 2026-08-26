import type { DatabaseReader } from "./contract.ts";

export async function assertRequiredSeedRows(database: DatabaseReader) {
  const row = (await database.query<{
    revision_ready: boolean;
    local_storage_ready: boolean;
    none_theme_ready: boolean;
    unsupported_storage_types: string[];
  }>(
    `SELECT (
              SELECT count(*)=1
                 AND bool_and(singleton=1 AND revision >= 0)
                FROM ready_image_revision
            ) AS revision_ready,
            EXISTS (
              SELECT 1 FROM storage_backend
               WHERE slug='local' AND type='local'
            ) AS local_storage_ready,
            EXISTS (
              SELECT 1 FROM theme WHERE slug='none'
            ) AS none_theme_ready,
            ARRAY(
              SELECT DISTINCT type
                FROM storage_backend
               WHERE type NOT IN ('local', 's3')
               ORDER BY type
            ) AS unsupported_storage_types`
  )).rows[0];
  const missing = [
    !row?.revision_ready && "ready_image_revision singleton",
    !row?.local_storage_ready && "storage_backend.local",
    !row?.none_theme_ready && "theme.none"
  ].filter((value): value is string => Boolean(value));
  if (missing.length) {
    throw new Error(
      `required seed rows are missing or invalid: ${missing.join(", ")}`
    );
  }
  if (row.unsupported_storage_types.length) {
    throw new Error(
      `unsupported storage backend types: ${row.unsupported_storage_types.join(", ")}`
    );
  }
}
