// Runtime configuration. Resolves in three tiers: environment variables seed
// config.json only on first start; afterwards that file is
// authoritative and updated atomically; storage/S3 config lives in PostgreSQL.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appConfig } from "@imageshow/shared";

// A lowercase DNS label, used for the configurable reserved sub-prefixes.
const subdomainLabel = z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "must be a lowercase DNS label");

const runtimeConfigSchema = z.object({
  site: z.object({
    name: z.string().trim().min(1).default("ImageShow"),
    domain: z.string().trim().min(1).default("example.com"),
    icon_url: z.string().trim().min(1).default("/assets/brand/favicon.svg"),
    root_redirect: z.enum(["home", "gallery"]).default("home"),
    // Absolute base URL of the cookie-isolated object host (e.g.
    // https://static.example.com). File-only; not exposed in the settings UI.
    // Empty falls back to deriving https://<static_subdomain>.<domain>.
    static_base_url: z.string().trim().default(""),
    // Reserved sub-prefixes: <random_subdomain>.<domain> serves the random API,
    // <static_subdomain>.<domain> serves local objects, and <docs_subdomain>.<domain>
    // serves the documentation site (built from packages/docs and bundled into the
    // app). All three are kept off the theme namespace. File-only; not exposed in
    // the settings UI or to the frontend.
    random_subdomain: subdomainLabel.default("random"),
    static_subdomain: subdomainLabel.default("static"),
    docs_subdomain: subdomainLabel.default("docs")
  }).default({}),
  port: z.coerce.number().int().positive().default(5518),
  database: z.object({
    host: z.string().trim().min(1),
    port: z.coerce.number().int().positive().default(5432),
    name: z.string().trim().min(1),
    user: z.string().trim().min(1),
    password: z.string().min(1)
  }),
  redis: z.object({
    host: z.string().trim().min(1).default("redis"),
    port: z.coerce.number().int().positive().default(6379),
    db: z.coerce.number().int().nonnegative().default(0)
  }).default({}),
  home: z.object({
    preview_delay_ms: z.coerce.number().int().min(0).max(30_000).default(1_000)
  }).default({}),
  upload: z.object({
    max_file_size_mb: z.coerce.number().positive().max(200).default(appConfig.uploadDefaultMaxFileSizeMb),
    presign_expires_seconds: z.coerce.number().int().min(60).max(24 * 60 * 60).default(600),
    max_long_edge: z.coerce.number().int().min(512).max(32768).default(appConfig.imageMaxLongEdge),
    list_page_size: z.coerce.number().int().min(5).max(100).default(appConfig.uploadListPageSize),
    // Sign a Content-MD5 header into S3 presigned PUT uploads so the object store
    // verifies integrity in transit and rejects corrupted bytes with BadDigest.
    // File-only (not in the settings UI). Requires the bucket CORS to allow the
    // Content-MD5 request header; set false if a backend can't accept it.
    verify_content_md5: z.boolean().default(true)
  }).default({}),
  admin: z.object({
    image_page_size: z.coerce.number().int().min(10).max(appConfig.pagination.maxLimit).default(appConfig.adminImagePageSize),
    recent_uploads: z.coerce.number().int().min(1).max(50).default(6)
  }).default({}),
  gallery: z.object({
    default_limit: z.coerce.number().int().positive().max(appConfig.pagination.maxLimit).default(appConfig.pagination.defaultLimit)
  }).default({}),
  random: z.object({
    default_method: z.enum(["proxy", "redirect"]).default("redirect")
  }).default({}),
  image_detail: z.object({
    // When on, the image detail dialog's title becomes a link that opens the
    // image's direct object URL in a new tab. File-only (not in the settings UI);
    // set to false in config.json to turn the title link off.
    title_opens_image: z.boolean().default(true)
  }).default({}),
  operation_log: z.object({
    // Max background tasks claimed per worker tick. File-only (not in the settings
    // UI); raise it to drain a large thumb.generate backlog faster after bulk uploads.
    max_tasks_per_tick: z.coerce.number().int().min(1).max(500).default(20)
  }).default({})
});

const optionalEnvString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional()
);

const processEnvSchema = z.object({
  NODE_ENV: z.string().default("development"),
  ADMIN_USERNAME: optionalEnvString,
  ADMIN_PASSWORD: z.preprocess(
    (value) => (typeof value === "string" && value === "" ? undefined : value),
    z.string().min(8).optional()
  )
});

export type RuntimeConfig = z.infer<typeof runtimeConfigSchema>;

const rawEnv = processEnvSchema.parse(process.env);
// Single data root so a deployment only mounts one volume (/app/data in
// production): config.json sits at its root, with storage/ and log/ beneath it.
const dataDir = rawEnv.NODE_ENV === "production" ? "/app/data" : join(process.cwd(), "data");
const configDir = dataDir;
const storageDir = join(dataDir, "storage");
const logDir = join(dataDir, "log");
const configPath = join(dataDir, "config.json");

