export const appConfig = {
  // ───────────────────────── Compile-time constants ─────────────────────────
  // Not runtime-configurable (no config.json field). The user-overridable defaults
  // live in `runtimeDefaults` further down.

  // Domain vocabulary shared by web + server — drives the Device/Brightness types
  // and the category-key format.
  devices: ["pc", "mb"] as const,
  brightness: ["dark", "light"] as const,
  themeMaxLength: 32,
  categoryIndexDigits: 6,
  // Hard ceiling for any page-size request (gallery / admin list); a fixed validation
  // cap, not a user default. The default page sizes are runtimeDefaults.gallery /
  // runtimeDefaults.admin.
  pagination: {
    maxLimit: 200
  },
  randomMissRetries: 3,
  // Short-term no-repeat for the public random API: per viewer + filter, remember
  // the last `historySize` served images for `ttlSeconds` and re-roll up to
  // `maxAttempts` times to avoid them (best-effort; smaller pools may still repeat).
  randomDedupe: {
    historySize: 30,
    ttlSeconds: 15 * 60,
    maxAttempts: 8
  },
  // One-time fetch budget when importing a link image (downloaded once to make its
  // thumbnail and read dimensions; the original itself is never stored, only linked).
  linkImport: { fetchTimeoutMs: 15_000 },
  trashBatchSize: 100,
  // Rows per page when scanning the whole table to backfill missing md5 (maintenance.ts).
  md5BackfillBatchSize: 100,
  uploadTtlSeconds: 10 * 60,
  folderMapTtlSeconds: 60 * 60,
  pgPool: {
    max: 20,
    idleTimeoutMillis: 30000,
    // Fail fast instead of hanging when the database is unreachable, and recycle
    // long-lived connections so a backend restart or network blip self-heals.
    connectionTimeoutMillis: 10000,
    maxLifetimeSeconds: 30 * 60
  },
  // Background-worker internals (poll cadence / retry / shutdown bounds). The per-task-type
  // concurrency that *is* user-tunable lives in runtimeDefaults.operation_log instead.
  operationLog: {
    maxRetries: 5,
    retryBackoffSeconds: [60, 300, 900, 3600, 21600],
    taskTimeoutSeconds: 15 * 60,
    // Run zombie-task recovery and upload expiry on their own slow cadence rather
    // than every fast tick, to avoid idle periodic database writes.
    staleRecoveryIntervalMs: 60_000,
    expireUploadsIntervalMs: 60_000,
    // Worker poll cadence, plus the graceful-shutdown bounds: how long a final drain waits
    // for the in-flight tick, and the hard-exit backstop if shutdown otherwise hangs.
    tickIntervalMs: 5_000,
    drainTimeoutMs: 10_000,
    shutdownHardExitMs: 15_000,
    // How many in-flight / failed operation_log rows the database check surfaces.
    sampleLimit: 100
  },

  // ─────────────────────── Runtime config defaults ──────────────────────────
  // Single source of truth for every config.json default. This object mirrors
  // config.json one-for-one (same nesting, same snake_case field names, same values),
  // so a default lives in exactly one place:
  //   • the runtime schema (server/config/env.ts) seeds each .default() from here,
  //   • the admin settings API (server/config/settings.ts) reuses the same values,
  //   • config.example.jsonc documents the identical tree for operators.
  // Edit a default HERE and env.ts / settings.ts stay purely structural (validators
  // only). `as const` narrows the string literals so the zod enum defaults
  // (root_redirect / gallery.order / random.default_method) type-check.
  runtimeDefaults: {
    site: {
      name: "ImageShow",
      domain: "example.com",
      icon_url: "/assets/brand/favicon.svg",
      root_redirect: "home",
      home_enabled: true,
      login_background: "",
      home_hero_background: "",
      random_subdomain: "random",
      static_subdomain: "static",
      docs_subdomain: "docs",
      docs_enabled: true,
      link_subdomain: "link",
      robots_enabled: false
    },
    port: 5518,
    database: { port: 5432 },
    redis: { host: "redis", port: 6379, db: 0 },
    home: { preview_delay_ms: 1000 },
    upload: { max_file_size_mb: 15, max_long_edge: 8192, list_page_size: 20, concurrency: 2 },
    admin: { image_page_size: 60, recent_uploads: 12, show_unset_theme_card: true },
    gallery: { default_limit: 60, order: "random" },
    random: { default_method: "redirect" },
    image_detail: { title_opens_image: true },
    link_image: { fill_original_url: false },
    operation_log: {
      move_cleanup_concurrency: 5,
      theme_reassign_concurrency: 5,
      migrate_concurrency: 5
    },
    security: {
      session_ttl_seconds: 7 * 24 * 60 * 60,
      login_failure_window_seconds: 60,
      login_max_failures: 5,
      login_global_window_seconds: 180,
      login_global_max_attempts: 10
    },
    thumbnail: { long_edge: 512, quality: 75 },
    captcha: { enabled: true, code_length: 6, ttl_seconds: 60, noise_lines: 8, noise_dots: 50 },
    log: { level: "WARN", max_size_mb: 10, max_files: 5 }
  } as const
};

// Lowercase-ASCII slug shape shared by theme / tag / author / storage-backend slugs and
// validated identically on the frontend: a-z/0-9 with internal hyphens, no leading or
// trailing hyphen, at least one char. Per-field length caps are applied separately.
export const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const adminBasePath = "/admin";
export const adminApiBasePath = "/api/admin";
export const adminImagePageLimit: number = appConfig.runtimeDefaults.admin.image_page_size;

// Default reserved subdomain prefixes (random.<domain>, static.<domain>,
// docs.<domain>, link.<domain>). The server's authoritative copy lives in config.json
// (site.random_subdomain / static_subdomain / docs_subdomain / link_subdomain); the
// frontend uses these defaults to warn when a theme name would collide with a reserved
// subdomain.
export const reservedSubdomains = ["random", "static", "docs", "link"] as const;

export type Device = (typeof appConfig.devices)[number];
export type Brightness = (typeof appConfig.brightness)[number];
export type ImageExt = "jpg" | "png" | "webp" | "gif" | "avif";

export function categoryKey(device: Device, brightness: Brightness, theme: string) {
  return `${device}-${brightness}-${theme}`;
}

export function indexKey(category: string, index: number) {
  return `${category}-${String(index).padStart(appConfig.categoryIndexDigits, "0")}`;
}
