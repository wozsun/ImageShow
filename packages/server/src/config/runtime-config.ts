import { z } from "zod";
import { appConfig } from "@imageshow/shared";
import {
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
      order: galleryOrder,
      public_original_button: z.boolean()
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
    )
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

export type PortableRuntimeConfigProjection = {
  config: PortableRuntimeConfig;
  recognizedValues: number;
  defaultedValues: number;
  ignoredValues: number;
};

export type RuntimeConfigPatch<T = RuntimeConfig> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? RuntimeConfigPatch<T[K]> : T[K];
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type ConfigPath = PropertyKey[];

type ConfigCandidate = {
  path: ConfigPath;
  value: unknown;
};

function samePortableConfigValueType(defaultValue: unknown, input: unknown) {
  if (Array.isArray(defaultValue)) return Array.isArray(input);
  if (defaultValue === null) return input === null;
  if (isPlainRecord(defaultValue)) return isPlainRecord(input);
  return typeof input === typeof defaultValue;
}

function portableRuntimeConfigDefaults(): PortableRuntimeConfig {
  const runtimeDefaults = runtimeConfigDefaults();
  const { domain: _domain, ...site } = runtimeDefaults.site;
  return portableRuntimeConfigSchema.parse({
    ...runtimeDefaults,
    site
  });
}

function collectPortableConfigCandidates(
  defaults: unknown,
  input: unknown,
  path: ConfigPath,
  candidates: ConfigCandidate[]
): number {
  if (input === undefined) return 0;
  if (!isPlainRecord(defaults) || Object.keys(defaults).length === 0) {
    if (!samePortableConfigValueType(defaults, input)) return 1;
    candidates.push({ path, value: structuredClone(input) });
    return 0;
  }
  if (!isPlainRecord(input)) {
    candidates.push({ path, value: structuredClone(input) });
    return 0;
  }

  let unknownValues = 0;
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(defaults, key)) unknownValues += 1;
  }
  for (const [key, defaultValue] of Object.entries(defaults)) {
    unknownValues += collectPortableConfigCandidates(
      defaultValue,
      input[key],
      [...path, key],
      candidates
    );
  }
  return unknownValues;
}

function countPortableConfigValues(value: unknown): number {
  if (!isPlainRecord(value) || Object.keys(value).length === 0) return 1;
  let count = 0;
  for (const child of Object.values(value)) {
    count += countPortableConfigValues(child);
  }
  return count;
}

function configPathStartsWith(path: ConfigPath, prefix: ConfigPath) {
  return prefix.length <= path.length
    && prefix.every((segment, index) => segment === path[index]);
}

function setConfigCandidate(
  root: PortableRuntimeConfig,
  candidate: ConfigCandidate
): PortableRuntimeConfig {
  if (candidate.path.length === 0) {
    return structuredClone(candidate.value) as PortableRuntimeConfig;
  }
  let owner = root as unknown as Record<PropertyKey, unknown>;
  for (const segment of candidate.path.slice(0, -1)) {
    owner = owner[segment] as Record<PropertyKey, unknown>;
  }
  owner[candidate.path.at(-1)!] = structuredClone(candidate.value);
  return root;
}

function configFromCandidates(
  defaults: PortableRuntimeConfig,
  candidates: ConfigCandidate[],
  activeCandidates: Set<number>
) {
  let config = structuredClone(defaults);
  for (const [index, candidate] of candidates.entries()) {
    if (activeCandidates.has(index)) {
      config = setConfigCandidate(config, candidate);
    }
  }
  return config;
}

function configIssueSignature(issue: {
  code: string;
  message: string;
  path: readonly PropertyKey[];
}) {
  return JSON.stringify([issue.code, issue.message, issue.path]);
}

/**
 * Read a package's portable runtime config with the target version's schema.
 * Known values are kept only while the complete current configuration remains
 * valid; missing, unknown, removed, or invalid values converge to current
 * defaults without creating a version or alias migration layer.
 */
