// Runtime configuration. Resolves in three tiers: environment variables seed
// config.json only on first start; afterwards that file is
// authoritative and updated atomically; storage/S3 config lives in PostgreSQL.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import { captchaCodeLength, captchaNoiseDots, captchaNoiseLines, captchaTtlSeconds, galleryLimit, galleryOrder, imagePageSize, listPageSize, logLevel, logMaxFiles, logMaxSizeMb, loginFailureWindowSeconds, loginGlobalMaxAttempts, loginGlobalWindowSeconds, loginMaxFailures, maxFileSizeMb, maxLongEdge, previewDelayMs, randomMethod, recentUploads, rootRedirect, sessionTtlSeconds, siteDomain, siteHomeHeroBackground, siteIconUrl, siteLoginBackground, siteName, taskConcurrency, thumbnailLongEdge, thumbnailQuality, uploadConcurrency } from "./schema.js";

// A lowercase DNS label, used for the configurable reserved sub-prefixes.
const subdomainLabel = z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "must be a lowercase DNS label");

// Every runtime default comes from one place — appConfig.runtimeDefaults, which mirrors
// config.json field-for-field. This schema only layers validators + structure on top.
const d = appConfig.runtimeDefaults;

const runtimeConfigSchema = z.object({
  site: z.object({
    name: siteName.default(d.site.name),
    domain: siteDomain.default(d.site.domain),
    icon_url: siteIconUrl.default(d.site.icon_url),
    root_redirect: rootRedirect.default(d.site.root_redirect),
    // Whether the public homepage (/home) exists. On (default) it's reachable and listed
    // in the nav; off makes /home redirect to the gallery, drops the 首页 nav entry, and
    // forces the root redirect to the gallery even when root_redirect is still "home".
    // File-only: sent to the frontend via /api/site-config, but not editable in the
    // settings UI (same pattern as image_detail.title_opens_image).
    home_enabled: z.boolean().default(d.site.home_enabled),
    // Admin login-page background. Empty derives the site's own random API
    // (effectiveLoginBackground); set any image URL to override. Editable in the
    // settings UI.
    login_background: siteLoginBackground.default(d.site.login_background),
    // Homepage hero background. Empty derives the site's own random API
    // (effectiveHomeHeroBackground); set any image URL to override. Editable in the UI.
    home_hero_background: siteHomeHeroBackground.default(d.site.home_hero_background),
    // Reserved sub-prefixes: <random_subdomain>.<domain> serves the random API,
    // <static_subdomain>.<domain> serves local objects, <docs_subdomain>.<domain>
    // serves the documentation site (built from packages/docs and bundled into the
    // app), and <link_subdomain>.<domain> serves everything for link (external-URL)
    // images — their stored thumbnail at /thumbs and the server-side proxy of their
    // external original at /media. All four are kept off the theme namespace.
    // File-only; not exposed in the settings UI or to the frontend.
    random_subdomain: subdomainLabel.default(d.site.random_subdomain),
    static_subdomain: subdomainLabel.default(d.site.static_subdomain),
    docs_subdomain: subdomainLabel.default(d.site.docs_subdomain),
    // Whether the docs.<domain> site is served at all. On by default (serves the bundled
    // VitePress docs); off makes that host return 404 while keeping 'docs' a reserved prefix
    // (so a theme still can't collide with it). File-only, like home_enabled — not in the
    // settings UI.
    docs_enabled: z.boolean().default(d.site.docs_enabled),
    link_subdomain: subdomainLabel.default(d.site.link_subdomain)
  }).default({}),
  port: z.coerce.number().int().positive().default(d.port),
  database: z.object({
    host: z.string().trim().min(1),
    port: z.coerce.number().int().positive().default(d.database.port),
    name: z.string().trim().min(1),
    user: z.string().trim().min(1),
    password: z.string().min(1)
  }),
  redis: z.object({
    host: z.string().trim().min(1).default(d.redis.host),
    port: z.coerce.number().int().positive().default(d.redis.port),
    db: z.coerce.number().int().nonnegative().default(d.redis.db)
  }).default({}),
  home: z.object({
    preview_delay_ms: previewDelayMs.default(d.home.preview_delay_ms)
  }).default({}),
  upload: z.object({
    max_file_size_mb: maxFileSizeMb.default(d.upload.max_file_size_mb),
    max_long_edge: maxLongEdge.default(d.upload.max_long_edge),
    list_page_size: listPageSize.default(d.upload.list_page_size),
    // Parallelism for a batch: the browser uploads this many files at once, and the
    // worker runs this many thumb.generate tasks at once. Editable in the settings UI.
    concurrency: uploadConcurrency.default(d.upload.concurrency)
  }).default({}),
  admin: z.object({
    image_page_size: imagePageSize.default(d.admin.image_page_size),
    recent_uploads: recentUploads.default(d.admin.recent_uploads)
  }).default({}),
  gallery: z.object({
    default_limit: galleryLimit.default(d.gallery.default_limit),
    // Site-wide gallery order: newest-first or shuffled within each loaded page.
    order: galleryOrder.default(d.gallery.order)
  }).default({}),
  random: z.object({
    default_method: randomMethod.default(d.random.default_method)
  }).default({}),
  image_detail: z.object({
    // When on, the image detail dialog's title becomes a link that opens the
    // image's direct object URL in a new tab. File-only (not in the settings UI);
    // set to false in config.json to turn the title link off.
    title_opens_image: z.boolean().default(d.image_detail.title_opens_image)
  }).default({}),
  link_image: z.object({
    // When on, importing a link image pre-fills its 原图URL (original) field with the
    // imported link itself. Off by default, so the 原图URL starts empty and the admin
    // fills it only when they want a distinct source link. File-only (read by the
    // uploader via the admin settings API; not editable in the settings UI).
    fill_original_url: z.boolean().default(d.link_image.fill_original_url)
  }).default({}),
  operation_log: z.object({
    // File-only worker concurrency for the idempotent storage-cleanup task types
    // (not exposed in the settings UI). Each runs up to this many tasks at once; the
    // category-mutating type (restore.finalize) and the idempotency-key singletons
    // (cache.rebuild / upload.cleanup) stay serial.
    delete_concurrency: taskConcurrency.default(d.operation_log.delete_concurrency),
    move_cleanup_concurrency: taskConcurrency.default(d.operation_log.move_cleanup_concurrency),
    empty_trash_concurrency: taskConcurrency.default(d.operation_log.empty_trash_concurrency),
    // How many of a deleted theme's images move their files to the none/ folder at once.
    theme_reassign_concurrency: taskConcurrency.default(d.operation_log.theme_reassign_concurrency)
  }).default({}),
  // File-only security tuning (not in the settings UI): session lifetime and the login
  // rate-limit thresholds. Read at request time, so a config.json edit + reload applies live.
  security: z.object({
    session_ttl_seconds: sessionTtlSeconds.default(d.security.session_ttl_seconds),
    login_failure_window_seconds: loginFailureWindowSeconds.default(d.security.login_failure_window_seconds),
    login_max_failures: loginMaxFailures.default(d.security.login_max_failures),
    login_global_window_seconds: loginGlobalWindowSeconds.default(d.security.login_global_window_seconds),
    login_global_max_attempts: loginGlobalMaxAttempts.default(d.security.login_global_max_attempts)
  }).default({}),
  // File-only thumbnail output tuning: the long-edge cap (px) and webp quality of newly
  // generated thumbnails.
  thumbnail: z.object({
    long_edge: thumbnailLongEdge.default(d.thumbnail.long_edge),
    quality: thumbnailQuality.default(d.thumbnail.quality)
  }).default({}),
  // File-only login captcha params: code length, challenge lifetime, and the two noise counts
  // (distractor lines / speckle dots). The rest of the image's look is a code-front constant.
  captcha: z.object({
    // Master on/off for the login captcha (default on). Turn off to skip the challenge
    // entirely — handy for local testing.
    enabled: z.boolean().default(d.captcha.enabled),
    code_length: captchaCodeLength.default(d.captcha.code_length),
    ttl_seconds: captchaTtlSeconds.default(d.captcha.ttl_seconds),
    noise_lines: captchaNoiseLines.default(d.captcha.noise_lines),
    noise_dots: captchaNoiseDots.default(d.captcha.noise_dots)
  }).default({}),
  // File-only logging: the threshold level (DEBUG/INFO/WARN/ERROR/OFF; default WARN) plus
  // size-based rotation of data/log/app.log — rotate once it passes max_size_mb, keeping
  // max_files archives (app.log.1 … app.log.N). Read at write time, so a reload applies live.
  log: z.object({
    level: logLevel.default(d.log.level),
    max_size_mb: logMaxSizeMb.default(d.log.max_size_mb),
    max_files: logMaxFiles.default(d.log.max_files)
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
      login_background: envValue("SITE_LOGIN_BACKGROUND"),
      home_hero_background: envValue("SITE_HOME_HERO_BACKGROUND"),
      random_subdomain: envValue("RANDOM_SUBDOMAIN"),
      static_subdomain: envValue("STATIC_SUBDOMAIN"),
      docs_subdomain: envValue("DOCS_SUBDOMAIN"),
      link_subdomain: envValue("LINK_SUBDOMAIN")
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
      max_long_edge: envValue("UPLOAD_MAX_LONG_EDGE"),
      list_page_size: envValue("UPLOAD_LIST_PAGE_SIZE"),
      concurrency: envValue("UPLOAD_CONCURRENCY")
    },
    admin: { image_page_size: envValue("ADMIN_IMAGE_PAGE_SIZE"), recent_uploads: envValue("ADMIN_RECENT_UPLOADS") },
    gallery: { default_limit: envValue("GALLERY_DEFAULT_LIMIT") },
    random: { default_method: envValue("RANDOM_DEFAULT_METHOD") }
    // operation_log.*_concurrency are file-only advanced knobs (default in config.json).
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
