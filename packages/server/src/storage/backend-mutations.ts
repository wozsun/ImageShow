import type { PoolClient } from "pg";
import { ApiError } from "../core/api-error.ts";
import {
  pool,
  withTransaction,
  withTransactionOnClient
} from "../core/db.ts";
import type {
  StorageBackendCreateInput,
  StorageBackendImportInput
} from "./backend-config.ts";
import { storageConfigFromRow } from "./backend-record.ts";
import {
  invalidateStorageBackendRegistry,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";
import {
  readStorageBackendSnapshot,
  storageBackendUsage
} from "./backend-usage.ts";
import { captureStagingNamespaceSnapshot } from "./endpoint-rebind.ts";
import { withStorageLocationWriteAndAdvisoryLock } from "./maintenance-lock.ts";

export async function createStorageBackend(input: StorageBackendCreateInput) {
  if (input.slug === "local") {
    throw new ApiError(
      400,
      "storage_backend_reserved",
      "'local' 是内置后端，不能新建"
    );
  }
  const config = input.type === "webdav" ? input.webdav : input.s3;
  try {
    await pool.query(
      `INSERT INTO storage_backend(
         slug, display_name, type, config, enabled, sort_order
       )
       VALUES(
         $1, $2, $3, $4::jsonb, true,
         (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM storage_backend)
       )`,
      [input.slug, input.display_name, input.type, JSON.stringify(config)]
    ).catch((error: unknown) => {
      if (
        error
        && typeof error === "object"
        && (error as { code?: string }).code === "23505"
      ) {
        throw new ApiError(
          409,
          "storage_backend_exists",
          `存储后端已存在: ${input.slug}`
        );
      }
      throw error;
    });
  } finally {
    // An auto-commit may succeed even if the response is lost.
    invalidateStorageBackendRegistry();
  }
}

export async function importStorageBackends(
  backends: StorageBackendImportInput[],
  beforeCommit: () => void | Promise<void>,
  lockClient: PoolClient,
  onTransactionId: (transactionId: string) => void
) {
  try {
    await withTransactionOnClient(
      lockClient,
      async (client) => {
        const highestSortOrder = Number((await client.query(
          "SELECT COALESCE(MAX(sort_order), 0) AS value FROM storage_backend"
        )).rows[0]?.value ?? 0);

        for (const [index, backend] of backends.entries()) {
          await client.query(
            `INSERT INTO storage_backend(
               slug, display_name, type, config, enabled, is_default,
               sort_order
             )
             VALUES($1, $2, $3, $4::jsonb, $5, false, $6)`,
            [
              backend.slug,
              backend.display_name,
              backend.type,
              JSON.stringify(backend.config),
              backend.enabled,
              highestSortOrder + index + 1
            ]
          );
        }

        const importedDefault = backends.find(
          (backend) => backend.is_default
        );
        if (importedDefault) {
          await client.query(
            `UPDATE storage_backend
                SET is_default=false, updated_at=now()
              WHERE is_default`
          );
          await client.query(
            `UPDATE storage_backend
                SET is_default=true, updated_at=now()
              WHERE slug=$1`,
            [importedDefault.slug]
          );
        }
        await beforeCommit();
      },
      { onTransactionId }
    );
  } catch (error) {
    if (
      error
      && typeof error === "object"
      && (error as { code?: string }).code === "23505"
    ) {
      throw new ApiError(
        409,
        "storage_backend_exists",
        "导入的存储后端 slug 已存在"
      );
    }
    throw error;
  } finally {
    // A successful COMMIT response can be lost with the lock connection.
    invalidateStorageBackendRegistry();
  }
}

export async function deleteStorageBackend(slug: string) {
  if (slug === "local") {
    throw new ApiError(
      400,
      "storage_backend_reserved",
      "'local' 是内置后端，不能删除"
    );
  }
  await withStorageLocationWriteAndAdvisoryLock(
    `imageshow:storage-backend:${slug}`,
    async (signal, lockClient) => {
      signal.throwIfAborted();
      const snapshot = await readStorageBackendSnapshot(slug);
      signal.throwIfAborted();
      if (snapshot.is_default) {
        throw new ApiError(
          400,
          "storage_default_delete",
          "默认后端不能删除，请先切换默认后端"
        );
      }

      const usage = storageBackendUsage(snapshot);
      if (
        !usage.image_count
        && !usage.import_session_count
        && !usage.cleanup_job_count
      ) {
        const config = storageConfigFromRow(snapshot);
        const staging = await captureStagingNamespaceSnapshot(
          resolveStorageAccessForConfig(config).driver
        );
        usage.staging_object_count = staging.keys.size;
        signal.throwIfAborted();
      }
      if (
        usage.image_count
        || usage.import_session_count
        || usage.cleanup_job_count
        || usage.staging_object_count
      ) {
        throw new ApiError(
          409,
          "storage_backend_in_use",
          "该存储后端仍有图片、未清理导入会话、旧对象删除任务或暂存对象，无法删除",
          usage
        );
      }

      signal.throwIfAborted();
      try {
        await withTransactionOnClient(lockClient, async (client) => {
          signal.throwIfAborted();
          const deleted = await client.query(
            `DELETE FROM storage_backend
              WHERE slug=$1 AND NOT is_default
              RETURNING slug`,
            [slug]
          ).catch((error: unknown) => {
            if (
              error
              && typeof error === "object"
              && (error as { code?: string }).code === "23503"
            ) {
              throw new ApiError(
                409,
                "storage_backend_in_use",
                "该存储后端在删除时被新的数据引用，请刷新后重试"
              );
            }
            throw error;
          });
          signal.throwIfAborted();
          if (!deleted.rowCount) {
            throw new ApiError(
              400,
              "storage_default_delete",
              "后端已被设为默认，不能删除；请刷新后重试"
            );
          }
        });
      } finally {
        // The DELETE may commit even if its acknowledgement is lost.
        invalidateStorageBackendRegistry({ retireDrivers: true });
      }
    }
  );
}

export async function setDefaultStorageBackend(slug: string) {
  try {
    await withTransaction(async (client) => {
      const row = (await client.query(
        "SELECT enabled FROM storage_backend WHERE slug=$1 FOR UPDATE",
        [slug]
      )).rows[0];
      if (!row) {
        throw new ApiError(
          404,
          "storage_backend_not_found",
          `Unknown storage backend: ${slug}`
        );
      }
      if (!row.enabled) {
        throw new ApiError(
          400,
          "storage_default_disabled",
          "不能将已停用的后端设为默认"
        );
      }
      await client.query(
        `UPDATE storage_backend
            SET is_default=false, updated_at=now()
          WHERE is_default`
      );
      await client.query(
        `UPDATE storage_backend
            SET is_default=true, updated_at=now()
          WHERE slug=$1`,
        [slug]
      );
    });
  } finally {
    invalidateStorageBackendRegistry();
  }
}

export async function reorderStorageBackends(slugs: string[]) {
  if (!slugs.length) return;
  try {
    await pool.query(
      `UPDATE storage_backend AS backend
          SET sort_order=ordered.ordinality, updated_at=now()
         FROM unnest($1::text[]) WITH ORDINALITY
           AS ordered(slug, ordinality)
        WHERE backend.slug=ordered.slug
          AND backend.slug <> 'local'`,
      [slugs]
    );
  } finally {
    invalidateStorageBackendRegistry();
  }
}