export function projectPortableRuntimeConfig(
  input: unknown
): PortableRuntimeConfigProjection {
  const defaults = portableRuntimeConfigDefaults();
  const candidates: ConfigCandidate[] = [];
  const unknownValues = collectPortableConfigCandidates(
    defaults,
    input,
    [],
    candidates
  );
  const activeCandidates = new Set(candidates.map((_, index) => index));

  while (true) {
    const result = portableRuntimeConfigSchema.safeParse(configFromCandidates(
      defaults,
      candidates,
      activeCandidates
    ));
    if (result.success) {
      return {
        config: result.data,
        recognizedValues: activeCandidates.size,
        defaultedValues: countPortableConfigValues(defaults) - activeCandidates.size,
        ignoredValues: unknownValues + candidates.length - activeCandidates.size
      };
    }

    const directlyInvalid: number[] = [];
    for (const issue of result.error.issues) {
      for (const index of activeCandidates) {
        if (
          configPathStartsWith(issue.path, candidates[index]!.path)
          && !directlyInvalid.includes(index)
        ) {
          directlyInvalid.push(index);
        }
      }
    }

    // Refinements often report the compared sibling rather than the imported
    // value that made a combination invalid. Try one removal at a time across
    // every affected current section, preferring the candidate that preserves
    // the most other valid values. Directly reported candidates win only when
    // two removals have the same validation result.
    const issueOwnerPaths = result.error.issues.flatMap((issue) => (
      issue.path.length <= 1
        ? [[]]
        : Array.from(
            { length: issue.path.length - 1 },
            (_, index) => issue.path.slice(0, index + 1)
          )
    ));
    const relatedCandidates = [...activeCandidates].filter((index) => {
      const candidatePath = candidates[index]!.path;
      return issueOwnerPaths.some((issueOwnerPath) => (
        configPathStartsWith(candidatePath, issueOwnerPath)
        || configPathStartsWith(issueOwnerPath, candidatePath)
      ));
    });
    const fallbackCandidates = [
      ...directlyInvalid,
      ...relatedCandidates.filter((index) => !directlyInvalid.includes(index))
    ];
    if (fallbackCandidates.length === 0) {
      fallbackCandidates.push(...activeCandidates);
    }
    const currentIssueSignatures = new Set(
      result.error.issues.map(configIssueSignature)
    );
    let bestCandidate = fallbackCandidates[0];
    let bestResolvedIssues = -1;
    let bestRemainingIssues = Number.MAX_SAFE_INTEGER;
    let bestIsValid = false;

    for (const index of fallbackCandidates) {
      const trialCandidates = new Set(activeCandidates);
      trialCandidates.delete(index);
      const trial = portableRuntimeConfigSchema.safeParse(configFromCandidates(
        defaults,
        candidates,
        trialCandidates
      ));
      const isValid = trial.success;
      const resolvedIssues = isValid
        ? currentIssueSignatures.size
        : [...currentIssueSignatures].filter((signature) => (
            !trial.error.issues.some(
              (trialIssue) => configIssueSignature(trialIssue) === signature
            )
          )).length;
      const remainingIssues = isValid ? 0 : trial.error.issues.length;
      if (
        (isValid && !bestIsValid)
        || (isValid === bestIsValid && resolvedIssues > bestResolvedIssues)
        || (
          isValid === bestIsValid
          && resolvedIssues === bestResolvedIssues
          && remainingIssues < bestRemainingIssues
        )
      ) {
        bestCandidate = index;
        bestIsValid = isValid;
        bestResolvedIssues = resolvedIssues;
        bestRemainingIssues = remainingIssues;
      }
    }

    if (bestCandidate === undefined) {
      throw new Error("Current portable RuntimeConfig defaults are invalid");
    }
    activeCandidates.delete(bestCandidate);
  }
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
