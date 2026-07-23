import type { PoolClient } from "pg";
import { ApiError, errorMessage } from "../core/api-error.ts";
import {
  inspectTransactionOutcome,
  pool,
  withAdvisoryLock,
  withTransactionOnClient
} from "../core/db.ts";
import {
  s3SettingsSchema,
  webdavSettingsSchema,
  type StorageBackendUpdateInput,
  type StorageConfig
} from "./backend-config.ts";
import {
  normalizedNamespaceIdentities,
  storageConfigFromRow,
  withStoredS3Credential,
  withStoredWebdavCredential,
  type StorageBackendConfigRow
} from "./backend-record.ts";
import {
  invalidateStorageBackendRegistry,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";
import {
  assertPhysicalLocationChangeAllowed,
  readStorageBackendSnapshot,
  storageBackendUsage,
  type StorageBackendSnapshot
} from "./backend-usage.ts";
import {
  validateStorageBackendCandidate,
  type ExistingStorageProbe
} from "./backend-probe.ts";
import {
  captureStagingNamespaceSnapshot,
  type StagingNamespaceSnapshot
} from "./endpoint-rebind.ts";
import {
  withStorageLocationWriteAndAdvisoryLock
} from "./maintenance-lock.ts";
import {
  configuredStorageNamespaceIdentity,
  shareStorageNamespace,
  storageNamespaceIdentities,
  storageNamespaceLayoutIdentity
} from "./storage-namespace.ts";

function updatedStorageConfig(
  current: StorageConfig,
  input: StorageBackendUpdateInput
): StorageConfig {
  if (current.type === "s3") {
    if (input.webdav) {
      throw new ApiError(
        400,
        "storage_backend_type_mismatch",
        "S3 后端不能接收 WebDAV 配置"
      );
    }
    return input.s3
      ? {
          ...current,
          s3: withStoredS3Credential(
            s3SettingsSchema.parse(input.s3),
            current.s3
          )
        }
      : current;
  }
  if (current.type === "webdav") {
    if (input.s3) {
      throw new ApiError(
        400,
        "storage_backend_type_mismatch",
        "WebDAV 后端不能接收 S3 配置"
      );
    }
    return input.webdav
      ? {
          ...current,
          webdav: withStoredWebdavCredential(
            webdavSettingsSchema.parse(input.webdav),
            current.webdav
          )
        }
      : current;
  }
  if (input.s3 || input.webdav) {
    throw new ApiError(
      400,
      "storage_backend_reserved",
      "内置本地后端没有可编辑的远程存储配置"
    );
  }
  return current;
}

function changedPhysicalLocationFields(
  current: StorageConfig,
  next: StorageConfig
) {
  const currentSettings = current.type === "s3"
    ? current.s3
    : current.webdav;
  const nextSettings = next.type === "s3" ? next.s3 : next.webdav;
  const fields = current.type === "s3"
    ? ["endpoint", "bucket", "root_path"] as const
    : current.type === "webdav"
      ? ["base_url", "root_path"] as const
      : [];
  const currentRecord = currentSettings as unknown as Record<string, unknown>;
  const nextRecord = nextSettings as unknown as Record<string, unknown>;
  return fields.filter(
    (field) => currentRecord[field] !== nextRecord[field]
  );
}

type StorageUpdateReceipt = { transactionId: string | null };
type StorageNamespaceRow = StorageBackendConfigRow;

function namespaceSetsOverlap(
  first: ReadonlySet<string>,
  second: ReadonlySet<string>
) {
  return [...first].some((identity) => second.has(identity));
}

function mergedStorageNamespaceComponent(
  rows: readonly StorageNamespaceRow[],
  current: StorageConfig,
  candidate: StorageConfig
) {
  const identities = new Set([
    ...storageNamespaceIdentities(current),
    ...storageNamespaceIdentities(candidate)
  ]);
  const slugs = new Set([current.slug]);
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const row of rows) {
      if (slugs.has(row.slug)) continue;
      const rowIdentities = storageNamespaceIdentities(
        storageConfigFromRow(row)
      );
      if (!namespaceSetsOverlap(identities, rowIdentities)) continue;
      slugs.add(row.slug);
      for (const identity of rowIdentities) {
        if (!identities.has(identity)) expanded = true;
        identities.add(identity);
      }
    }
  }
  return {
    identities: [...identities].sort(),
    slugs: [...slugs].sort()
  };
}

async function hasRegisteredNamespacePeer(
  client: PoolClient,
  current: StorageConfig
) {
  const rows = (await client.query(
    `SELECT slug, type, config, namespace_identities
       FROM storage_backend
      WHERE slug <> $1`,
    [current.slug]
  )).rows as StorageNamespaceRow[];
  return rows.some((row) => shareStorageNamespace(
    current,
    storageConfigFromRow(row)
  ));
}

