export const appConfig = {
  uploadDefaultMaxFileSizeMb: 15,
  imageMaxLongEdge: 8192,
  uploadListPageSize: 20,
  adminImagePageSize: 50,
  devices: ["pc", "mb", "none"] as const,
  brightness: ["dark", "light", "none"] as const,
  themeMaxLength: 32,
  categoryIndexDigits: 6,
  pagination: {
    defaultLimit: 50,
    maxLimit: 200
  },
  randomMissRetries: 3,
  trashBatchSize: 100,
  sessionTtlSeconds: 7 * 24 * 60 * 60,
  uploadTtlSeconds: 10 * 60,
  s3CheckTimeoutMs: 15_000,
  folderMapTtlSeconds: 60 * 60,
  pgPool: {
    max: 10,
    idleTimeoutMillis: 30000,
    // Fail fast instead of hanging when the database is unreachable, and recycle
    // long-lived connections so a backend restart or network blip self-heals.
    connectionTimeoutMillis: 10000,
    maxLifetimeSeconds: 30 * 60
  },
  operationLog: {
    maxRetries: 5,
    retryBackoffSeconds: [60, 300, 900, 3600, 21600],
    taskTimeoutSeconds: 15 * 60,
    // Run zombie-task recovery and upload expiry on their own slow cadence rather
    // than every fast tick, to avoid idle periodic database writes. (Max tasks per
    // tick is a file-only runtime setting: config.json operation_log.max_tasks_per_tick.)
    staleRecoveryIntervalMs: 60_000,
    expireUploadsIntervalMs: 60_000
  },
  thumbnail: {
    longEdge: 512,
    quality: 78
  }
};

export const adminBasePath = "/admin";
export const adminApiBasePath = "/api/admin";
export const adminImagePageLimit = appConfig.adminImagePageSize;

// Default reserved subdomain prefixes (random.<domain>, static.<domain>). The
// server's authoritative copy lives in config.json (site.random_subdomain /
// site.static_subdomain); the frontend uses these defaults to warn when a theme
// name would collide with a reserved subdomain.
export const reservedSubdomains = ["random", "static"] as const;

export type Device = (typeof appConfig.devices)[number];
export type Brightness = (typeof appConfig.brightness)[number];
export type ImageExt = "jpg" | "png" | "webp" | "gif" | "avif";

export function categoryKey(device: Device, brightness: Brightness, theme: string) {
  return `${device}-${brightness}-${theme}`;
}

export function indexKey(category: string, index: number) {
  return `${category}-${String(index).padStart(appConfig.categoryIndexDigits, "0")}`;
}
