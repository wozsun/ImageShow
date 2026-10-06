import { z } from "zod";
import {
  isHttpsEndpoint,
  publicBaseUrlSchema,
  publicUrlUsesSiteHost
} from "../../core/url-validation.ts";
import { ApiError } from "../../core/api-error.ts";

export const localPublicUrlSchema = publicBaseUrlSchema;

export const storedLocalConfigSchema = z.object({
  public_base_url: localPublicUrlSchema.optional().default("")
});

export function assertLocalPublicUrlDomain(publicBaseUrl: string, siteDomain: string) {
  if (publicUrlUsesSiteHost(publicBaseUrl, siteDomain)) {
    throw new ApiError(
      400,
      "storage_public_url_host_conflict",
      "本地图片公开地址须使用独立 Host；使用主站地址请将公开 URL 留空"
    );
  }
}

// 校验提示直接展示在后台存储后端表单对应字段下方，名称与界面一致。
const httpsEndpoint = z
  .string()
  .trim()
  .max(2048, "Endpoint 不能超过 2048 个字符")
  .refine(isHttpsEndpoint, "Endpoint 须使用 HTTPS");

const timeoutSeconds = (label: string, min: number, max: number) => {
  const message = `${label}须为 ${min}–${max} 之间的整数秒`;
  return z.coerce.number({ error: message }).int(message).min(min, message).max(max, message);
};

const s3SettingsPatchShape = {
  endpoint: httpsEndpoint.optional(),
  region: z.string().trim().optional(),
  bucket: z.string().trim().optional(),
  access_key_id: z.string().trim().optional(),
  secret_access_key: z.string().trim().optional(),
  force_path_style: z.boolean().optional(),
  root_path: z
    .string()
    .trim()
    .regex(/^\/?(?:[a-zA-Z0-9._-]+\/?)*$/, "根目录只能由字母、数字、点、下划线、连字符与 / 组成")
    .optional(),
  public_base_url: publicBaseUrlSchema.optional(),
  connect_timeout_seconds: timeoutSeconds("连接超时", 1, 120).optional(),
  idle_timeout_seconds: timeoutSeconds("流读取空闲超时", 1, 300).optional(),
  task_timeout_seconds: timeoutSeconds("单次任务总超时", 15, 3_600).optional()
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

export type S3Settings = z.infer<typeof s3SettingsSchema>;
export type S3SettingsPatch = z.infer<typeof s3SettingsPatchSchema>;

const s3CapabilitiesSchema = z.strictObject({
  content_md5: z.boolean()
});

export type S3Capabilities = z.infer<typeof s3CapabilitiesSchema>;

/** Server-owned probe results share the backend's persisted configuration. */
export const storedS3ConfigSchema = s3SettingsPatchSchema
  .extend({
    capabilities: s3CapabilitiesSchema.optional()
  })
  .transform(({ capabilities, ...settings }) => ({
    s3: withS3SettingsDefaults(settings),
    ...(capabilities ? { capabilities } : {})
  }));

export function mergeS3Settings(
  patch: S3SettingsPatch = {},
  current?: S3Settings
) {
  return s3SettingsSchema.parse({ ...current, ...patch });
}

type StorageConfigBase = {
  slug: string;
  /** Unpersisted probe configuration; its driver is owned by the probe. */
  temporary?: boolean;
  /** Configured identities proven to be aliases of the current namespace. */
  namespace_identities?: string[];
};

type LocalStorageConfig = StorageConfigBase & {
  type: "local";
  public_base_url?: string;
};

export type S3StorageConfig = StorageConfigBase & {
  type: "s3";
  s3: S3Settings;
  capabilities?: S3Capabilities;
};

export type StorageConfig = LocalStorageConfig | S3StorageConfig;

type StorageBackendRecordFields = {
  sort_order: number;
  display_name: string;
  enabled: boolean;
  is_default: boolean;
};

export type StorageBackendRecord =
  | (LocalStorageConfig & StorageBackendRecordFields)
  | (S3StorageConfig & StorageBackendRecordFields);

export type StorageBackendCreateInput = {
  slug: string;
  display_name: string;
  s3: S3Settings;
};

export type StorageBackendUpdateInput = {
  display_name?: string;
  enabled?: boolean;
  s3?: S3SettingsPatch;
  public_base_url?: string;
};

export type StorageBackendTestInput = {
  slug?: string;
  s3?: S3SettingsPatch;
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
  if (current.type === "local" && candidate.type === "local") {
    return (current.public_base_url ?? "") === (candidate.public_base_url ?? "");
  }
  if (current.type === "local" || candidate.type === "local") return false;
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
