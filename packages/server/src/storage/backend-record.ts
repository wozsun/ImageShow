import type { StorageType } from "@imageshow/shared/browser";
import {
  s3SettingsSchema,
  webdavSettingsSchema,
  type S3Settings,
  type StorageBackendRecord,
  type StorageConfig,
  type WebdavSettings
} from "./backend-config.ts";

export type StorageBackendConfigRow = {
  slug: string;
  type: StorageType;
  config: unknown;
  namespace_identities?: unknown;
};

export function normalizedNamespaceIdentities(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((identity) => String(identity).trim())
    .filter(Boolean))].sort();
}

export function storageConfigFromRow(
  row: StorageBackendConfigRow
): StorageConfig {
  const raw = typeof row.config === "object" && row.config ? row.config : {};
  const namespaceIdentities = normalizedNamespaceIdentities(
    row.namespace_identities
  );
  if (row.type === "s3") {
    return {
      slug: row.slug,
      type: "s3",
      namespace_identities: namespaceIdentities,
      s3: s3SettingsSchema.parse(raw)
    };
  }
  if (row.type === "webdav") {
    return {
      slug: row.slug,
      type: "webdav",
      namespace_identities: namespaceIdentities,
      webdav: webdavSettingsSchema.parse(raw)
    };
  }
  return {
    slug: row.slug,
    type: "local",
    namespace_identities: namespaceIdentities
  };
}

export function storageBackendRecordFromRow(
  row: StorageBackendConfigRow & {
    display_name: string;
    enabled: unknown;
    is_default: unknown;
  }
): StorageBackendRecord {
  return {
    ...storageConfigFromRow(row),
    display_name: row.display_name,
    enabled: Boolean(row.enabled),
    is_default: Boolean(row.is_default)
  };
}

export function storageConfigFromRecord(
  record: StorageBackendRecord
): StorageConfig {
  const {
    display_name: _displayName,
    enabled: _enabled,
    is_default: _isDefault,
    ...config
  } = record;
  return config;
}

export function withStoredS3Credential(
  candidate: S3Settings,
  current?: S3Settings
) {
  if (candidate.secret_access_key || !current?.secret_access_key) {
    return candidate;
  }
  return { ...candidate, secret_access_key: current.secret_access_key };
}

export function withStoredWebdavCredential(
  candidate: WebdavSettings,
  current?: WebdavSettings
) {
  if (candidate.password || !current?.password) return candidate;
  return { ...candidate, password: current.password };
}
