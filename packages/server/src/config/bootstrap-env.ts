import { join } from "node:path";
import { z } from "zod";
import type { RuntimeConfig } from "@imageshow/shared";
import {
  mergeRuntimeConfig,
  runtimeConfigDefaults,
  type RuntimeConfigPatch
} from "./runtime-config.ts";

const optionalEnvironmentString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().optional()
);

const processEnvironmentSchema = z.object({
  NODE_ENV: z.string().default("development"),
  ADMIN_USERNAME: optionalEnvironmentString,
  ADMIN_PASSWORD: optionalEnvironmentString
});

/** @internal Exported only for local bootstrap-order verification. */
export function parseBootstrapAdminEnvironment(environment: NodeJS.ProcessEnv) {
  const parsed = processEnvironmentSchema.parse(environment);
  return {
    nodeEnvironment: parsed.NODE_ENV,
    adminUsername: parsed.ADMIN_USERNAME,
    adminPassword: parsed.ADMIN_PASSWORD
  };
}

export const bootstrapEnvironment = Object.freeze(parseBootstrapAdminEnvironment(process.env));
const dataDirectory = bootstrapEnvironment.nodeEnvironment === "production"
  ? "/app/data"
  : join(process.cwd(), "data");

export const runtimePaths = Object.freeze({
  configDirectory: dataDirectory,
  storageDirectory: join(dataDirectory, "storage"),
  tempDirectory: join(dataDirectory, "tmp"),
  logDirectory: join(dataDirectory, "log"),
  configFile: join(dataDirectory, "config.json")
});

