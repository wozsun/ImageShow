import {
  s3SettingsSchema,
  type StorageBackendRecord,
  type StorageConfig
} from "./config.ts";

export type StorageBackendConfigRow = {
  slug: string;
  type: string;
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
  switch (row.type) {
    case "s3":
      return {
        slug: row.slug,
        type: "s3",
        namespace_identities: namespaceIdentities,
        s3: s3SettingsSchema.parse(raw)
      };
    case "local":
      return {
        slug: row.slug,
        type: "local",
        namespace_identities: namespaceIdentities
      };
    default:
      throw new Error(`Unsupported storage backend type: ${row.type}`);
  }
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
