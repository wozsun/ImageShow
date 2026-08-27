import { z } from "zod";
import type { RuntimeConfig } from "@imageshow/shared/browser";
import {
  mergeRuntimeConfig,
  runtimeConfigDefaults,
  type RuntimeConfigPatch
} from "./runtime-config.ts";

type RuntimeConfigLeafPath<T = RuntimeConfig> = {
  [K in keyof T & string]: T[K] extends readonly unknown[]
    ? K
    : T[K] extends Record<string, unknown>
      ? string extends keyof T[K]
        ? K
        : `${K}.${RuntimeConfigLeafPath<T[K]>}`
      : K;
}[keyof T & string];

type RuntimeConfigEnvironmentValueKind =
  | "string"
  | "number"
  | "boolean"
  | "json-array"
  | "json-object";

type RuntimeConfigEnvironmentBinding = {
  path: RuntimeConfigLeafPath;
  environmentVariable: string;
  valueKind: RuntimeConfigEnvironmentValueKind;
};

export const runtimeConfigEnvironmentBindings = [
  { path: "site.name", environmentVariable: "SITE_NAME", valueKind: "string" },
  { path: "site.domain", environmentVariable: "SITE_DOMAIN", valueKind: "string" },
  { path: "site.description", environmentVariable: "SITE_DESCRIPTION", valueKind: "string" },
  { path: "site.icon_url", environmentVariable: "SITE_ICON_URL", valueKind: "string" },
  { path: "site.version.enabled", environmentVariable: "SITE_VERSION_ENABLED", valueKind: "boolean" },
  { path: "site.version.link_enabled", environmentVariable: "SITE_VERSION_LINK_ENABLED", valueKind: "boolean" },
  { path: "site.root", environmentVariable: "SITE_ROOT", valueKind: "string" },
  { path: "site.home.enabled", environmentVariable: "SITE_HOME_ENABLED", valueKind: "boolean" },
  { path: "site.home.background", environmentVariable: "SITE_HOME_BACKGROUND", valueKind: "string" },
  { path: "site.home.banner_label", environmentVariable: "SITE_HOME_BANNER_LABEL", valueKind: "string" },
  { path: "site.home.banner_title", environmentVariable: "SITE_HOME_BANNER_TITLE", valueKind: "string" },
  { path: "site.gallery.default_limit", environmentVariable: "SITE_GALLERY_DEFAULT_LIMIT", valueKind: "number" },
  { path: "site.gallery.order", environmentVariable: "SITE_GALLERY_ORDER", valueKind: "string" },
  { path: "site.random_default_method", environmentVariable: "SITE_RANDOM_DEFAULT_METHOD", valueKind: "string" },
  { path: "site.static_subdomain", environmentVariable: "SITE_STATIC_SUBDOMAIN", valueKind: "string" },
  { path: "site.robots_enabled", environmentVariable: "SITE_ROBOTS_ENABLED", valueKind: "boolean" },
  { path: "embed.enabled", environmentVariable: "EMBED_ENABLED", valueKind: "boolean" },
  { path: "embed.allowed_origins", environmentVariable: "EMBED_ALLOWED_ORIGINS", valueKind: "json-array" },
  { path: "ingestion.commit_concurrency", environmentVariable: "INGESTION_COMMIT_CONCURRENCY", valueKind: "number" },
  { path: "ingestion.global_commit_concurrency", environmentVariable: "INGESTION_GLOBAL_COMMIT_CONCURRENCY", valueKind: "number" },
  { path: "ingestion.global_commit_byte_budget_mb", environmentVariable: "INGESTION_GLOBAL_COMMIT_BYTE_BUDGET_MB", valueKind: "number" },
  { path: "upload.max_items", environmentVariable: "UPLOAD_MAX_ITEMS", valueKind: "number" },
  { path: "upload.max_file_size_mb", environmentVariable: "UPLOAD_MAX_FILE_SIZE_MB", valueKind: "number" },
  { path: "upload.max_long_edge", environmentVariable: "UPLOAD_MAX_LONG_EDGE", valueKind: "number" },
  { path: "upload.list_page_size", environmentVariable: "UPLOAD_LIST_PAGE_SIZE", valueKind: "number" },
  { path: "upload.concurrency", environmentVariable: "UPLOAD_CONCURRENCY", valueKind: "number" },
  { path: "upload.global_concurrency", environmentVariable: "UPLOAD_GLOBAL_CONCURRENCY", valueKind: "number" },
  { path: "import.fill_original_url", environmentVariable: "IMPORT_FILL_ORIGINAL_URL", valueKind: "boolean" },
  { path: "import.auto_import", environmentVariable: "IMPORT_AUTO_IMPORT", valueKind: "boolean" },
  { path: "import.concurrency", environmentVariable: "IMPORT_CONCURRENCY", valueKind: "number" },
  { path: "import.global_concurrency", environmentVariable: "IMPORT_GLOBAL_CONCURRENCY", valueKind: "number" },
  { path: "import.fetch_timeout_seconds", environmentVariable: "IMPORT_FETCH_TIMEOUT_SECONDS", valueKind: "number" },
  { path: "import.max_items", environmentVariable: "IMPORT_MAX_ITEMS", valueKind: "number" },
  { path: "weibo.max_items", environmentVariable: "WEIBO_MAX_ITEMS", valueKind: "number" },
  { path: "weibo.concurrency", environmentVariable: "WEIBO_CONCURRENCY", valueKind: "number" },
  { path: "weibo.global_concurrency", environmentVariable: "WEIBO_GLOBAL_CONCURRENCY", valueKind: "number" },
  { path: "weibo.author_slugs", environmentVariable: "WEIBO_AUTHOR_SLUGS", valueKind: "json-object" },
  { path: "normalize.quality", environmentVariable: "NORMALIZE_QUALITY", valueKind: "number" },
  { path: "normalize.quality_step", environmentVariable: "NORMALIZE_QUALITY_STEP", valueKind: "number" },
  { path: "normalize.min_quality", environmentVariable: "NORMALIZE_MIN_QUALITY", valueKind: "number" },
  { path: "normalize.max_long_edge", environmentVariable: "NORMALIZE_MAX_LONG_EDGE", valueKind: "number" },
  { path: "normalize.max_size_kb", environmentVariable: "NORMALIZE_MAX_SIZE_KB", valueKind: "number" },
  { path: "normalize.skip_webp_under_kb", environmentVariable: "NORMALIZE_SKIP_WEBP_UNDER_KB", valueKind: "number" },
  { path: "thumbnail.long_edge", environmentVariable: "THUMBNAIL_LONG_EDGE", valueKind: "number" },
  { path: "thumbnail.quality", environmentVariable: "THUMBNAIL_QUALITY", valueKind: "number" },
  { path: "admin.login_background", environmentVariable: "ADMIN_LOGIN_BACKGROUND", valueKind: "string" },
  { path: "admin.image_page_size", environmentVariable: "ADMIN_IMAGE_PAGE_SIZE", valueKind: "number" },
  { path: "admin.recent_uploads", environmentVariable: "ADMIN_RECENT_UPLOADS", valueKind: "number" },
  { path: "admin.show_unset_theme_card", environmentVariable: "ADMIN_SHOW_UNSET_THEME_CARD", valueKind: "boolean" },
  { path: "background_job.move_cleanup_concurrency", environmentVariable: "BACKGROUND_JOB_MOVE_CLEANUP_CONCURRENCY", valueKind: "number" },
  { path: "background_job.theme_reassign_concurrency", environmentVariable: "BACKGROUND_JOB_THEME_REASSIGN_CONCURRENCY", valueKind: "number" },
  { path: "background_job.migrate_concurrency", environmentVariable: "BACKGROUND_JOB_MIGRATE_CONCURRENCY", valueKind: "number" },
  { path: "security.session_ttl_seconds", environmentVariable: "SECURITY_SESSION_TTL_SECONDS", valueKind: "number" },
  { path: "security.login_failure_window_seconds", environmentVariable: "SECURITY_LOGIN_FAILURE_WINDOW_SECONDS", valueKind: "number" },
  { path: "security.login_max_failures", environmentVariable: "SECURITY_LOGIN_MAX_FAILURES", valueKind: "number" },
  { path: "security.login_global_window_seconds", environmentVariable: "SECURITY_LOGIN_GLOBAL_WINDOW_SECONDS", valueKind: "number" },
  { path: "security.login_global_max_attempts", environmentVariable: "SECURITY_LOGIN_GLOBAL_MAX_ATTEMPTS", valueKind: "number" },
  { path: "altcha.enabled", environmentVariable: "ALTCHA_ENABLED", valueKind: "boolean" },
  { path: "altcha.ttl_seconds", environmentVariable: "ALTCHA_TTL_SECONDS", valueKind: "number" },
  { path: "altcha.cost", environmentVariable: "ALTCHA_COST", valueKind: "number" },
  { path: "altcha.counter_min", environmentVariable: "ALTCHA_COUNTER_MIN", valueKind: "number" },
  { path: "altcha.counter_max", environmentVariable: "ALTCHA_COUNTER_MAX", valueKind: "number" },
  { path: "log.level", environmentVariable: "LOG_LEVEL", valueKind: "string" },
  { path: "log.max_size_mb", environmentVariable: "LOG_MAX_SIZE_MB", valueKind: "number" },
  { path: "log.max_files", environmentVariable: "LOG_MAX_FILES", valueKind: "number" }
] as const satisfies readonly RuntimeConfigEnvironmentBinding[];

