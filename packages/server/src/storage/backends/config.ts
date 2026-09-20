import { z } from "zod";
import { isHttpsEndpoint, isHttpsUrl, hasExplicitSiteDomain, matchesSiteHost } from "../../core/url-validation.ts";
import { ApiError } from "../../core/api-error.ts";

function normalizeLocalPublicUrl(value: string) {
  if (!value) return "";
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || /[\\\\?#]/.test(value)
    || !matchesSiteHost(url.host, "")) throw new Error("Invalid public URL");
  const segments = url.pathname.split("/").filter(Boolean).map((part) => {
    const decoded = decodeURIComponent(part);
    if (decoded === "." || decoded === ".." || /[/\\\\\u0000-\u0020\u007f]/.test(decoded)) {
      throw new Error("Invalid public URL path");
    }
    return encodeURIComponent(decoded);
  });
  return `${url.origin}${segments.length ? `/${segments.join("/")}` : ""}`;
}

export const localPublicUrlSchema = z.string().trim().max(2048).transform((value, ctx) => {
  try { return normalizeLocalPublicUrl(value); } catch {
    ctx.addIssue({ code: "custom", message: "公开地址须为合法 HTTPS 根地址，可包含路径前缀，不能包含凭据、查询参数或片段" });
    return z.NEVER;
  }
});

export const storedLocalConfigSchema = z.object({
  public_base_url: localPublicUrlSchema.optional().default("")
});

export function assertLocalPublicUrlDomain(publicBaseUrl: string, siteDomain: string) {
  if (!publicBaseUrl || !hasExplicitSiteDomain(siteDomain)) return;
  const url = new URL(publicBaseUrl);
  if (matchesSiteHost(url.host, siteDomain)
    || (!url.port && matchesSiteHost(`${url.hostname}:443`, siteDomain))) {
    throw new ApiError(400, "storage_public_url_host_conflict", "本地图片公开地址须使用独立 Host；使用主站地址请将公开 URL 留空");
  }
}

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

// Configuration packages retain recognized settings; an invalid current value
// rejects only that backend entry.
export const looseS3SettingsSchema = z.object({
  ...s3SettingsPatchShape,
  connect_timeout_seconds: z.number().int().min(1).max(120).optional(),
  idle_timeout_seconds: z.number().int().min(1).max(300).optional(),
  task_timeout_seconds: z.number().int().min(15).max(3_600).optional()
})
  .transform(withS3SettingsDefaults);

export type S3Settings = z.infer<typeof s3SettingsSchema>;
export type S3SettingsPatch = z.infer<typeof s3SettingsPatchSchema>;

const s3CapabilitiesSchema = z.strictObject({
  content_md5: z.boolean()
});

export type S3Capabilities = z.infer<typeof s3CapabilitiesSchema>;

/** Server-owned probe results share the backend's persisted configuration. */
export const storedS3ConfigSchema = s3SettingsPatchSchema.extend({
  capabilities: s3CapabilitiesSchema.optional()
}).transform(({ capabilities, ...settings }) => ({
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
  public_base_url?: string;
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
