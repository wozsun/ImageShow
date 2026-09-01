import { z } from "zod";
import { isHttpsEndpoint, isHttpsUrl } from "../../core/url-validation.ts";

const httpsEndpoint = z.string().trim().max(2048)
  .refine(isHttpsEndpoint, "endpoint must use HTTPS");
const optionalHttpsUrl = z.string().trim().max(2048)
  .refine((value) => !value || isHttpsUrl(value), "URL must use HTTPS");

const s3SettingsPatchShape = {
  endpoint: httpsEndpoint.optional(),
  region: z.string().trim().optional(),
  bucket: z.string().trim().optional(),
  access_key_id: z.string().trim().optional(),
  secret_access_key: z.string().trim().optional(),
  force_path_style: z.boolean().optional(),
  root_path: z.string().trim()
    .regex(/^\/?(?:[a-zA-Z0-9._-]+\/?)*$/, "root_path must be a simple absolute path")
    .optional(),
  public_base_url: optionalHttpsUrl.optional(),
  connect_timeout_seconds: z.coerce.number().int().min(1).max(120).optional(),
  idle_timeout_seconds: z.coerce.number().int().min(1).max(300).optional(),
  task_timeout_seconds: z.coerce.number().int().min(15).max(3_600).optional()
};

export const s3SettingsPatchSchema = z.strictObject(s3SettingsPatchShape);

const s3SettingsDefaults = {
  endpoint: "",
  region: "auto",
  bucket: "",
  access_key_id: "",
  force_path_style: true,
  root_path: "/",
  public_base_url: "",
  connect_timeout_seconds: 15,
  idle_timeout_seconds: 15,
  task_timeout_seconds: 300
} as const;

const withS3SettingsDefaults = (settings: z.infer<typeof s3SettingsPatchSchema>) => ({
  ...s3SettingsDefaults,
  ...settings
});

export const s3SettingsSchema = s3SettingsPatchSchema.transform(withS3SettingsDefaults);

// Configuration packages are read by the target version. Extra settings from
// another version are ignored, while any invalid current setting rejects only
// that backend entry.
export const looseS3SettingsSchema = z.object({
  ...s3SettingsPatchShape,
  connect_timeout_seconds: z.number().int().min(1).max(120).optional(),
  idle_timeout_seconds: z.number().int().min(1).max(300).optional(),
  task_timeout_seconds: z.number().int().min(15).max(3_600).optional()
})
  .transform(withS3SettingsDefaults);

export type S3Settings = z.infer<typeof s3SettingsSchema>;
export type S3SettingsPatch = z.infer<typeof s3SettingsPatchSchema>;

export function mergeS3Settings(
  patch: S3SettingsPatch = {},
  current?: S3Settings
) {
  return s3SettingsSchema.parse({ ...current, ...patch });
}

type StorageConfigBase = {
  slug: string;
  /** Configured identities proven to be aliases of the current namespace. */
  namespace_identities?: string[];
};

type LocalStorageConfig = StorageConfigBase & {
  type: "local";
};

export type S3StorageConfig = StorageConfigBase & {
  type: "s3";
  s3: S3Settings;
};

export type StorageConfig = LocalStorageConfig | S3StorageConfig;

type StorageBackendRecordFields = {
  display_name: string;
  enabled: boolean;
  is_default: boolean;
};

export type StorageBackendRecord =
  | LocalStorageConfig & StorageBackendRecordFields
  | S3StorageConfig & StorageBackendRecordFields;

export type StorageBackendCreateInput = {
  slug: string;
  display_name: string;
  s3: S3Settings;
};

export type StorageBackendUpdateInput = {
  display_name?: string;
  enabled?: boolean;
  s3?: S3SettingsPatch;
};

export type StorageBackendTestInput = {
  slug?: string;
  s3?: S3SettingsPatch;
};

export type StorageBackendImportInput = {
  slug: string;
  display_name: string;
  enabled: boolean;
  is_default: boolean;
  config: S3Settings;
};

export function storageDriverSignature(config: StorageConfig) {
  if (config.type === "local") return "local";
  const { public_base_url: _publicBaseUrl, ...driverSettings } = config.s3;
  return JSON.stringify(["s3", driverSettings]);
}

export function sameStorageBackendSettings(
  current: StorageConfig,
  candidate: StorageConfig
) {
  if (current.type !== candidate.type) return false;
  if (current.type === "local" || candidate.type === "local") return true;
  return JSON.stringify(current.s3) === JSON.stringify(candidate.s3);
}

export function missingS3Fields(settings: S3Settings): string[] {
  const fields: Array<[string, string | undefined]> = [
    ["endpoint", settings.endpoint],
    ["bucket", settings.bucket],
    ["access_key_id", settings.access_key_id],
    ["secret_access_key", settings.secret_access_key]
  ];
  return fields.filter(([, value]) => !value).map(([key]) => key);
}
