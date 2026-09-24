import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import { type RuntimeConfig } from "@imageshow/shared/browser";
import {
  altchaCost,
  altchaCounter,
  altchaTtlSeconds,
  ingestionCommitConcurrency,
  embedAllowedOrigins,
  galleryOrder,
  homeBackground,
  homeBannerLabel,
  homeBannerTitle,
  homeBrowseTarget,
  imagePageSize,
  importFetchTimeoutSeconds,
  importTypesKeepingOriginalLink,
  importMaxItems,
  ingestionListPageSize,
  ingestionMaxFileSizeMb,
  ingestionMaxLongEdge,
  logLevel,
  logMaxFiles,
  logMaxSizeMb,
  loginBackground,
  loginFailureWindowSeconds,
  loginGlobalMaxAttempts,
  loginGlobalWindowSeconds,
  loginMaxFailures,
  normalizeMaxLongEdge,
  normalizeMaxSizeKb,
  normalizeConcurrency,
  normalizeMinQuality,
  normalizeQuality,
  normalizeQualityStep,
  randomDefaultMethod,
  randomImageSize,
  randomWindowSeconds,
  randomMaxRequests,
  recentUploads,
  showDensity,
  showDriftSpeed,
  showMode,
  showOrder,
  siteRoot,
  sessionTtlSeconds,
  siteDomain,
  siteDescription,
  siteFooter,
  siteFooterText,
  siteIcon,
  siteHeaderName,
  siteTitle,
  skipWebpUnderKb,
  thumbnailLongEdge,
  thumbnailQuality,
  uploadBrowserConcurrency,
  uploadMaxItems,
  uploadRawConcurrency,
  weiboImportMaxItems,
  weiboRequestDelaySeconds
} from "./field-schemas.ts";
import { publicBaseUrlSchema, publicUrlUsesSiteHost } from "../core/url-validation.ts";

