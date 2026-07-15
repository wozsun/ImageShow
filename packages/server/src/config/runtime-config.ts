import { z } from "zod";
import { appConfig, type RuntimeConfig } from "@imageshow/shared";
import {
  applicationPort,
  captchaCodeLength,
  captchaNoiseDots,
  captchaNoiseLines,
  captchaTtlSeconds,
  commitConcurrency,
  galleryLimit,
  galleryOrder,
  globalCommitConcurrency,
  homeHeroBackground,
  homeTagline,
  imagePageSize,
  importGlobalConcurrency,
  jsonlImportMaxItems,
  linkFetchTimeoutSeconds,
  linkImageConcurrency,
  linkImportMaxItems,
  listPageSize,
  logLevel,
  logMaxFiles,
  logMaxSizeMb,
  loginBackground,
  loginFailureWindowSeconds,
  loginGlobalMaxAttempts,
  loginGlobalWindowSeconds,
  loginMaxFailures,
  maxFileSizeMb,
  maxLongEdge,
  normalizeMaxLongEdge,
  normalizeMaxSizeKb,
  normalizeMinQuality,
  normalizeQuality,
  normalizeQualityStep,
  previewDelayMs,
  randomMethod,
  recentUploads,
  redisDatabase,
  rootRedirect,
  sessionTtlSeconds,
  servicePort,
  siteDomain,
  siteIconUrl,
  siteName,
  skipWebpUnderKb,
  taskConcurrency,
  thumbnailLongEdge,
  thumbnailQuality,
  uploadConcurrency,
  uploadImportMaxItems
} from "./fields.ts";

const subdomainLabel = z.string().trim().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "must be a lowercase DNS label"
);

const runtimeConfigSchema = z.strictObject({
  site: z.strictObject({
    name: siteName,
    domain: siteDomain,
    icon_url: siteIconUrl,
    root_redirect: rootRedirect,
    home: z.strictObject({
      enabled: z.boolean(),
      tagline: homeTagline,
      hero_background: homeHeroBackground,
      preview_delay_ms: previewDelayMs
    }),
    gallery: z.strictObject({
      default_limit: galleryLimit,
      order: galleryOrder
    }),
    random_default_method: randomMethod,
    random_subdomain: subdomainLabel,
    static_subdomain: subdomainLabel,
    docs_subdomain: subdomainLabel,
    docs_enabled: z.boolean(),
    link_subdomain: subdomainLabel,
    robots_enabled: z.boolean()
  }),
  port: applicationPort,
  database: z.strictObject({
    host: z.string().trim().min(1),
    port: servicePort,
    name: z.string().trim().min(1),
    user: z.string().trim().min(1),
    password: z.string().min(1)
  }),
  redis: z.strictObject({
    host: z.string().trim().min(1),
    port: servicePort,
    db: redisDatabase
  }),
  upload: z.strictObject({
    max_items: uploadImportMaxItems,
    max_file_size_mb: maxFileSizeMb,
    max_long_edge: maxLongEdge,
    list_page_size: listPageSize,
    concurrency: uploadConcurrency,
    global_concurrency: importGlobalConcurrency
  }),
  link_image: z.strictObject({
    fill_original_url: z.boolean(),
    concurrency: linkImageConcurrency,
    global_concurrency: importGlobalConcurrency,
    fetch_timeout_seconds: linkFetchTimeoutSeconds,
    url_list_max_items: linkImportMaxItems,
    jsonl_max_items: jsonlImportMaxItems
  }),
  normalize: z.strictObject({
    quality: normalizeQuality,
    quality_step: normalizeQualityStep,
    min_quality: normalizeMinQuality,
    max_long_edge: normalizeMaxLongEdge,
    max_size_kb: normalizeMaxSizeKb,
    skip_webp_under_kb: skipWebpUnderKb
  }).refine((value) => value.min_quality <= value.quality, {
    message: "min_quality must not exceed quality",
    path: ["min_quality"]
  }),
  thumbnail: z.strictObject({ long_edge: thumbnailLongEdge, quality: thumbnailQuality }),
  import: z.strictObject({
    commit_concurrency: commitConcurrency,
    global_commit_concurrency: globalCommitConcurrency
  }),
  image_detail: z.strictObject({ title_opens_image: z.boolean() }),
  admin: z.strictObject({
    login_background: loginBackground,
    image_page_size: imagePageSize,
    recent_uploads: recentUploads,
    show_unset_theme_card: z.boolean()
  }),
  background_job: z.strictObject({
    move_cleanup_concurrency: taskConcurrency,
    theme_reassign_concurrency: taskConcurrency,
    migrate_concurrency: taskConcurrency
  }),
  security: z.strictObject({
    session_ttl_seconds: sessionTtlSeconds,
    login_failure_window_seconds: loginFailureWindowSeconds,
    login_max_failures: loginMaxFailures,
    login_global_window_seconds: loginGlobalWindowSeconds,
    login_global_max_attempts: loginGlobalMaxAttempts
  }),
  captcha: z.strictObject({
    enabled: z.boolean(),
    code_length: captchaCodeLength,
    ttl_seconds: captchaTtlSeconds,
    noise_lines: captchaNoiseLines,
    noise_dots: captchaNoiseDots
  }),
  log: z.strictObject({ level: logLevel, max_size_mb: logMaxSizeMb, max_files: logMaxFiles })
});

export const portableRuntimeConfigSchema = runtimeConfigSchema
  .omit({ port: true, database: true, redis: true })
  .extend({ site: runtimeConfigSchema.shape.site.omit({ domain: true }) });

export type PortableRuntimeConfig = Omit<RuntimeConfig, "port" | "database" | "redis" | "site"> & {
  site: Omit<RuntimeConfig["site"], "domain">;
};

export type RuntimeConfigPatch<T = RuntimeConfig> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? RuntimeConfigPatch<T[K]> : T[K];
};

function mergeDefined(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    if (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      current !== null && typeof current === "object" && !Array.isArray(current)
    ) {
      result[key] = mergeDefined(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function runtimeConfigNormalizationBase(): Record<string, unknown> {
  return {
    ...structuredClone(appConfig.runtimeDefaults),
    database: {
      host: undefined,
      port: appConfig.runtimeDefaults.database.port,
      name: undefined,
      user: undefined,
      password: undefined
    }
  };
}

function projectKnownConfig(base: unknown, input: unknown): unknown {
  if (!isPlainRecord(base)) return input === undefined ? base : input;
  if (input === undefined) return structuredClone(base);
  if (!isPlainRecord(input)) return input;

  return Object.fromEntries(
    Object.entries(base).map(([key, defaultValue]) => [
      key,
      projectKnownConfig(defaultValue, input[key])
    ])
  );
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  return runtimeConfigSchema.parse(value);
}

export function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  return runtimeConfigSchema.parse(projectKnownConfig(runtimeConfigNormalizationBase(), value));
}

export function mergeRuntimeConfig(current: RuntimeConfig, patch: RuntimeConfigPatch): RuntimeConfig {
  return parseRuntimeConfig(mergeDefined(
    current as unknown as Record<string, unknown>,
    patch as Record<string, unknown>
  ));
}

export function runtimeConfigDefaults(database: RuntimeConfig["database"]): RuntimeConfig {
  return parseRuntimeConfig({ ...structuredClone(appConfig.runtimeDefaults), database });
}
