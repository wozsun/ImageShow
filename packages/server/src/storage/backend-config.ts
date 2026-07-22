import { z } from "zod";
import { slugPattern, type StorageType } from "@imageshow/shared";
import { isHttpsEndpoint, isHttpsUrl } from "../core/url-validation.ts";

const httpsEndpoint = z.string().trim().max(2048)
  .refine(isHttpsEndpoint, "endpoint must use HTTPS");
const optionalHttpsUrl = z.string().trim().max(2048)
  .refine((value) => !value || isHttpsUrl(value), "URL must use HTTPS");

export const s3SettingsSchema = z.object({
  endpoint: httpsEndpoint.default(""),
  region: z.string().trim().default("auto"),
  bucket: z.string().trim().default(""),
  access_key_id: z.string().trim().default(""),
  secret_access_key: z.string().trim().optional(),
  force_path_style: z.boolean().default(true),
  root_path: z.string().trim()
    .regex(/^\/?(?:[a-zA-Z0-9._-]+\/?)*$/, "root_path must be a simple absolute path")
    .default("/"),
  public_base_url: optionalHttpsUrl.default("")
});

export const webdavSettingsSchema = z.object({
  base_url: optionalHttpsUrl.default(""),
  username: z.string().trim().default(""),
  password: z.string().trim().optional(),
  root_path: z.string().trim()
    .regex(/^\/?(?:[a-zA-Z0-9._-]+\/?)*$/, "root_path must be a simple absolute path")
    .default("/"),
  public_base_url: optionalHttpsUrl.default(""),
  list_depth_infinity: z.boolean().default(false),
  connect_timeout_seconds: z.coerce.number().int().min(1).max(120).default(15),
  idle_timeout_seconds: z.coerce.number().int().min(1).max(300).default(15),
  task_timeout_seconds: z.coerce.number().int().min(15).max(3_600).default(300)
});

export type S3Settings = z.infer<typeof s3SettingsSchema>;
export type WebdavSettings = z.infer<typeof webdavSettingsSchema>;

export type StorageConfig = {
  slug: string;
  type: StorageType;
  /** Configured identities proven to be aliases of the current namespace. */
  namespace_identities?: string[];
  s3: S3Settings;
  webdav: WebdavSettings;
};

export type StorageBackendRecord = StorageConfig & {
  display_name: string;
  enabled: boolean;
  is_default: boolean;
};

const storageSlugInput = z.string().trim().toLowerCase().min(1).max(32).regex(slugPattern);
const storageDisplayInput = z.string().trim().max(64);

export const storageBackendCreateInput = z.object({
  slug: storageSlugInput,
  display_name: storageDisplayInput.optional().default(""),
  type: z.enum(["s3", "webdav"]).default("s3"),
  s3: s3SettingsSchema.optional().prefault({}),
  webdav: webdavSettingsSchema.optional().prefault({})
});

export const storageBackendUpdateInput = z.object({
  display_name: storageDisplayInput.optional(),
  enabled: z.boolean().optional(),
  s3: s3SettingsSchema.optional(),
  webdav: webdavSettingsSchema.optional()
});

export type StorageBackendCreateInput = z.infer<typeof storageBackendCreateInput>;
export type StorageBackendUpdateInput = z.infer<typeof storageBackendUpdateInput>;

export type StorageBackendImportInput = {
  slug: string;
  display_name: string;
  type: "s3" | "webdav";
  enabled: boolean;
  is_default: boolean;
  config: S3Settings | WebdavSettings;
};

export const defaultS3Settings: S3Settings = Object.freeze(s3SettingsSchema.parse({}));
export const defaultWebdavSettings: WebdavSettings = Object.freeze(webdavSettingsSchema.parse({}));

export function missingS3Fields(settings: S3Settings): string[] {
  const fields: Array<[string, string | undefined]> = [
    ["endpoint", settings.endpoint],
    ["bucket", settings.bucket],
    ["access_key_id", settings.access_key_id],
    ["secret_access_key", settings.secret_access_key]
  ];
  return fields.filter(([, value]) => !value).map(([key]) => key);
}

export function missingWebdavFields(settings: WebdavSettings): string[] {
  return settings.base_url ? [] : ["base_url"];
}

export type { StorageType } from "@imageshow/shared";
