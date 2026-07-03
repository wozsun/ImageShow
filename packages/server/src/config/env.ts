import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import { captchaCodeLength, captchaNoiseDots, captchaNoiseLines, captchaTtlSeconds, galleryLimit, galleryOrder, homeHeroBackground, homeTagline, imagePageSize, linkImageConcurrency, listPageSize, logLevel, logMaxFiles, logMaxSizeMb, loginBackground, loginFailureWindowSeconds, loginGlobalMaxAttempts, loginGlobalWindowSeconds, loginMaxFailures, maxFileSizeMb, maxLongEdge, normalizeMaxLongEdge, normalizeMaxSizeKb, normalizeMinQuality, normalizeQuality, normalizeQualityStep, previewDelayMs, randomMethod, recentUploads, rootRedirect, sessionTtlSeconds, siteDomain, siteIconUrl, siteName, skipWebpUnderKb, taskConcurrency, thumbnailLongEdge, thumbnailQuality, uploadConcurrency } from "./schema.js";

const subdomainLabel = z.string().trim().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, "must be a lowercase DNS label");

const d = appConfig.runtimeDefaults;

const runtimeConfigSchema = z.object({
  site: z.object({
    name: siteName.default(d.site.name),
    domain: siteDomain.default(d.site.domain),
    icon_url: siteIconUrl.default(d.site.icon_url),
    root_redirect: rootRedirect.default(d.site.root_redirect),
    home: z.object({
      enabled: z.boolean().default(d.site.home.enabled),
      tagline: homeTagline.default(d.site.home.tagline),
      hero_background: homeHeroBackground.default(d.site.home.hero_background),
      preview_delay_ms: previewDelayMs.default(d.site.home.preview_delay_ms)
    }).prefault({}),
    gallery: z.object({
      default_limit: galleryLimit.default(d.site.gallery.default_limit),
      order: galleryOrder.default(d.site.gallery.order)
    }).prefault({}),
    random_default_method: randomMethod.default(d.site.random_default_method),
    random_subdomain: subdomainLabel.default(d.site.random_subdomain),
    static_subdomain: subdomainLabel.default(d.site.static_subdomain),
    docs_subdomain: subdomainLabel.default(d.site.docs_subdomain),
    docs_enabled: z.boolean().default(d.site.docs_enabled),
    link_subdomain: subdomainLabel.default(d.site.link_subdomain),
    robots_enabled: z.boolean().default(d.site.robots_enabled)
  }).prefault({}),
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
  }).prefault({}),
  upload: z.object({
    max_file_size_mb: maxFileSizeMb.default(d.upload.max_file_size_mb),
    max_long_edge: maxLongEdge.default(d.upload.max_long_edge),
    list_page_size: listPageSize.default(d.upload.list_page_size),
    concurrency: uploadConcurrency.default(d.upload.concurrency)
  }).prefault({}),
  link_image: z.object({
    fill_original_url: z.boolean().default(d.link_image.fill_original_url),
    concurrency: linkImageConcurrency.default(d.link_image.concurrency)
  }).prefault({}),
  normalize: z.object({
    quality: normalizeQuality.default(d.normalize.quality),
    quality_step: normalizeQualityStep.default(d.normalize.quality_step),
    min_quality: normalizeMinQuality.default(d.normalize.min_quality),
    max_long_edge: normalizeMaxLongEdge.default(d.normalize.max_long_edge),
    max_size_kb: normalizeMaxSizeKb.default(d.normalize.max_size_kb),
    skip_webp_under_kb: skipWebpUnderKb.default(d.normalize.skip_webp_under_kb)
  }).refine((value) => value.min_quality <= value.quality, {
    message: "min_quality must not exceed quality",
    path: ["min_quality"]
  }).prefault({}),
  thumbnail: z.object({
    long_edge: thumbnailLongEdge.default(d.thumbnail.long_edge),
    quality: thumbnailQuality.default(d.thumbnail.quality)
  }).prefault({}),
  image_detail: z.object({
    title_opens_image: z.boolean().default(d.image_detail.title_opens_image)
  }).prefault({}),
  admin: z.object({
    login_background: loginBackground.default(d.admin.login_background),
    image_page_size: imagePageSize.default(d.admin.image_page_size),
    recent_uploads: recentUploads.default(d.admin.recent_uploads),
    // 主题管理页是否展示钉住的「未设置」占位卡片；关闭后只影响后台展示，不改变图片数据。
    show_unset_theme_card: z.boolean().default(d.admin.show_unset_theme_card)
  }).prefault({}),
  operation_log: z.object({
    move_cleanup_concurrency: taskConcurrency.default(d.operation_log.move_cleanup_concurrency),
    theme_reassign_concurrency: taskConcurrency.default(d.operation_log.theme_reassign_concurrency),
    migrate_concurrency: taskConcurrency.default(d.operation_log.migrate_concurrency)
  }).prefault({}),
  security: z.object({
    session_ttl_seconds: sessionTtlSeconds.default(d.security.session_ttl_seconds),
    login_failure_window_seconds: loginFailureWindowSeconds.default(d.security.login_failure_window_seconds),
    login_max_failures: loginMaxFailures.default(d.security.login_max_failures),
    login_global_window_seconds: loginGlobalWindowSeconds.default(d.security.login_global_window_seconds),
    login_global_max_attempts: loginGlobalMaxAttempts.default(d.security.login_global_max_attempts)
  }).prefault({}),
  captcha: z.object({
    enabled: z.boolean().default(d.captcha.enabled),
    code_length: captchaCodeLength.default(d.captcha.code_length),
    ttl_seconds: captchaTtlSeconds.default(d.captcha.ttl_seconds),
    noise_lines: captchaNoiseLines.default(d.captcha.noise_lines),
    noise_dots: captchaNoiseDots.default(d.captcha.noise_dots)
  }).prefault({}),

  log: z.object({
    level: logLevel.default(d.log.level),
    max_size_mb: logMaxSizeMb.default(d.log.max_size_mb),
    max_files: logMaxFiles.default(d.log.max_files)
  }).prefault({})
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

