import {
  adminImagePageLimit,
  altchaSolveTimeoutMs,
  brightnesses,
  devices,
  imageDescriptionMaxLength,
  imageTitleMaxLength,
  importBatchHardLimit
} from "./browser.ts";

export * from "./browser.ts";

export const appConfig = {
  // Container-internal HTTP port. Keep Dockerfile and Compose target ports in sync.
  applicationPort: 5518,
  devices,
  brightness: brightnesses,
  themeMaxLength: 32,
  imageMetadata: {
    titleMaxLength: imageTitleMaxLength,
    descriptionMaxLength: imageDescriptionMaxLength
  },

  pagination: {
    maxLimit: 200
  },

  randomDedupe: {
    historySize: 30,
    ttlSeconds: 15 * 60,
    maxAttempts: 8
  },

  trashBatchSize: 100,

  imports: {
    batchHardLimit: importBatchHardLimit,
    uploadSoftLimitMax: 1_000,
    linkSoftLimitMax: 1_000,
    weiboSoftLimitMax: 50,
    weiboImageHardLimit: 1_000,
    weiboRequestBodyMaxBytes: 1024 * 1024,
    jsonlManifestMaxBytes: 128 * 1024 * 1024,
    configPackageMaxBytes: 1024 * 1024,
    configPackageMaxBackends: 100
  },

  uploadTtlSeconds: 30 * 60,
  derivedCacheTtlSeconds: 60 * 60,
  imageLookup: {
    ttlSeconds: 6 * 60 * 60
  },
  pgPool: {
    max: 30,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    maxLifetimeSeconds: 30 * 60
  },

  authentication: {
    altcha: {
      // Give ordinary clients up to one minute to solve a challenge. Keep the
      // configurable work bounded so a challenge cannot run for several minutes.
      solveTimeoutMs: altchaSolveTimeoutMs,
      challengeExpirySafetySeconds: 30,
      maximumWorkFactor: 100_000_000
    }
  },

  backgroundJob: {
    maxRetries: 5,
    retryBackoffSeconds: [60, 300, 900, 3600, 21600],
    taskTimeoutSeconds: 15 * 60,
    staleRecoveryIntervalMs: 60_000,
    expireUploadsIntervalMs: 60_000,
    historyCleanupIntervalMs: 60 * 60 * 1000,
    completedRetentionSeconds: 7 * 24 * 60 * 60,
    failedRetentionSeconds: 90 * 24 * 60 * 60,
    historyCleanupBatchSize: 1000,
    tickIntervalMs: 5_000,
    queueSliceMaxJobs: 50,
    queueSliceMaxMs: 2_000,
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
    upload: {
      max_items: 200,
      max_file_size_mb: 100,
      max_long_edge: 32000,
      list_page_size: 20,
      concurrency: 2,
      global_concurrency: 5
    },
    link_image: {
      fill_original_url: false,
      concurrency: 2,
      global_concurrency: 5,
      fetch_timeout_seconds: 30,
      max_items: 200
    },
    weibo: {
      max_items: 20,
      concurrency: 2,
      global_concurrency: 5,
      author_slugs: {} as Record<string, string>
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
    import: {
      commit_concurrency: 5,
      global_commit_concurrency: 10,
      global_commit_byte_budget_mb: 512
    },
    image_detail: { title_opens_image: true },
    admin: {
      login_background: "",
      image_page_size: adminImagePageLimit,
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
    altcha: {
      enabled: true,
      ttl_seconds: 5 * 60,
      cost: 5000,
      counter_min: 2000,
      counter_max: 5000
    },
    log: { level: "WARN", max_size_mb: 10, max_files: 5 }
  } as const
};

export type ImageExt = "jpg" | "png" | "webp" | "gif" | "avif";
export type RootRedirect = "home" | "gallery";
export type RandomMethod = "proxy" | "redirect";
export type GalleryOrder = "latest" | "random";
export type ImportMode = "upload" | "download";
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
  max_items: number;
  max_file_size_mb: number;
  max_long_edge: number;
  list_page_size: number;
  concurrency: number;
  global_concurrency: number;
};

export type LinkImageSettings = {
  fill_original_url: boolean;
  concurrency: number;
  global_concurrency: number;
  fetch_timeout_seconds: number;
  max_items: number;
};

export type WeiboSettings = {
  max_items: number;
  concurrency: number;
  global_concurrency: number;
  author_slugs: Record<string, string>;
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

export type ImportSettings = {
  commit_concurrency: number;
  global_commit_concurrency: number;
  global_commit_byte_budget_mb: number;
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
  upload: UploadSettings;
  link_image: LinkImageSettings;
  weibo: WeiboSettings;
  normalize: NormalizeSettings;
  thumbnail: ThumbnailSettings;
  import: ImportSettings;
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
  altcha: {
    enabled: boolean;
    ttl_seconds: number;
    cost: number;
    counter_min: number;
    counter_max: number;
  };
  log: { level: "DEBUG" | "INFO" | "WARN" | "ERROR" | "OFF"; max_size_mb: number; max_files: number };
};

export type SiteSettings = Pick<RuntimeSiteSettings, "name" | "domain" | "icon_url" | "root_redirect" | "home" | "gallery" | "random_default_method" | "docs_enabled">;

export type AdminUploadSettings = Pick<
  UploadSettings,
  "max_items" | "max_file_size_mb" | "list_page_size" | "concurrency"
>;

export type AdminLinkImageSettings = Pick<
  LinkImageSettings,
  "fill_original_url" | "concurrency" | "max_items"
>;

export type AdminWeiboSettings = Pick<WeiboSettings, "max_items">;

export type AdminImportSettings = Pick<ImportSettings, "commit_concurrency">;

export type AdminSettings = {
  site: SiteSettings;
  upload: AdminUploadSettings;
  link_image: AdminLinkImageSettings;
  weibo: AdminWeiboSettings;
  normalize: NormalizeSettings;
  thumbnail: ThumbnailSettings;
  import: AdminImportSettings;
  image_detail: ImageDetailSettings;
  admin: AdminPanelSettings;
};
