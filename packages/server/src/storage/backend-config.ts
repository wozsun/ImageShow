import { z } from "zod";
import {
  slugMaxLength,
  slugPattern,
  type StorageType
} from "@imageshow/shared/browser";
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
  public_base_url: optionalHttpsUrl.default(""),
  connect_timeout_seconds: z.coerce.number().int().min(1).max(120).default(15),
  idle_timeout_seconds: z.coerce.number().int().min(1).max(300).default(15),
  task_timeout_seconds: z.coerce.number().int().min(15).max(3_600).default(300)
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

export type WebdavStorageConfig = StorageConfigBase & {
  type: "webdav";
  webdav: WebdavSettings;
};

export type StorageConfigByType = {
  [Type in StorageType]: Type extends "local"
    ? LocalStorageConfig
    : Type extends "s3"
      ? S3StorageConfig
      : Type extends "webdav"
        ? WebdavStorageConfig
        : never;
};

export type StorageConfig = StorageConfigByType[StorageType];

type StorageBackendRecordFields = {
  display_name: string;
  enabled: boolean;
  is_default: boolean;
};

export type StorageBackendRecord = {
  [Type in StorageType]: StorageConfigByType[Type] & StorageBackendRecordFields;
}[StorageType];

const storageSlugInput = z.string().trim().toLowerCase().min(1)
  .max(slugMaxLength).regex(slugPattern);
const storageDisplayInput = z.string().trim().max(64);

const strictS3SettingsSchema = s3SettingsSchema.strict();
const strictWebdavSettingsSchema = webdavSettingsSchema.strict();
const nonEmptySettingsObject = z.record(z.string(), z.unknown()).refine(
  (value) => Object.keys(value).length > 0,
  "远端存储配置至少需要提供一个字段"
);
const s3SettingsUpdateSchema = nonEmptySettingsObject.pipe(
  strictS3SettingsSchema
);
const webdavSettingsUpdateSchema = nonEmptySettingsObject.pipe(
  strictWebdavSettingsSchema
);

export const storageBackendCreateInput = z.strictObject({
  slug: storageSlugInput,
  display_name: storageDisplayInput.optional().default(""),
  type: z.enum(["s3", "webdav"]).default("s3"),
  s3: strictS3SettingsSchema.optional().prefault({}),
  webdav: strictWebdavSettingsSchema.optional().prefault({})
});

export const storageBackendUpdateInput = z.strictObject({
  display_name: storageDisplayInput.optional(),
  enabled: z.boolean().optional(),
  s3: s3SettingsUpdateSchema.optional(),
  webdav: webdavSettingsUpdateSchema.optional()
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  "存储后端更新至少需要提供一个字段"
);

export const storageBackendTestInput = z.strictObject({
  slug: storageSlugInput.optional(),
  type: z.enum(["local", "s3", "webdav"]).optional(),
  s3: strictS3SettingsSchema.optional(),
  webdav: strictWebdavSettingsSchema.optional()
}).refine(
  (value) => Object.values(value).some((field) => field !== undefined),
  "存储测试至少需要提供一个配置字段"
);

export type StorageBackendCreateInput = z.infer<typeof storageBackendCreateInput>;
export type StorageBackendUpdateInput = z.infer<typeof storageBackendUpdateInput>;
export type StorageBackendTestInput = z.infer<typeof storageBackendTestInput>;

export type StorageBackendImportInput = {
  slug: string;
  display_name: string;
  type: "s3" | "webdav";
  enabled: boolean;
  is_default: boolean;
  config: S3Settings | WebdavSettings;
};

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