const dataDir = rawEnv.NODE_ENV === "production" ? "/app/data" : join(process.cwd(), "data");
const configDir = dataDir;
const storageDir = join(dataDir, "storage");
const tempDir = join(dataDir, "tmp");
const logDir = join(dataDir, "log");
const configPath = join(dataDir, "config.json");

function envValue(name: string) {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function envBoolean(name: string): boolean | undefined {
  const value = envValue(name);
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
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

  // 解析成功后把缺省字段补齐并写回磁盘，保持 config.json 结构完整。
  if (JSON.stringify(value) !== JSON.stringify(parsed.data)) writeRuntimeConfig(parsed.data);
  return parsed.data;
}

function initialConfigFromEnvironment() {
  return runtimeConfigSchema.parse({
    site: {
      name: envValue("SITE_NAME"),
      domain: envValue("SITE_DOMAIN"),
      icon_url: envValue("SITE_ICON_URL"),
      root_redirect: envValue("SITE_ROOT_REDIRECT"),
      home: {
        enabled: envBoolean("SITE_HOME_ENABLED"),
        tagline: envValue("SITE_HOME_TAGLINE"),
        hero_background: envValue("SITE_HOME_HERO_BACKGROUND"),
        preview_delay_ms: envValue("SITE_HOME_PREVIEW_DELAY_MS")
      },
      gallery: {
        default_limit: envValue("SITE_GALLERY_DEFAULT_LIMIT"),
        order: envValue("SITE_GALLERY_ORDER")
      },
      random_default_method: envValue("SITE_RANDOM_DEFAULT_METHOD"),
      random_subdomain: envValue("SITE_RANDOM_SUBDOMAIN"),
      static_subdomain: envValue("SITE_STATIC_SUBDOMAIN"),
      docs_subdomain: envValue("SITE_DOCS_SUBDOMAIN"),
      link_subdomain: envValue("SITE_LINK_SUBDOMAIN")
    },
    port: envValue("PORT"),
    database: {
      host: requiredBootstrapEnv("DATABASE_HOST"),
      port: envValue("DATABASE_PORT"),
      name: requiredBootstrapEnv("DATABASE_NAME"),
      user: requiredBootstrapEnv("DATABASE_USER"),
      password: requiredBootstrapEnv("DATABASE_PASSWORD")
    },
    redis: {
      host: envValue("REDIS_HOST"),
      port: envValue("REDIS_PORT"),
      db: envValue("REDIS_DB")
    },
    upload: {
      max_file_size_mb: envValue("UPLOAD_MAX_FILE_SIZE_MB"),
      max_long_edge: envValue("UPLOAD_MAX_LONG_EDGE"),
      list_page_size: envValue("UPLOAD_LIST_PAGE_SIZE"),
      concurrency: envValue("UPLOAD_CONCURRENCY")
    },
    admin: {
      login_background: envValue("ADMIN_LOGIN_BACKGROUND"),
      image_page_size: envValue("ADMIN_IMAGE_PAGE_SIZE"),
      recent_uploads: envValue("ADMIN_RECENT_UPLOADS"),
      show_unset_theme_card: envBoolean("ADMIN_SHOW_UNSET_THEME_CARD")
    },
    link_image: {
      fill_original_url: envBoolean("LINK_IMAGE_FILL_ORIGINAL_URL"),
      concurrency: envValue("LINK_IMAGE_CONCURRENCY")
    },
    normalize: {
      quality: envValue("NORMALIZE_QUALITY"),
      quality_step: envValue("NORMALIZE_QUALITY_STEP"),
      min_quality: envValue("NORMALIZE_MIN_QUALITY"),
      max_long_edge: envValue("NORMALIZE_MAX_LONG_EDGE"),
      max_size_kb: envValue("NORMALIZE_MAX_SIZE_KB"),
      skip_webp_under_kb: envValue("NORMALIZE_SKIP_WEBP_UNDER_KB")
    }
  });
}

function writeRuntimeConfig(value: RuntimeConfig) {
  mkdirSync(configDir, { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  try {
    // 先写临时文件再 rename，避免进程中断时留下半截 config.json。
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
    // 设置页通常只提交局部配置组；深合并能保留未触达的兄弟字段，再交给 zod 做完整校验和默认值补齐。
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

type RuntimeConfigListener = () => void;
const runtimeConfigListeners: RuntimeConfigListener[] = [];
export function onRuntimeConfigChange(listener: RuntimeConfigListener) {
  runtimeConfigListeners.push(listener);
}
function notifyRuntimeConfigChange() {
  for (const listener of runtimeConfigListeners) listener();
}

export function updateRuntimeConfig(patch: Partial<RuntimeConfig>) {
  const next = runtimeConfigSchema.parse(mergeDeep(runtimeConfig, patch as Record<string, unknown>));
  writeRuntimeConfig(next);
  runtimeConfig = next;
  notifyRuntimeConfigChange();
  return runtimeConfig;
}

export function reloadRuntimeConfig() {
  const fromDisk = readExistingConfig();
  if (!fromDisk) throw new Error(`Runtime config ${configPath} does not exist`);
  runtimeConfig = fromDisk;
  notifyRuntimeConfigChange();
  return runtimeConfig;
}

export const env = {
  NODE_ENV: rawEnv.NODE_ENV,
  ADMIN_USERNAME: rawEnv.ADMIN_USERNAME,
  ADMIN_PASSWORD: rawEnv.ADMIN_PASSWORD,
  CONFIG_DIR: configDir,
  STORAGE_DIR: storageDir,
  TEMP_DIR: tempDir,
  LOG_DIR: logDir,
  PORT: runtimeConfig.port,
  DATABASE_HOST: runtimeConfig.database.host,
  DATABASE_PORT: runtimeConfig.database.port,
  DATABASE_NAME: runtimeConfig.database.name,
  DATABASE_USER: runtimeConfig.database.user,
  DATABASE_PASSWORD: runtimeConfig.database.password,
  REDIS_HOST: runtimeConfig.redis.host,
  REDIS_PORT: runtimeConfig.redis.port,
  REDIS_DB: runtimeConfig.redis.db
};
