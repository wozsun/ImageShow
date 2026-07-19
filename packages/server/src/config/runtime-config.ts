import { z } from "zod";
import { appConfig, slugPattern, type RuntimeConfig } from "@imageshow/shared";
import {
  altchaCost,
  altchaCounter,
  altchaTtlSeconds,
  commitConcurrency,
  galleryLimit,
  galleryOrder,
  globalCommitConcurrency,
  homeHeroBackground,
  homeTagline,
  imagePageSize,
  importGlobalConcurrency,
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
  rootRedirect,
  sessionTtlSeconds,
  siteDomain,
  siteIconUrl,
  siteName,
  skipWebpUnderKb,
  taskConcurrency,
  thumbnailLongEdge,
  thumbnailQuality,
  uploadConcurrency,
  uploadImportMaxItems,
  weiboGlobalConcurrency,
  weiboImportMaxItems,
  weiboMetadataConcurrency
} from "./fields.ts";

const subdomainLabel = z.string().trim().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "must be a lowercase DNS label"
);

const weiboUserId = z.string().regex(/^[1-9]\d{0,19}$/, "must be a numeric Weibo user ID");
const weiboAuthorSlug = z.string().trim().toLowerCase().min(1).max(32).regex(slugPattern);

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
    max_items: linkImportMaxItems
  }),
  weibo: z.strictObject({
    max_items: weiboImportMaxItems,
    concurrency: weiboMetadataConcurrency,
    global_concurrency: weiboGlobalConcurrency,
    author_slugs: z.record(weiboUserId, weiboAuthorSlug)
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
  altcha: z.strictObject({
    enabled: z.boolean(),
    ttl_seconds: altchaTtlSeconds,
    cost: altchaCost,
    counter_min: altchaCounter,
    counter_max: altchaCounter
  }).superRefine((value, context) => {
    if (value.counter_min > value.counter_max) {
      context.addIssue({
        code: "custom",
        message: "counter_min must not exceed counter_max",
        path: ["counter_min"]
      });
    }
    if (
      value.cost * value.counter_max >
      appConfig.authentication.altcha.maximumWorkFactor
    ) {
      context.addIssue({
        code: "custom",
        message: `cost * counter_max must not exceed ${appConfig.authentication.altcha.maximumWorkFactor}`,
        path: ["counter_max"]
      });
    }
  }),
  log: z.strictObject({ level: logLevel, max_size_mb: logMaxSizeMb, max_files: logMaxFiles })
});

export const portableRuntimeConfigSchema = runtimeConfigSchema
  .extend({ site: runtimeConfigSchema.shape.site.omit({ domain: true }) });

export type PortableRuntimeConfig = Omit<RuntimeConfig, "site"> & {
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
  return structuredClone(appConfig.runtimeDefaults);
}

function projectKnownConfig(base: unknown, input: unknown): unknown {
  if (!isPlainRecord(base)) return input === undefined ? base : input;
  if (input === undefined) return structuredClone(base);
  if (!isPlainRecord(input)) return input;

  // An empty default object denotes a validated dictionary rather than a
  // fixed-shape config section. Preserve its user-defined keys and let the
  // runtime schema validate each entry.
  if (Object.keys(base).length === 0) return structuredClone(input);

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

export function runtimeConfigDefaults(): RuntimeConfig {
  return parseRuntimeConfig(structuredClone(appConfig.runtimeDefaults));
}
