// Application settings. Storage/S3 config — including the S3 secret key — is
// persisted in PostgreSQL and memoized with a short TTL; all other runtime
// settings come from the file-backed config and are saved separately.
import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import { pool } from "../core/db.js";
import { getRuntimeConfig, reloadRuntimeConfig, updateRuntimeConfig, type RuntimeConfig } from "./env.js";
import { ApiError } from "../core/http.js";

const s3ConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().trim().default(""),
  region: z.string().trim().default("auto"),
  bucket: z.string().trim().default(""),
  access_key_id: z.string().trim().default(""),
  secret_access_key: z.string().trim().optional(),
  force_path_style: z.boolean().default(true),
  root_path: z.string().trim().regex(/^\/?(?:[a-zA-Z0-9._-]+\/?)*$/, "root_path must be a simple absolute path").default("/"),
  public_base_url: z.string().trim().default("")
});

const storageConfigSchema = z.object({
  backend: z.enum(["local", "s3"]).default("local"),
  s3: s3ConfigSchema.default({})
});

const homeConfigSchema = z.object({
  preview_delay_ms: z.coerce.number().int().min(0).max(30_000).default(1_000)
});

const appSettingsSchema = z.object({
  storage: storageConfigSchema.optional(),
  site: z.object({
    name: z.string().trim().min(1).optional(),
    domain: z.string().trim().min(1).optional(),
    icon_url: z.string().trim().min(1).optional(),
    root_redirect: z.enum(["home", "gallery"]).optional()
  }).optional(),
  home: homeConfigSchema.optional(),
  upload: z.object({
    max_file_size_mb: z.coerce.number().positive().max(200).default(appConfig.uploadDefaultMaxFileSizeMb),
    presign_expires_seconds: z.coerce.number().int().min(60).max(24 * 60 * 60).default(600),
    max_long_edge: z.coerce.number().int().min(512).max(32768).default(appConfig.imageMaxLongEdge),
    list_page_size: z.coerce.number().int().min(5).max(100).default(appConfig.uploadListPageSize)
  }).optional(),
  admin: z.object({
    image_page_size: z.coerce.number().int().min(10).max(appConfig.pagination.maxLimit).default(appConfig.adminImagePageSize)
  }).optional(),
  gallery: z.object({
    default_limit: z.coerce.number().int().positive().max(appConfig.pagination.maxLimit).default(appConfig.pagination.defaultLimit)
  }).optional(),
  random: z.object({
    default_method: z.enum(["proxy", "redirect"])
  }).optional()
}).superRefine((value, context) => {
  const includesFileSettings = Boolean(value.site || value.home || value.upload || value.admin || value.gallery || value.random);
  if (value.storage && includesFileSettings) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Storage and application settings must be saved separately"
    });
  }
});

export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type AppSettingsInput = z.infer<typeof appSettingsSchema>;
// Backend an image lives in. storage.backend is the default target for new
// uploads; each image records its own. "webdav" is reserved for a future backend.
export type StorageBackend = "local" | "s3";

const settingsCacheTtlMs = appConfig.folderMapTtlSeconds * 1000;
type LoadedAppSettings = Awaited<ReturnType<typeof loadAppSettingsFromDb>>;
type SettingsLoad = { generation: number; promise: Promise<LoadedAppSettings> };

let settingsCache: LoadedAppSettings | null = null;
let settingsCacheExpiresAt = 0;
let settingsCacheGeneration = 0;
let settingsLoad: SettingsLoad | null = null;

export const defaultStorageConfig: StorageConfig = {
  backend: "local",
  s3: {
    enabled: false,
    endpoint: "",
    region: "auto",
    bucket: "",
    access_key_id: "",
    force_path_style: true,
    root_path: "/",
    public_base_url: ""
  }
};

// Returns the names of the required S3 fields that are still empty, so callers
// can report exactly what is missing before treating the backend as S3-ready.
export function missingS3Fields(s3: StorageConfig["s3"]): string[] {
  const fields: Array<[string, string | undefined]> = [
    ["endpoint", s3.endpoint],
    ["bucket", s3.bucket],
    ["access_key_id", s3.access_key_id],
    ["secret_access_key", s3.secret_access_key]
  ];
  return fields.filter(([, value]) => !value).map(([key]) => key);
}

export function parseSettingsInput(value: unknown) {
  const result = appSettingsSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "validation_error", "Validation failed", result.error.flatten());
  }
  return result.data;
}

// Shared loader: reads storage config from the DB and assembles it with the
// file-backed runtime settings. The S3 credential check is layered on top by the
// validating caller, so both the validated and lenient loaders stay in sync.
async function loadAppSettingsBase() {
  const runtime = getRuntimeConfig();
  const storageRow = (await pool.query("SELECT value FROM app_config WHERE key='storage'")).rows[0];
  const storage = storageConfigSchema.parse({
    ...defaultStorageConfig,
    ...(typeof storageRow?.value === "object" && storageRow.value ? storageRow.value : {})
  });
  return {
    storage,
    site: runtime.site,
    home: homeConfigSchema.parse(runtime.home),
    upload: runtime.upload,
    admin: runtime.admin,
    gallery: runtime.gallery,
    random: runtime.random
  };
}

