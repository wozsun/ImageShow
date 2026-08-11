import type { S3Settings, StorageBackendAdmin } from "../../../lib/types.js";

const emptyStorageBackendS3Settings: S3Settings = {
  endpoint: "",
  region: "auto",
  bucket: "",
  access_key_id: "",
  force_path_style: true,
  root_path: "/",
  public_base_url: "",
  connect_timeout_seconds: 15,
  idle_timeout_seconds: 15,
  task_timeout_seconds: 300,
  secret_access_key: ""
};

export function storageBackendS3FormSettings(
  backend?: Extract<StorageBackendAdmin, { type: "s3" }>
): S3Settings {
  if (!backend) return { ...emptyStorageBackendS3Settings };
  const {
    secret_access_key_configured: _secretConfigured,
    ...settings
  } = backend.s3;
  return {
    ...emptyStorageBackendS3Settings,
    ...settings,
    secret_access_key: ""
  };
}

export function storageBackendS3AfterSuccessfulSave(settings: S3Settings) {
  return settings.secret_access_key
    ? { ...settings, secret_access_key: "" }
    : settings;
}

export function storageBackendEditConfigPatch(
  backend: Extract<StorageBackendAdmin, { type: "s3" }>,
  settings: S3Settings
) {
  const { secret_access_key, ...visibleSettings } = settings;
  const changed = Object.fromEntries(Object.entries(visibleSettings).filter(
    ([key, value]) => backend.s3[key as keyof typeof visibleSettings] !== value
  ));
  if (secret_access_key) changed.secret_access_key = secret_access_key;
  return Object.keys(changed).length ? { s3: changed } : {};
}
