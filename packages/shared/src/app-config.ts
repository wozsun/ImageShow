import {
  adminImagePageLimit,
  altchaSolveTimeoutMs,
  brightnesses,
  configPackageMaxBytes,
  devices,
  imageDescriptionMaxLength,
  imageTitleMaxLength,
  ingestionBatchHardLimit,
  ingestionQueueSnapshotMaxItems,
  slugMaxLength
} from "./browser/common.ts";

export const appConfig = {
  // Container-internal HTTP port. Keep Dockerfile and Compose target ports in sync.
  applicationPort: 5518,
  devices,
  brightnesses,
  themeMaxLength: slugMaxLength,
  imageMetadata: {
    titleMaxLength: imageTitleMaxLength,
    descriptionMaxLength: imageDescriptionMaxLength
  },

  pagination: {
    maxLimit: 200
  },

  randomDedupe: {
    historySize: 30,
    ttlSeconds: 15 * 60
  },

  randomQuery: {
    maxRawBytes: 4 * 1024,
    maxSelectorCount: 64,
    maxSelectorsPerField: 32,
    maxSelectorCharacters: 64,
    maxJsonItems: 200
  },

  trashBatchSize: 100,

  ingestion: {
    batchHardLimit: ingestionBatchHardLimit,
    maxInputFileSizeMiB: 200,
    uploadSoftLimitMax: 1_000,
    importSoftLimitMax: 1_000,
    weiboSoftLimitMax: 50,
    weiboImageHardLimit: 1_000,
    weiboRequestBodyMaxBytes: 1024 * 1024,
    jsonlManifestMaxBytes: 128 * 1024 * 1024,
    configPackageMaxBytes,
    configPackageMaxBackends: 100
  },

  ingestionRuntime: {
    uploadIntentTtlSeconds: 30 * 60,
    uploadSessionIdleTtlSeconds: 2 * 60 * 60,
    importSessionIdleTtlSeconds: 24 * 60 * 60,
    uploadClaimStaleSeconds: 2 * 60,
    workerHeartbeatSeconds: 30,
    expiryScanBatchSize: 100,
    recoveryScanBatchSize: 100,
    snapshotMaxItems: ingestionQueueSnapshotMaxItems,
    snapshotStaleReceiptCleanupBudget: 200,
    queueActionBatchSize: 100,
    orphanCleanupIntervalSeconds: 60,
    orphanCleanupSafetySeconds: 60,
    orphanCleanupCycleTimeoutSeconds: 50,
    orphanCleanupMaxStorageBackends: 32,
    orphanCleanupMaxStagingKeysPerCycle: 3_200_000,
    orphanCleanupMaxRawEntriesPerCycle: 100_000,
    orphanCleanupMaxReferenceItems: 100_000,
    retiredCleanupMaxAttempts: 8,
    tokenMaxBytes: 2 * 1024,
    tokenPayloadMaxBytes: 1024,
    sseAuthenticationHeartbeatSeconds: 30
  },
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

  // Redis runtime degradation may move public reads onto PostgreSQL. Keep
  // this budget below the 30-connection application pool so administrative
  // transactions and the worker retain independent capacity.
  publicPgFallback: {
    totalConcurrency: 12,
    queueLimit: 64,
    queueTimeoutMs: 1_500,
    executionTimeoutMs: 7_500,
    retryAfterSeconds: 1,
    minimumRandomCandidates: 32,
    maximumRandomCandidates: 512,
    maximumTargetedCandidates: 256,
    maximumVocabularyRows: 10_000,
    maximumStorageBackendRows: 256
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

  embedding: {
    maxAllowedOrigins: 32,
    maxOriginLength: 320,
    maxSerializedOriginsLength: 4096
  },

  backgroundJob: {
    maxRetries: 5,
    retryBackoffSeconds: [60, 300, 900, 3600, 21600],
    taskTimeoutSeconds: 15 * 60,
    staleRecoveryIntervalMs: 60_000,
    historyCleanupIntervalMs: 60 * 60 * 1000,
    completedRetentionSeconds: 7 * 24 * 60 * 60,
    failedRetentionSeconds: 7 * 24 * 60 * 60,
    historyCleanupBatchSize: 1000,
    tickIntervalMs: 5_000,
    queueSliceMaxJobs: 50,
    queueSliceMaxMs: 2_000,
    drainTimeoutMs: 10_000,
    shutdownHardExitMs: 45_000,

    sampleLimit: 100
  },

  runtimeDefaults: {
    site: {
      name: "ImageShow",
      domain: "example.com",
      description: "画廊与随机图片API",
      icon_url: "/assets/brand/favicon.svg",
      version: {
        enabled: true,
        link_enabled: true
      },
      root_redirect: "home",
      home: {
        enabled: true,
        background: "",
        banner_label: "ImageShow · A FAN-MADE PHOTO HANDBOOK",
        banner_title: "我们一起，\n收藏这些瞬间。"
      },
      gallery: { default_limit: 60, order: "random" },
      random_default_method: "redirect",
      static_subdomain: "static",
      robots_enabled: false
    },
    embed: {
      enabled: false,
      allowed_origins: [] as string[]
    },
    upload: {
      max_items: 200,
      max_file_size_mb: 100,
      max_long_edge: 32000,
      list_page_size: 20,
      concurrency: 2,
      global_concurrency: 5
    },
    import: {
      fill_original_url: true,
      auto_import: true,
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
    ingestion: {
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