async function loadAppSettingsFromDb() {
  const settings = await loadAppSettingsBase();
  // Only the default upload backend is strictly validated at load time. Non-default
  // backends (used by individual images) are resolved on demand; missing credentials
  // simply make those images unavailable rather than breaking the whole instance.
  if (settings.storage.backend === "s3") {
    const missing = missingS3Fields(settings.storage.s3);
    if (missing.length) throw new ApiError(503, "storage_config_incomplete", "Storage config incomplete", { missing });
  }
  return settings;
}

// S3 settings come from PostgreSQL while all ordinary runtime settings come
// from the file-backed config loaded at process startup.
export async function getAppSettings() {
  if (settingsCache && Date.now() < settingsCacheExpiresAt) return settingsCache;
  const generation = settingsCacheGeneration;
  if (!settingsLoad || settingsLoad.generation !== generation) {
    settingsLoad = { generation, promise: loadAppSettingsFromDb() };
  }
  const currentLoad = settingsLoad;
  try {
    const loaded = await currentLoad.promise;
    if (settingsCacheGeneration === generation) {
      settingsCache = loaded;
      settingsCacheExpiresAt = Date.now() + settingsCacheTtlMs;
    }
    return loaded;
  } finally {
    if (settingsLoad === currentLoad) settingsLoad = null;
  }
}

function invalidateSettingsCache() {
  settingsCacheGeneration += 1;
  settingsCache = null;
  settingsCacheExpiresAt = 0;
}

// Hot-reloads the file-backed runtime config from disk and drops the settings
// cache so the next read reflects a hand-edited config.json.
export function reloadAppConfig() {
  reloadRuntimeConfig();
  invalidateSettingsCache();
}

export async function getStorageConfig() {
  return (await getAppSettings()).storage;
}

export async function getUploadLimitBytes() {
  return Math.floor(getRuntimeConfig().upload.max_file_size_mb * 1024 * 1024);
}

export async function getImageMaxLongEdge() {
  return Math.floor(getRuntimeConfig().upload.max_long_edge);
}

export async function getPresignExpiresSeconds() {
  return Math.max(60, Math.min(24 * 60 * 60, Math.floor(getRuntimeConfig().upload.presign_expires_seconds)));
}

export async function getSettingsForAdmin() {
  const settings = await getAppSettings().catch((error) => {
    if (error instanceof ApiError && error.code === "storage_config_incomplete") {
      return loadSettingsWithoutValidation();
    }
    throw error;
  });
  // Strip the file-only site fields (static_base_url + reserved subdomain labels)
  // so they never reach the admin frontend; saving merges the rest back untouched.
  const { name, domain, icon_url, root_redirect } = settings.site;
  return {
    ...settings,
    site: { name, domain, icon_url, root_redirect },
    storage: {
      ...settings.storage,
      s3: {
        ...settings.storage.s3,
        secret_access_key: undefined,
        secret_access_key_configured: Boolean(settings.storage.s3.secret_access_key)
      }
    }
  };
}

async function loadSettingsWithoutValidation() {
  return loadAppSettingsBase();
}

export async function resolveStorageConfigForTest(input?: AppSettingsInput["storage"]) {
  const current = await getAppSettings().then((settings) => settings.storage).catch(async () => (await loadSettingsWithoutValidation()).storage);
  if (!input) return current;
  const next = storageConfigSchema.parse(input);
  if (!next.s3.secret_access_key) next.s3.secret_access_key = current.s3.secret_access_key;
  if (!next.s3.enabled) next.backend = "local";
  return next;
}

export async function saveAppSettings(input: AppSettingsInput) {
  const runtimePatch: Partial<RuntimeConfig> = {};
  if (input.site) runtimePatch.site = input.site as RuntimeConfig["site"];
  if (input.home) runtimePatch.home = input.home;
  // upload omits the file-only verify_content_md5 flag; mergeDeep keeps it.
  if (input.upload) runtimePatch.upload = input.upload as RuntimeConfig["upload"];
  if (input.admin) runtimePatch.admin = input.admin as RuntimeConfig["admin"];
  if (input.gallery) runtimePatch.gallery = input.gallery;
  if (input.random) runtimePatch.random = input.random;
  if (!input.storage) {
    if (Object.keys(runtimePatch).length) updateRuntimeConfig(runtimePatch);
    invalidateSettingsCache();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const storage = storageConfigSchema.parse(input.storage);
    // The secret is stored in plaintext alongside the other S3 fields and is never
    // returned to the client. The admin UI never receives it, so an empty incoming
    // value means "keep the existing secret" rather than clearing it.
    if (!storage.s3.secret_access_key) {
      const currentRow = (await client.query("SELECT value FROM app_config WHERE key='storage'")).rows[0];
      const current = storageConfigSchema.parse({
        ...defaultStorageConfig,
        ...(typeof currentRow?.value === "object" && currentRow.value ? currentRow.value : {})
      });
      storage.s3.secret_access_key = current.s3.secret_access_key;
    }
    await client.query(
      "INSERT INTO app_config(key, value) VALUES('storage',$1::jsonb) ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=now()",
      [JSON.stringify(storage)]
    );
    await client.query("COMMIT");
    invalidateSettingsCache();
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