export const runtimeConfigSchema = z.strictObject({
  site: z.strictObject({
    domain: siteDomain,
    icon: siteIcon,
    title: siteTitle,
    description: siteDescription,
    header_name: siteHeaderName,
    version: z.strictObject({
      enabled: z.boolean(),
      link_enabled: z.boolean()
    }),
    root: siteRoot,
    home: z.strictObject({
      enabled: z.boolean(),
      browse_target: homeBrowseTarget,
      background: homeBackground,
      banner_label: homeBannerLabel,
      banner_title: homeBannerTitle
    }),
    show: z.strictObject({
      enabled: z.boolean(),
      autoplay: z.boolean(),
      mode: showMode,
      density: showDensity,
      drift_speed: showDriftSpeed,
      order: showOrder
    }),
    gallery: z.strictObject({
      enabled: z.boolean(),
      order: galleryOrder
    }),
    random_method: randomDefaultMethod,
    random_size: randomImageSize,
    assets_base_url: publicBaseUrlSchema,
    robots_enabled: z.boolean(),
    icp: siteFooterText,
    mps: siteFooterText,
    footer: siteFooter
  }),
  embed: z.strictObject({
    enabled: z.boolean(),
    allowed_origins: embedAllowedOrigins
  }),
  ingestion: z.strictObject({
    max_file_size_mb: ingestionMaxFileSizeMb,
    max_long_edge: ingestionMaxLongEdge,
    list_page_size: ingestionListPageSize,
    commit_concurrency: ingestionCommitConcurrency
  }),
  upload: z.strictObject({
    max_items: uploadMaxItems,
    browser_concurrency: uploadBrowserConcurrency,
    raw_concurrency: uploadRawConcurrency
  }),
  import: z.strictObject({
    keep_original_link: importTypesKeepingOriginalLink,
    auto_import: z.boolean(),
    fetch_timeout_seconds: importFetchTimeoutSeconds,
    max_items: importMaxItems
  }),
  weibo: z.strictObject({
    max_items: weiboImportMaxItems,
    source_enabled: z.boolean(),
    request_delay_seconds: z
      .tuple([
        weiboRequestDelaySeconds,
        weiboRequestDelaySeconds
      ])
      .refine(([minDelaySeconds, maxDelaySeconds]) => minDelaySeconds <= maxDelaySeconds, {
        message: "minimum delay must not exceed maximum delay",
        path: [0]
      })
  }),
  normalize: z
    .strictObject({
      concurrency: normalizeConcurrency,
      quality: normalizeQuality,
      quality_step: normalizeQualityStep,
      min_quality: normalizeMinQuality,
      max_long_edge: normalizeMaxLongEdge,
      max_size_kb: normalizeMaxSizeKb,
      skip_webp_under_kb: skipWebpUnderKb
    })
    .refine((value) => value.min_quality <= value.quality, {
      message: "min_quality must not exceed quality",
      path: ["min_quality"]
    }),
  thumbnail: z.strictObject({ long_edge: thumbnailLongEdge, quality: thumbnailQuality }),
  admin: z.strictObject({
    login_background: loginBackground,
    image_page_size: imagePageSize,
    recent_uploads: recentUploads
  }),
  security: z.strictObject({
    session_ttl_seconds: sessionTtlSeconds,
    login_failure_window_seconds: loginFailureWindowSeconds,
    login_max_failures: loginMaxFailures,
    login_global_window_seconds: loginGlobalWindowSeconds,
    login_global_max_attempts: loginGlobalMaxAttempts,
    random_window_seconds: randomWindowSeconds,
    random_max_requests: randomMaxRequests,
    random_limit_max_requests: randomMaxRequests
  }),
  altcha: z
    .strictObject({
      enabled: z.boolean(),
      ttl_seconds: altchaTtlSeconds,
      cost: altchaCost,
      counter_range: z.tuple([altchaCounter, altchaCounter])
    })
    .superRefine((value, context) => {
      const [minCounter, maxCounter] = value.counter_range;
      if (minCounter > maxCounter) {
        context.addIssue({
          code: "custom",
          message: "minimum counter must not exceed maximum counter",
          path: ["counter_range", 0]
        });
      }
      if (value.cost * maxCounter > appConfig.authentication.altcha.maximumWorkFactor) {
        context.addIssue({
          code: "custom",
          message: `cost * maximum counter must not exceed ${appConfig.authentication.altcha.maximumWorkFactor}`,
          path: ["counter_range", 1]
        });
      }
    }),
  log: z.strictObject({ level: logLevel, max_size_mb: logMaxSizeMb, max_files: logMaxFiles })
});

export type RuntimeConfigPatch<T = RuntimeConfig> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? RuntimeConfigPatch<T[K]> : T[K];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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

function mergeDefined(base: Record<string, unknown>, patch: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = result[key];
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current !== null &&
      typeof current === "object" &&
      !Array.isArray(current)
    ) {
      result[key] = mergeDefined(
        current as Record<string, unknown>,
        value as Record<string, unknown>
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  const config = runtimeConfigSchema.parse(value);
  if (publicUrlUsesSiteHost(config.site.assets_base_url, config.site.domain)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["site", "assets_base_url"],
        message: "静态资源公开地址须使用独立 Host；使用主站地址请将公开 URL 留空"
      }
    ]);
  }
  return config;
}

export function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  return parseRuntimeConfig(projectKnownConfig(
    appConfig.runtimeDefaults,
    value
  ));
}

export function mergeRuntimeConfig(
  current: RuntimeConfig,
  patch: RuntimeConfigPatch
): RuntimeConfig {
  return parseRuntimeConfig(
    mergeDefined(
      current as unknown as Record<string, unknown>,
      patch as Record<string, unknown>
    )
  );
}

export function runtimeConfigDefaults(): RuntimeConfig {
  return parseRuntimeConfig(structuredClone(appConfig.runtimeDefaults));
}