function environmentValue(name: string) {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

function environmentNumber(name: string) {
  const value = environmentValue(name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number.`);
  return parsed;
}

function environmentBoolean(name: string): boolean | undefined {
  const value = environmentValue(name);
  if (value === undefined) return undefined;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0.`);
}

export function runtimeConfigFromEnvironment(): RuntimeConfig {
  const base = runtimeConfigDefaults();

  const patch: RuntimeConfigPatch = {
    site: {
      name: environmentValue("SITE_NAME"),
      domain: environmentValue("SITE_DOMAIN"),
      icon_url: environmentValue("SITE_ICON_URL"),
      version: {
        enabled: environmentBoolean("SITE_VERSION_ENABLED"),
        link_enabled: environmentBoolean("SITE_VERSION_LINK_ENABLED")
      },
      root_redirect: environmentValue("SITE_ROOT_REDIRECT") as RuntimeConfig["site"]["root_redirect"] | undefined,
      home: {
        enabled: environmentBoolean("SITE_HOME_ENABLED"),
        tagline: environmentValue("SITE_HOME_TAGLINE"),
        hero_background: environmentValue("SITE_HOME_HERO_BACKGROUND"),
        preview_delay_ms: environmentNumber("SITE_HOME_PREVIEW_DELAY_MS")
      },
      gallery: {
        default_limit: environmentNumber("SITE_GALLERY_DEFAULT_LIMIT"),
        order: environmentValue("SITE_GALLERY_ORDER") as RuntimeConfig["site"]["gallery"]["order"] | undefined
      },
      random_default_method: environmentValue("SITE_RANDOM_DEFAULT_METHOD") as RuntimeConfig["site"]["random_default_method"] | undefined,
      random_subdomain: environmentValue("SITE_RANDOM_SUBDOMAIN"),
      static_subdomain: environmentValue("SITE_STATIC_SUBDOMAIN"),
      docs_subdomain: environmentValue("SITE_DOCS_SUBDOMAIN"),
      docs_enabled: environmentBoolean("SITE_DOCS_ENABLED"),
      link_subdomain: environmentValue("SITE_LINK_SUBDOMAIN"),
      robots_enabled: environmentBoolean("SITE_ROBOTS_ENABLED")
    },
    upload: {
      max_items: environmentNumber("UPLOAD_MAX_ITEMS"),
      max_file_size_mb: environmentNumber("UPLOAD_MAX_FILE_SIZE_MB"),
      max_long_edge: environmentNumber("UPLOAD_MAX_LONG_EDGE"),
      list_page_size: environmentNumber("UPLOAD_LIST_PAGE_SIZE"),
      concurrency: environmentNumber("UPLOAD_CONCURRENCY"),
      global_concurrency: environmentNumber("UPLOAD_GLOBAL_CONCURRENCY")
    },
    link_image: {
      fill_original_url: environmentBoolean("LINK_IMAGE_FILL_ORIGINAL_URL"),
      concurrency: environmentNumber("LINK_IMAGE_CONCURRENCY"),
      global_concurrency: environmentNumber("LINK_IMAGE_GLOBAL_CONCURRENCY"),
      fetch_timeout_seconds: environmentNumber("LINK_IMAGE_FETCH_TIMEOUT_SECONDS"),
      max_items: environmentNumber("LINK_IMAGE_MAX_ITEMS")
    },
    weibo: {
      max_items: environmentNumber("WEIBO_MAX_ITEMS"),
      concurrency: environmentNumber("WEIBO_CONCURRENCY"),
      global_concurrency: environmentNumber("WEIBO_GLOBAL_CONCURRENCY")
    },
    normalize: {
      quality: environmentNumber("NORMALIZE_QUALITY"),
      quality_step: environmentNumber("NORMALIZE_QUALITY_STEP"),
      min_quality: environmentNumber("NORMALIZE_MIN_QUALITY"),
      max_long_edge: environmentNumber("NORMALIZE_MAX_LONG_EDGE"),
      max_size_kb: environmentNumber("NORMALIZE_MAX_SIZE_KB"),
      skip_webp_under_kb: environmentNumber("NORMALIZE_SKIP_WEBP_UNDER_KB")
    },
    thumbnail: {
      long_edge: environmentNumber("THUMBNAIL_LONG_EDGE"),
      quality: environmentNumber("THUMBNAIL_QUALITY")
    },
    import: {
      commit_concurrency: environmentNumber("IMPORT_COMMIT_CONCURRENCY"),
      global_commit_concurrency: environmentNumber("IMPORT_GLOBAL_COMMIT_CONCURRENCY"),
      global_commit_byte_budget_mb: environmentNumber(
        "IMPORT_GLOBAL_COMMIT_BYTE_BUDGET_MB"
      )
    },
    image_detail: {
      title_opens_image: environmentBoolean("IMAGE_DETAIL_TITLE_OPENS_IMAGE")
    },
    admin: {
      login_background: environmentValue("ADMIN_LOGIN_BACKGROUND"),
      image_page_size: environmentNumber("ADMIN_IMAGE_PAGE_SIZE"),
      recent_uploads: environmentNumber("ADMIN_RECENT_UPLOADS"),
      show_unset_theme_card: environmentBoolean("ADMIN_SHOW_UNSET_THEME_CARD")
    },
    background_job: {
      move_cleanup_concurrency: environmentNumber("BACKGROUND_JOB_MOVE_CLEANUP_CONCURRENCY"),
      theme_reassign_concurrency: environmentNumber("BACKGROUND_JOB_THEME_REASSIGN_CONCURRENCY"),
      migrate_concurrency: environmentNumber("BACKGROUND_JOB_MIGRATE_CONCURRENCY")
    },
    security: {
      session_ttl_seconds: environmentNumber("SECURITY_SESSION_TTL_SECONDS"),
      login_failure_window_seconds: environmentNumber("SECURITY_LOGIN_FAILURE_WINDOW_SECONDS"),
      login_max_failures: environmentNumber("SECURITY_LOGIN_MAX_FAILURES"),
      login_global_window_seconds: environmentNumber("SECURITY_LOGIN_GLOBAL_WINDOW_SECONDS"),
      login_global_max_attempts: environmentNumber("SECURITY_LOGIN_GLOBAL_MAX_ATTEMPTS")
    },
    altcha: {
      enabled: environmentBoolean("ALTCHA_ENABLED"),
      ttl_seconds: environmentNumber("ALTCHA_TTL_SECONDS"),
      cost: environmentNumber("ALTCHA_COST"),
      counter_min: environmentNumber("ALTCHA_COUNTER_MIN"),
      counter_max: environmentNumber("ALTCHA_COUNTER_MAX")
    },
    log: {
      level: environmentValue("LOG_LEVEL") as RuntimeConfig["log"]["level"] | undefined,
      max_size_mb: environmentNumber("LOG_MAX_SIZE_MB"),
      max_files: environmentNumber("LOG_MAX_FILES")
    }
  };

  return mergeRuntimeConfig(base, patch);
}