function strictJsonValue(source: string) {
  let index = 0;

  function fail(message: string): never {
    throw new Error(`${message} at character ${index + 1}`);
  }

  function skipWhitespace() {
    while (/\s/.test(source[index] ?? "")) index += 1;
  }

  function consumeString() {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        index += 1;
        try {
          return JSON.parse(source.slice(start, index)) as string;
        } catch (error) {
          throw new Error(
            `invalid JSON string at character ${start + 1}: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      } else if (character.charCodeAt(0) < 0x20) {
        fail("unescaped control character in JSON string");
      }
      index += 1;
    }
    fail("unterminated JSON string");
  }

  function consumeLiteral(literal: string) {
    if (source.slice(index, index + literal.length) !== literal) {
      fail(`expected ${literal}`);
    }
    index += literal.length;
  }

  function consumeNumber() {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(
      source.slice(index)
    );
    if (!match) fail("invalid JSON number");
    index += match[0].length;
  }

  function consumeArray() {
    index += 1;
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }
    while (index < source.length) {
      consumeValue();
      skipWhitespace();
      if (source[index] === "]") {
        index += 1;
        return;
      }
      if (source[index] !== ",") fail("expected ',' or ']' in JSON array");
      index += 1;
      skipWhitespace();
    }
    fail("unterminated JSON array");
  }

  function consumeObject() {
    index += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (source[index] === "}") {
      index += 1;
      return;
    }
    while (index < source.length) {
      if (source[index] !== "\"") fail("expected a quoted JSON object key");
      const key = consumeString();
      if (key === "__proto__") {
        throw new Error('JSON object key "__proto__" is not allowed');
      }
      if (keys.has(key)) throw new Error(`duplicate JSON object key ${JSON.stringify(key)}`);
      keys.add(key);
      skipWhitespace();
      if (source[index] !== ":") fail("expected ':' after JSON object key");
      index += 1;
      consumeValue();
      skipWhitespace();
      if (source[index] === "}") {
        index += 1;
        return;
      }
      if (source[index] !== ",") fail("expected ',' or '}' in JSON object");
      index += 1;
      skipWhitespace();
    }
    fail("unterminated JSON object");
  }

  function consumeValue() {
    skipWhitespace();
    const character = source[index];
    if (character === "\"") consumeString();
    else if (character === "[") consumeArray();
    else if (character === "{") consumeObject();
    else if (character === "t") consumeLiteral("true");
    else if (character === "f") consumeLiteral("false");
    else if (character === "n") consumeLiteral("null");
    else consumeNumber();
  }

  consumeValue();
  skipWhitespace();
  if (index !== source.length) fail("unexpected trailing JSON content");
  return JSON.parse(source) as unknown;
}

function parseEnvironmentValue(
  binding: RuntimeConfigEnvironmentBinding,
  value: string
) {
  if (binding.valueKind === "string") return value;
  if (binding.valueKind === "number") {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
      throw new Error("must be a JSON-formatted finite number without surrounding whitespace");
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error("must be a finite number");
    return parsed;
  }
  if (binding.valueKind === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
    throw new Error("must be true or false");
  }

  const parsed = strictJsonValue(value);
  if (binding.valueKind === "json-array" && !Array.isArray(parsed)) {
    throw new Error("must be a JSON array");
  }
  if (
    binding.valueKind === "json-object"
    && (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
  ) {
    throw new Error("must be a JSON object");
  }
  return parsed;
}

function setPatchValue(
  patch: RuntimeConfigPatch,
  path: RuntimeConfigLeafPath,
  value: unknown
) {
  const segments = path.split(".");
  let target = patch as Record<string, unknown>;
  for (const segment of segments.slice(0, -1)) {
    const existing = target[segment];
    const nested = existing !== null
      && typeof existing === "object"
      && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
    if (nested !== existing) target[segment] = nested;
    target = nested;
  }
  target[segments.at(-1)!] = value;
}

function issueBinding(path: PropertyKey[]) {
  const issuePath = path.map(String).join(".");
  return runtimeConfigEnvironmentBindings.find(
    (binding) => issuePath === binding.path || issuePath.startsWith(`${binding.path}.`)
  );
}

export function runtimeConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const patch: RuntimeConfigPatch = {};
  const configuredBindings: RuntimeConfigEnvironmentBinding[] = [];

  for (const binding of runtimeConfigEnvironmentBindings) {
    const value = environment[binding.environmentVariable];
    if (value === undefined) continue;
    configuredBindings.push(binding);
    try {
      setPatchValue(patch, binding.path, parseEnvironmentValue(binding, value));
    } catch (error) {
      throw new Error(
        `Invalid ${binding.environmentVariable} for RuntimeConfig path ${binding.path}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  try {
    return mergeRuntimeConfig(runtimeConfigDefaults(), patch);
  } catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    const configured = configuredBindings
      .map(({ environmentVariable, path }) => `${environmentVariable} (${path})`)
      .join(", ");
    const issues = error.issues.map((issue) => {
      const path = issue.path.map(String).join(".") || "<root>";
      const binding = issueBinding(issue.path);
      return `${binding?.environmentVariable ?? "<no environment binding>"} (${path}): ${issue.message}`;
    }).join("; ");
    throw new Error(
      `Invalid RuntimeConfig environment seed from ${configured || "<defaults>"}: ${issues}`,
      { cause: error }
    );
  }
}
