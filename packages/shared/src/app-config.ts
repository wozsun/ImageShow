export const appConfig = {
  devices: ["pc", "mb"] as const,
  brightness: ["dark", "light"] as const,
  themeMaxLength: 32,

  pagination: {
    maxLimit: 200
  },

  randomDedupe: {
    historySize: 30,
    ttlSeconds: 15 * 60,
    maxAttempts: 8
  },

  linkImport: { fetchTimeoutMs: 15_000 },
  trashBatchSize: 100,

  uploadTtlSeconds: 10 * 60,
  folderMapTtlSeconds: 60 * 60,
  pgPool: {
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    maxLifetimeSeconds: 30 * 60
  },

  backgroundJob: {
    maxRetries: 5,
    retryBackoffSeconds: [60, 300, 900, 3600, 21600],
    taskTimeoutSeconds: 15 * 60,
    staleRecoveryIntervalMs: 60_000,
    expireUploadsIntervalMs: 60_000,
    tickIntervalMs: 5_000,
    drainTimeoutMs: 10_000,
    shutdownHardExitMs: 15_000,

    sampleLimit: 100
  },

  runtimeDefaults: {
    site: {
      name: "ImageShow",
      domain: "example.com",
      icon_url: "/assets/brand/favicon.svg",
      root_redirect: "home",
      home: {
        enabled: true,
        tagline: "个人图片管理、画廊展示和随机图片 API。",
        hero_background: "",
        preview_delay_ms: 1000
      },
      gallery: { default_limit: 60, order: "random" },
      random_default_method: "redirect",
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
    upload: {
      max_file_size_mb: 15,
      max_long_edge: 8192,
      list_page_size: 20,
      concurrency: 2
    },
    link_image: {
      fill_original_url: false,
      concurrency: 2
    },
    normalize: {
      quality: 80,
      quality_step: 5,
      min_quality: 20,
      max_long_edge: 4500,
      max_size_kb: 500,
      skip_webp_under_kb: 700
    },
    thumbnail: { long_edge: 512, quality: 75 },
    image_detail: { title_opens_image: true },
    admin: {
      login_background: "",
      image_page_size: 60,
      recent_uploads: 12,
      show_unset_theme_card: true
    },
    background_job: {
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
    captcha: { enabled: true, code_length: 6, ttl_seconds: 60, noise_lines: 8, noise_dots: 50 },
    log: { level: "WARN", max_size_mb: 10, max_files: 5 }
  } as const
};

export const slugPattern = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const adminBasePath = "/admin";
export const adminApiBasePath = "/api/admin";
export const adminImagePageLimit: number = appConfig.runtimeDefaults.admin.image_page_size;

export const reservedSubdomains = ["random", "static", "docs", "link"] as const;

export type Device = (typeof appConfig.devices)[number];
export type Brightness = (typeof appConfig.brightness)[number];
export type ImageExt = "jpg" | "png" | "webp" | "gif" | "avif";
export type StorageType = "local" | "s3" | "webdav";
export type RootRedirect = "home" | "gallery";
export type RandomMethod = "proxy" | "redirect";
export type GalleryOrder = "latest" | "random";
export type ImportMode = "upload" | "download" | "proxy";

export type SiteHomeSettings = {
  enabled: boolean;
  tagline: string;
  hero_background: string;
  preview_delay_ms: number;
};

export type SiteGallerySettings = {
  default_limit: number;
  order: GalleryOrder;
};

export type RuntimeSiteSettings = {
  name: string;
  domain: string;
  icon_url: string;
  root_redirect: RootRedirect;
  home: SiteHomeSettings;
  gallery: SiteGallerySettings;
  random_default_method: RandomMethod;
  random_subdomain: string;
  static_subdomain: string;
  docs_subdomain: string;
  docs_enabled: boolean;
  link_subdomain: string;
  robots_enabled: boolean;
};

export type UploadSettings = {
  max_file_size_mb: number;
  max_long_edge: number;
  list_page_size: number;
  concurrency: number;
};

export type LinkImageSettings = {
  fill_original_url: boolean;
  concurrency: number;
};

export type NormalizeSettings = {
  quality: number;
  quality_step: number;
  min_quality: number;
  max_long_edge: number;
  max_size_kb: number;
  skip_webp_under_kb: number;
};

export type ThumbnailSettings = {
  long_edge: number;
  quality: number;
};

export type ImageDetailSettings = {
  title_opens_image: boolean;
};

export type AdminPanelSettings = {
  login_background: string;
  image_page_size: number;
  recent_uploads: number;
  show_unset_theme_card: boolean;
};

export type RuntimeConfig = {
  site: RuntimeSiteSettings;
  port: number;
  database: { host: string; port: number; name: string; user: string; password: string };
  redis: { host: string; port: number; db: number };
  upload: UploadSettings;
  link_image: LinkImageSettings;
  normalize: NormalizeSettings;
  thumbnail: ThumbnailSettings;
  image_detail: ImageDetailSettings;
  admin: AdminPanelSettings;
  background_job: {
    move_cleanup_concurrency: number;
    theme_reassign_concurrency: number;
    migrate_concurrency: number;
  };
  security: {
    session_ttl_seconds: number;
    login_failure_window_seconds: number;
    login_max_failures: number;
    login_global_window_seconds: number;
    login_global_max_attempts: number;
  };
  captcha: {
    enabled: boolean;
    code_length: number;
    ttl_seconds: number;
    noise_lines: number;
    noise_dots: number;
  };
  log: { level: "DEBUG" | "INFO" | "WARN" | "ERROR" | "OFF"; max_size_mb: number; max_files: number };
};

export type SiteSettings = Pick<RuntimeSiteSettings, "name" | "domain" | "icon_url" | "root_redirect" | "home" | "gallery" | "random_default_method" | "docs_enabled">;

export type AdminSettings = {
  site: SiteSettings;
  upload: UploadSettings;
  link_image: LinkImageSettings;
  normalize: NormalizeSettings;
  thumbnail: ThumbnailSettings;
  image_detail: ImageDetailSettings;
  admin: AdminPanelSettings;
};
