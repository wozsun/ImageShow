import { ApiError } from "../../core/api-error.ts";
import {
  runWithAdvisoryLockAcquisitionSignal,
  withAdvisoryLock
} from "../../core/database/advisory-locks.ts";
import { withTransactionOnClient } from "../../core/database/transactions.ts";
import {
  storageDriverSignature,
  type S3Capabilities,
  type S3StorageConfig,
  type StorageConfig
} from "./config.ts";
import { validateStorageBackendCandidate } from "./probe.ts";
import { storageConfigFromRow, type StorageBackendConfigRow } from "./record.ts";
import {
  invalidateStorageBackendRegistry,
  resolveStorageAccess
} from "./registry.ts";

async function saveProbedCapabilities(
  config: S3StorageConfig,
  capabilities: S3Capabilities,
  signal?: AbortSignal
) {
  const save = () => withAdvisoryLock(
    `imageshow:storage-backend:${config.slug}`,
    async (lockSignal, client) => {
      const combinedSignal = signal
        ? AbortSignal.any([signal, lockSignal])
        : lockSignal;
      try {
        await withTransactionOnClient(client, async () => {
          combinedSignal.throwIfAborted();
          const row = (await client.query<StorageBackendConfigRow>(
            `SELECT slug, type, config FROM storage_backend
              WHERE slug=$1 FOR UPDATE`,
            [config.slug]
          )).rows[0];
          if (
            !row
            || storageDriverSignature(storageConfigFromRow(row))
              !== storageDriverSignature(config)
          ) {
            throw new ApiError(
              409,
              "storage_backend_changed",
              "存储后端配置已被其他请求修改，请刷新后重试"
            );
          }
          combinedSignal.throwIfAborted();
          await client.query(
            `UPDATE storage_backend
                SET config=jsonb_set(config, '{capabilities}', $2::jsonb),
                    updated_at=now()
              WHERE slug=$1`,
            [config.slug, JSON.stringify(capabilities)]
          );
          combinedSignal.throwIfAborted();
        });
      } finally {
        // A committed capability update can outlive its acknowledgement.
        invalidateStorageBackendRegistry();
      }
    }
  );
  await (signal ? runWithAdvisoryLockAcquisitionSignal(signal, save) : save());
}

export async function testStorageBackend(
  config?: StorageConfig,
  signal?: AbortSignal
) {
  signal?.throwIfAborted();
  const effective = config ?? (await resolveStorageAccess()).config;
  const result = await validateStorageBackendCandidate(
    effective, undefined, undefined, signal
  );
  if (
    effective.type === "s3"
    && effective.slug !== "(test)"
    && result.capabilities
  ) {
    await saveProbedCapabilities(effective, result.capabilities, signal);
  }
  return result;
}
