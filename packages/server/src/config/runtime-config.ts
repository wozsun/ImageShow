import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import {
  slugMaxLength,
  slugPattern,
  type RuntimeConfig
} from "@imageshow/shared/browser";
import {
  altchaCost,
  altchaCounter,
  altchaTtlSeconds,
  ingestionCommitConcurrency,
  embedAllowedOrigins,
  galleryLimit,
  galleryOrder,
  homeBackground,
  homeBannerLabel,
  homeBannerTitle,
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
  recentUploads,
  siteRoot,
  sessionTtlSeconds,
  siteDomain,
  siteDescription,
  siteIcon,
  siteName,
  skipWebpUnderKb,
  thumbnailLongEdge,
  thumbnailQuality,
  uploadBrowserConcurrency,
  uploadMaxItems,
  uploadRawConcurrency,
  weiboImportMaxItems,
  weiboRequestDelaySeconds
} from "./fields.ts";

const subdomainLabel = z.string().trim().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  "must be a lowercase DNS label"
);

const weiboUserId = z.string().regex(/^[1-9]\d{0,19}$/, "must be a numeric Weibo user ID");
const weiboAuthorSlug = z.string().trim().toLowerCase().min(1)
  .max(slugMaxLength).regex(slugPattern);
const weiboAuthorSlugs = z.preprocess((value, context) => {
  if (
    value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.hasOwn(value, "__proto__")
  ) {
    context.addIssue({
      code: "custom",
      message: 'object key "__proto__" is not allowed',
      path: ["__proto__"]
    });
    return z.NEVER;
  }
  return value;
}, z.record(weiboUserId, weiboAuthorSlug));

const runtimeConfigSchema = z.strictObject({
  site: z.strictObject({
    name: siteName,
    domain: siteDomain,
    description: siteDescription,
    icon: siteIcon,
    version: z.strictObject({
      enabled: z.boolean(),
      link_enabled: z.boolean()
    }),
    root: siteRoot,
    home: z.strictObject({
      enabled: z.boolean(),
      background: homeBackground,
      banner_label: homeBannerLabel,
      banner_title: homeBannerTitle
    }),
    gallery: z.strictObject({
      limit: galleryLimit,
      order: galleryOrder
    }),
    random_method: randomDefaultMethod,
    static_subdomain: subdomainLabel,
    robots_enabled: z.boolean()
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
    request_delay_seconds: z.tuple([
      weiboRequestDelaySeconds,
      weiboRequestDelaySeconds
    ]).refine(
      ([minDelaySeconds, maxDelaySeconds]) => minDelaySeconds <= maxDelaySeconds,
      {
        message: "minimum delay must not exceed maximum delay",
        path: [0]
      }
    ),
    author_slugs: weiboAuthorSlugs
  }),
  normalize: z.strictObject({
    concurrency: normalizeConcurrency,
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
  admin: z.strictObject({
    login_background: loginBackground,
    image_page_size: imagePageSize,
    recent_uploads: recentUploads,
    show_unset_theme_card: z.boolean()
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
    counter_range: z.tuple([altchaCounter, altchaCounter])
  }).superRefine((value, context) => {
    const [minCounter, maxCounter] = value.counter_range;
    if (minCounter > maxCounter) {
      context.addIssue({
        code: "custom",
        message: "minimum counter must not exceed maximum counter",
        path: ["counter_range", 0]
      });
    }
    if (
      value.cost * maxCounter >
      appConfig.authentication.altcha.maximumWorkFactor
    ) {
      context.addIssue({
        code: "custom",
        message: `cost * maximum counter must not exceed ${appConfig.authentication.altcha.maximumWorkFactor}`,
        path: ["counter_range", 1]
      });
    }
  }),
  log: z.strictObject({ level: logLevel, max_size_mb: logMaxSizeMb, max_files: logMaxFiles })
});

const portableSiteConfigSchema = runtimeConfigSchema.shape.site.omit({ domain: true });

export const portableRuntimeConfigSchema = runtimeConfigSchema.extend({
  site: portableSiteConfigSchema
});

export type PortableRuntimeConfig = z.infer<typeof portableRuntimeConfigSchema>;

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

export function parseRuntimeConfig(value: unknown): RuntimeConfig {
  return runtimeConfigSchema.parse(value);
}

export function normalizeRuntimeConfig(value: unknown): RuntimeConfig {
  return runtimeConfigSchema.parse(projectKnownConfig(
    appConfig.runtimeDefaults,
    value
  ));
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