function sameStorageBackendConfig(
  snapshot: StorageBackendSnapshot,
  locked: StorageBackendConfigRow
) {
  if (
    locked.type !== snapshot.type
    || JSON.stringify(
      normalizedNamespaceIdentities(locked.namespace_identities)
    ) !== JSON.stringify(
      normalizedNamespaceIdentities(snapshot.namespace_identities)
    )
  ) {
    return false;
  }
  const snapshotConfig = storageConfigFromRow(snapshot);
  const lockedConfig = storageConfigFromRow(locked);
  if (snapshotConfig.type === "s3" && lockedConfig.type === "s3") {
    return JSON.stringify(snapshotConfig.s3)
      === JSON.stringify(lockedConfig.s3);
  }
  if (
    snapshotConfig.type === "webdav"
    && lockedConfig.type === "webdav"
  ) {
    return JSON.stringify(snapshotConfig.webdav)
      === JSON.stringify(lockedConfig.webdav);
  }
  return snapshotConfig.type === lockedConfig.type;
}

async function updateStorageBackendUnderLock(
  slug: string,
  input: StorageBackendUpdateInput,
  signal: AbortSignal,
  lockClient: PoolClient,
  receipt: StorageUpdateReceipt
) {
  signal.throwIfAborted();
  const snapshot = await readStorageBackendSnapshot(slug);
  signal.throwIfAborted();
  const currentConfig = storageConfigFromRow(snapshot);
  const nextConfig = updatedStorageConfig(currentConfig, input);
  const configChanged = currentConfig.type === "s3"
    ? JSON.stringify(currentConfig.s3) !== JSON.stringify(nextConfig.s3)
    : currentConfig.type === "webdav"
      ? JSON.stringify(currentConfig.webdav)
        !== JSON.stringify(nextConfig.webdav)
      : false;
  const configuredNamespaceChanged =
    configuredStorageNamespaceIdentity(currentConfig)
    !== configuredStorageNamespaceIdentity(nextConfig);
  const layoutChanged = storageNamespaceLayoutIdentity(currentConfig)
    !== storageNamespaceLayoutIdentity(nextConfig);
  const endpointRebindCandidate = currentConfig.type === "s3"
    && nextConfig.type === "s3"
    && configuredNamespaceChanged
    && !layoutChanged;

  const changedFields = configuredNamespaceChanged
    ? changedPhysicalLocationFields(currentConfig, nextConfig)
    : [];
  const snapshotUsage = storageBackendUsage(snapshot);
  let currentStaging: StagingNamespaceSnapshot | undefined;
  let verifiedEndpointRebind = false;
  if (configuredNamespaceChanged) {
    if (!endpointRebindCandidate) {
      assertPhysicalLocationChangeAllowed(changedFields, snapshotUsage);
    }
    currentStaging = await captureStagingNamespaceSnapshot(
      resolveStorageAccessForConfig(currentConfig).driver
    );
    snapshotUsage.staging_object_count = currentStaging.keys.size;
    signal.throwIfAborted();
    if (endpointRebindCandidate) {
      verifiedEndpointRebind = Boolean(
        snapshotUsage.image_count
        || snapshotUsage.import_session_count
        || snapshotUsage.cleanup_job_count
        || snapshotUsage.staging_object_count
      );
      if (
        !verifiedEndpointRebind
        && (
          normalizedNamespaceIdentities(
            snapshot.namespace_identities
          ).length
          || await hasRegisteredNamespacePeer(lockClient, currentConfig)
        )
      ) {
        verifiedEndpointRebind = true;
      }
    } else {
      assertPhysicalLocationChangeAllowed(changedFields, snapshotUsage);
    }
  }

  const existingObject = snapshotUsage.image_count > 0
    ? (await pool.query(
        `SELECT id, object_key, storage_slug
           FROM metadata
          WHERE storage_slug=$1
          ORDER BY id
          LIMIT 1`,
        [slug]
      )).rows[0] as ExistingStorageProbe | undefined
    : undefined;
  signal.throwIfAborted();
  if (configChanged) {
    await validateStorageBackendCandidate(
      nextConfig,
      existingObject,
      verifiedEndpointRebind && currentStaging
        ? { currentConfig, currentStaging }
        : undefined
    );
    signal.throwIfAborted();
  }

  let nextNamespaceIdentities = normalizedNamespaceIdentities(
    snapshot.namespace_identities
  );
  if (configuredNamespaceChanged && !verifiedEndpointRebind) {
    nextNamespaceIdentities = [];
  }

  try {
    await withTransactionOnClient(
      lockClient,
      async (client) => {
        signal.throwIfAborted();
        const row = (await client.query(
          `SELECT slug, type, config, namespace_identities, is_default
             FROM storage_backend
            WHERE slug=$1
            FOR UPDATE`,
          [slug]
        )).rows[0];
        signal.throwIfAborted();
        if (!row) {
          throw new ApiError(
            404,
            "storage_backend_not_found",
            `Unknown storage backend: ${slug}`
          );
        }
        if (!sameStorageBackendConfig(snapshot, row)) {
          throw new ApiError(
            409,
            "storage_backend_changed",
            "存储后端配置已被其他请求修改，请刷新后重试"
          );
        }
        if (input.enabled === false && row.is_default) {
          throw new ApiError(
            400,
            "storage_default_enabled",
            "默认后端不能停用，请先切换默认后端"
          );
        }
        if (input.enabled === false && row.slug === "local") {
          const alternativeDefault = await client.query(
            `SELECT 1
               FROM storage_backend
              WHERE slug <> 'local' AND enabled AND is_default
              LIMIT 1`
          );
          if (!alternativeDefault.rowCount) {
            throw new ApiError(
              400,
              "storage_local_requires_alternative",
              "停用本地存储前，请先启用其他存储并将其设为默认后端"
            );
          }
        }

        if (verifiedEndpointRebind) {
          const namespaceRows = (await client.query(
            `SELECT slug, type, config, namespace_identities
               FROM storage_backend
              FOR UPDATE`
          )).rows as StorageNamespaceRow[];
          const component = mergedStorageNamespaceComponent(
            namespaceRows,
            currentConfig,
            nextConfig
          );
          nextNamespaceIdentities = component.identities;
          await client.query(
            `UPDATE storage_backend
                SET namespace_identities=$2::text[]
              WHERE slug = ANY($1::text[])`,
            [component.slugs, component.identities]
          );
        }

        const configJson = !configChanged
          ? null
          : nextConfig.type === "s3"
            ? JSON.stringify(nextConfig.s3)
            : nextConfig.type === "webdav"
              ? JSON.stringify(nextConfig.webdav)
              : null;
        await client.query(
          `UPDATE storage_backend
              SET display_name=COALESCE($2, display_name),
                  enabled=COALESCE($3, enabled),
                  config=COALESCE($4::jsonb, config),
                  namespace_identities=$5::text[],
                  updated_at=now()
            WHERE slug=$1`,
          [
            slug,
            input.display_name ?? null,
            input.enabled ?? null,
            configJson,
            nextNamespaceIdentities
          ]
        );
        signal.throwIfAborted();
      },
      {
        onTransactionId: (transactionId) => {
          receipt.transactionId = transactionId;
        }
      }
    );
  } finally {
    // COMMIT acknowledgement can be lost together with the lock connection.
    invalidateStorageBackendRegistry({ retireDrivers: configChanged });
  }
}