function envValue(name: string) {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function requiredBootstrapEnv(name: string) {
  const value = envValue(name);
  if (!value) throw new Error(`${name} is required when creating ${configPath} for the first time.`);
  return value;
}

function readExistingConfig(): RuntimeConfig | null {
  if (!existsSync(configPath)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse runtime config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = runtimeConfigSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid runtime config ${configPath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

function initialConfigFromEnvironment() {
  return runtimeConfigSchema.parse({
    site: {
      name: envValue("SITE_NAME"),
      domain: envValue("APP_DOMAIN"),
      icon_url: envValue("SITE_ICON_URL"),
      root_redirect: envValue("ROOT_REDIRECT"),
      static_base_url: envValue("STATIC_BASE_URL"),
      random_subdomain: envValue("RANDOM_SUBDOMAIN"),
      static_subdomain: envValue("STATIC_SUBDOMAIN"),
      docs_subdomain: envValue("DOCS_SUBDOMAIN")
    },
    port: envValue("PORT"),
    database: {
      host: requiredBootstrapEnv("POSTGRES_HOST"),
      port: envValue("POSTGRES_PORT"),
      name: requiredBootstrapEnv("POSTGRES_DB"),
      user: requiredBootstrapEnv("POSTGRES_USER"),
      password: requiredBootstrapEnv("POSTGRES_PASSWORD")
    },
    redis: {
      host: envValue("REDIS_HOST"),
      port: envValue("REDIS_PORT"),
      db: envValue("REDIS_DB")
    },
    home: { preview_delay_ms: envValue("HOME_PREVIEW_DELAY_MS") },
    upload: {
      max_file_size_mb: envValue("UPLOAD_MAX_FILE_SIZE_MB"),
      presign_expires_seconds: envValue("UPLOAD_PRESIGN_EXPIRES_SECONDS"),
      max_long_edge: envValue("UPLOAD_MAX_LONG_EDGE"),
      list_page_size: envValue("UPLOAD_LIST_PAGE_SIZE")
    },
    admin: { image_page_size: envValue("ADMIN_IMAGE_PAGE_SIZE"), recent_uploads: envValue("ADMIN_RECENT_UPLOADS") },
    gallery: { default_limit: envValue("GALLERY_DEFAULT_LIMIT") },
    random: { default_method: envValue("RANDOM_DEFAULT_METHOD") },
    operation_log: { max_tasks_per_tick: envValue("OPERATION_LOG_MAX_TASKS_PER_TICK") }
  });
}

function writeRuntimeConfig(value: RuntimeConfig) {
  mkdirSync(configDir, { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, configPath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function mergeDeep<T extends Record<string, unknown>>(base: T, patch: Partial<T>): T {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const baseValue = result[key];
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      baseValue &&
      typeof baseValue === "object" &&
      !Array.isArray(baseValue)
    ) {
      result[key] = mergeDeep(baseValue as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

const existingConfig = readExistingConfig();
let runtimeConfig: RuntimeConfig;
if (existingConfig) {
  runtimeConfig = existingConfig;
} else {
  runtimeConfig = initialConfigFromEnvironment();
  writeRuntimeConfig(runtimeConfig);
}

export function getRuntimeConfig() {
  return runtimeConfig;
}

export function updateRuntimeConfig(patch: Partial<RuntimeConfig>) {
  const next = runtimeConfigSchema.parse(mergeDeep(runtimeConfig, patch as Record<string, unknown>));
  writeRuntimeConfig(next);
  runtimeConfig = next;
  return runtimeConfig;
}

// Re-reads config.json from disk and replaces the in-memory runtime config, so a
// hand-edited file can be hot-applied without a restart. Connection-level values
// (DB/Redis/port, captured into `env` at startup) still require a restart.
export function reloadRuntimeConfig() {
  const fromDisk = readExistingConfig();
  if (!fromDisk) throw new Error(`Runtime config ${configPath} does not exist`);
  runtimeConfig = fromDisk;
  return runtimeConfig;
}

export const env = {
  NODE_ENV: rawEnv.NODE_ENV,
  ADMIN_USERNAME: rawEnv.ADMIN_USERNAME,
  ADMIN_PASSWORD: rawEnv.ADMIN_PASSWORD,
  CONFIG_DIR: configDir,
  STORAGE_DIR: storageDir,
  LOG_DIR: logDir,
  APP_DOMAIN: runtimeConfig.site.domain,
  PORT: runtimeConfig.port,
  POSTGRES_HOST: runtimeConfig.database.host,
  POSTGRES_PORT: runtimeConfig.database.port,
  POSTGRES_DB: runtimeConfig.database.name,
  POSTGRES_USER: runtimeConfig.database.user,
  POSTGRES_PASSWORD: runtimeConfig.database.password,
  REDIS_HOST: runtimeConfig.redis.host,
  REDIS_PORT: runtimeConfig.redis.port,
  REDIS_DB: runtimeConfig.redis.db
};