async function settleStorageBackendUpdate(
  work: (receipt: StorageUpdateReceipt) => Promise<void>
) {
  const receipt: StorageUpdateReceipt = { transactionId: null };
  try {
    await work(receipt);
  } catch (error) {
    if (!receipt.transactionId) throw error;
    const outcome = await inspectTransactionOutcome(receipt.transactionId)
      .catch(() => "unknown" as const);
    if (outcome === "committed") return;
    if (outcome === "rolled_back") throw error;
    throw new ApiError(
      503,
      "storage_update_outcome_unknown",
      "存储配置事务结果暂时无法确认，请刷新后核对当前配置",
      {
        transaction_id: receipt.transactionId,
        original_error: errorMessage(error)
      }
    );
  }
}

export async function updateStorageBackend(
  slug: string,
  input: StorageBackendUpdateInput
) {
  const backendLockKey = `imageshow:storage-backend:${slug}`;
  const updateWithBackendLock = () =>
    settleStorageBackendUpdate((receipt) =>
      withAdvisoryLock(backendLockKey, (signal, lockClient) =>
        updateStorageBackendUnderLock(
          slug,
          input,
          signal,
          lockClient,
          receipt
        )
      )
    );

  if (!input.s3 && !input.webdav) {
    await updateWithBackendLock();
    return;
  }

  // Any driver-affecting setting changes how subsequent object calls connect.
  // Exclude active readers before retiring the old driver so a multi-request
  // operation cannot be interrupted halfway through by a harmless config edit.
  await settleStorageBackendUpdate((receipt) =>
    withStorageLocationWriteAndAdvisoryLock(
      backendLockKey,
      (signal, lockClient) => updateStorageBackendUnderLock(
        slug,
        input,
        signal,
        lockClient,
        receipt
      )
    )
  );
}
