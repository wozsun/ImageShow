import { materializeImportedRuntimeConfig } from "../../../packages/server/src/config/bundle/runtime-projection.ts";
import "../support/server-environment.ts";
import assert from "node:assert/strict";
import {
  rm,
  writeFile
} from "node:fs/promises";
import {
  join,
  resolve,
  toNamespacedPath
} from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createTestDirectory } from "../support/test-directory.ts";
import { runProcess } from "../support/process-runner.ts";
import { appConfig } from "../../../packages/shared/src/app-config.ts";
import { type RuntimeConfig } from "../../../packages/shared/src/browser.ts";
import {
  normalizeRuntimeConfig,
  parseRuntimeConfig,
  runtimeConfigDefaults
} from "../../../packages/server/src/config/runtime-config.ts";
import { runtimeConfigFromEnvironment } from "../../../packages/server/src/config/bootstrap-env.ts";
import { runtimeConfigEnvironmentBindings } from "../../../packages/server/src/config/runtime-config-environment.ts";
import {
  buildConfigBundle,
  parseConfigBundle,
  projectConfigBundlePreview,
  resolveImportedStorageBackends
} from "../../../packages/server/src/config/bundle/format.ts";
import { effectiveEmbedAncestorSources } from "../../../packages/server/src/config/embed-ancestors.ts";
import { isTrustedReferer } from "../../../packages/server/src/config/trusted-origins.ts";
import { ApiError } from "../../../packages/server/src/core/api-error.ts";
import {
  s3SettingsSchema,
  type StorageBackendRecord
} from "../../../packages/server/src/storage/backends/config.ts";
import { storageBackendLabel } from "../../../packages/server/src/storage/backends/label.ts";

test("[Server/配置] 来源白名单匹配完整 Referer 并保留协议、端口与子域边界", () => {
  const config = runtimeConfigDefaults();
  config.site.domain = "images.example.test:8443";
  config.embed.allowed_origins = ["https://portal.example.test", "https://*.trusted.example.test"];
  for (const [referer, expected] of [
    ["https://images.example.test:8443/page?q=1", true],
    ["https://child.images.example.test:8443/", true],
    ["https://images.example.test/", false],
    ["https://PORTAL.example.test:443/article?q=1", true],
    ["https://portal.example.test", true],
    ["https://portal.example.test:8443/", false],
    ["https://child.portal.example.test/", false],
    ["https://a.b.trusted.example.test/page", true],
    ["https://trusted.example.test/", false],
    ["https://nottrusted.example.test/", false],
    ["https://portal.example.test.attacker.test/", false],
    ["http://portal.example.test/", false],
    ["https://portal.example.test@attacker.test/", false],
    ["https://user@portal.example.test/", false],
    ["https://portal.example.test/#fragment", false],
    ["https://portal.example.test/\\path", false],
    ["/relative/path", false],
    ["not a URL", false],
    ["", false]
  ] as const) {
    assert.equal(
      isTrustedReferer(referer, "https://images.example.test:8443", config),
      expected,
      referer
    );
  }
  assert.deepEqual(effectiveEmbedAncestorSources(config), [], "嵌入开关仍单独控制 CSP");
  config.site.domain = "";
  assert.equal(
    isTrustedReferer("http://localhost:5518/gallery?q=1", "http://localhost:5518", config),
    true
  );
  assert.equal(
    isTrustedReferer("http://child.localhost:5518/", "http://localhost:5518", config),
    false
  );
  assert.equal(isTrustedReferer("https://localhost:5518/", "http://localhost:5518", config), false);
});

test("[Server/配置] 随机请求频次默认补齐并校验可配置的两档额度", () => {
  const defaults = runtimeConfigDefaults();
  assert.equal(defaults.security.random_window_seconds, 60);
  assert.equal(defaults.security.random_max_requests, 60);
  assert.equal(defaults.security.random_limit_max_requests, 10);
  const missing = structuredClone(defaults);
  const security = missing.security as Partial<typeof missing.security>;
  delete security.random_window_seconds;
  delete security.random_max_requests;
  delete security.random_limit_max_requests;
  assert.deepEqual(normalizeRuntimeConfig(missing).security, defaults.security);
  for (const [field, maximum] of [
    ["random_window_seconds", 3600],
    ["random_max_requests", 10000],
    ["random_limit_max_requests", 10000]
  ] as const) {
    for (const value of [1, maximum]) {
      assert.equal(
        parseRuntimeConfig({ ...defaults, security: { ...defaults.security, [field]: value } })
          .security[field],
        value
      );
    }
    for (const value of [0, -1, 1.5, maximum + 1]) {
      assert.throws(() =>
        parseRuntimeConfig({ ...defaults, security: { ...defaults.security, [field]: value } })
      );
    }
  }
  const seeded = runtimeConfigFromEnvironment({
    SECURITY_RANDOM_WINDOW_SECONDS: "120",
    SECURITY_RANDOM_MAX_REQUESTS: "90",
    SECURITY_RANDOM_LIMIT_MAX_REQUESTS: "12"
  });
  assert.equal(seeded.security.random_window_seconds, 120);
  assert.equal(seeded.security.random_max_requests, 90);
  assert.equal(seeded.security.random_limit_max_requests, 12);
});

test("[Server/配置] 运行时配置同时支持严格保存与启动归一化", () => {
  const defaults = runtimeConfigDefaults();
  assert.deepEqual(parseRuntimeConfig(defaults), defaults);
  assert.deepEqual(defaults.import.keep_original_link, ["url", "jsonl", "weibo"]);
  assert.equal(defaults.weibo.source_enabled, true);
  assert.equal(defaults.site.root, "home");
  assert.equal(defaults.site.random_size, "full");
  assert.equal(defaults.site.assets_base_url, "");
  for (const assets_base_url of [
    "http://asset.example.com",
    "https://user:pass@asset.example.com",
    "https://asset.example.com/?q=x",
    "https://asset.example.com/#x",
    "https://asset.example.com/%2fsecret",
    "https://main.example.com/static"
  ]) {
    assert.throws(() =>
      parseRuntimeConfig({
        ...defaults,
        site: { ...defaults.site, domain: "main.example.com", assets_base_url }
      })
    );
  }
  assert.equal(defaults.site.home.browse_target, "show");
  assert.deepEqual(defaults.site.show, {
    enabled: true,
    autoplay: true,
    mode: "waterfall",
    density: "balanced",
    drift_speed: 28,
    order: "random"
  });
  assert.equal(defaults.site.gallery.enabled, true);
  assert.equal(defaults.site.gallery.order, "latest");
  assert.deepEqual(defaults.ingestion, {
    max_file_size_mb: 100,
    max_long_edge: 32_000,
    list_page_size: 20,
    commit_concurrency: 8
  });
  assert.equal(defaults.normalize.concurrency, 2);
  assert.equal(defaults.normalize.max_long_edge, 4_200);
  assert.equal(defaults.admin.recent_uploads, 16);
  const drift = structuredClone(defaults) as Record<string, unknown>;
  delete drift.embed;
  drift.unknown_group = { enabled: true };
  drift.unknown_runtime_group = { max_attempts: 8 };
  const currentImport = structuredClone(drift.import) as Record<string, unknown>;
  const currentIngestion = structuredClone(drift.ingestion) as Record<string, unknown>;
  const currentUpload = structuredClone(drift.upload) as Record<string, unknown>;
  const currentWeibo = structuredClone(drift.weibo) as Record<string, unknown>;
  delete currentImport.auto_import;
  delete currentImport.keep_original_link;
  currentImport.unknown_option = true;
  currentIngestion.commit_concurrency = 6;
  delete currentIngestion.max_file_size_mb;
  delete currentIngestion.max_long_edge;
  delete currentIngestion.list_page_size;
  currentIngestion.unknown_option = 99;
  currentUpload.unknown_option = 99;
  delete currentWeibo.request_delay_seconds;
  delete currentWeibo.source_enabled;
  currentWeibo.unknown_option = 99;
  drift.import = currentImport;
  drift.ingestion = currentIngestion;
  drift.upload = currentUpload;
  drift.weibo = currentWeibo;
  const driftSite = drift.site as Record<string, unknown>;
  delete driftSite.description;
  delete driftSite.root;
  delete driftSite.random_size;
  delete driftSite.assets_base_url;
  driftSite.unknown_site_key = "gallery";
  driftSite.unknown_option = true;
  (driftSite.home as Record<string, unknown>).unknown_option = true;

  const normalized = normalizeRuntimeConfig(drift);
  assert.deepEqual(Object.keys(normalized.site).slice(0, 5), [
    "domain",
    "icon",
    "title",
    "description",
    "header_name"
  ]);
  assert.deepEqual(normalized.embed, { enabled: false, allowed_origins: [] });
  assert.equal(normalized.import.auto_import, true);
  assert.deepEqual(normalized.import.keep_original_link, ["url", "jsonl", "weibo"]);
  assert.equal(normalized.ingestion.commit_concurrency, 6);
  assert.equal(normalized.ingestion.max_file_size_mb, 100);
  assert.equal(normalized.ingestion.max_long_edge, 32000);
  assert.equal(normalized.ingestion.list_page_size, 20);
  assert.deepEqual(normalized.weibo.request_delay_seconds, [2, 5]);
  assert.equal(normalized.weibo.source_enabled, true);
  assert.equal(normalized.site.description, "画廊与随机图片API");
  assert.equal(normalized.site.root, "home");
  assert.equal(normalized.site.random_size, "full");
  assert.equal(normalized.site.assets_base_url, "");
  assert.equal(
    normalized.site.show.autoplay,
    true,
    "已有配置缺失字段使用唯一默认值，不重新播种环境值"
  );
  assert.equal("unknown_site_key" in normalized.site, false);
  assert.equal("unknown_option" in normalized.site, false);
  assert.equal("unknown_option" in normalized.site.home, false);
  assert.equal("unknown_option" in normalized.import, false);
  assert.equal("unknown_option" in normalized.ingestion, false);
  assert.equal("unknown_option" in normalized.upload, false);
  assert.equal("unknown_option" in normalized.weibo, false);
  assert.equal("unknown_group" in normalized, false);
  assert.equal("unknown_runtime_group" in normalized, false);
  assert.throws(() => parseRuntimeConfig(drift));

  const reversedWeiboDelay = structuredClone(defaults);
  reversedWeiboDelay.weibo.request_delay_seconds = [6, 5];
  assert.throws(() => parseRuntimeConfig(reversedWeiboDelay));

  const configWithImportTypesKeepingOriginalLink = structuredClone(defaults);
  configWithImportTypesKeepingOriginalLink.import.keep_original_link = [
    "weibo",
    "url",
    "weibo",
    "url"
  ];
  assert.deepEqual(
    normalizeRuntimeConfig(configWithImportTypesKeepingOriginalLink).import.keep_original_link,
    ["weibo", "url"]
  );
  configWithImportTypesKeepingOriginalLink.import.keep_original_link = [];
  assert.deepEqual(
    normalizeRuntimeConfig(configWithImportTypesKeepingOriginalLink).import.keep_original_link,
    []
  );
  configWithImportTypesKeepingOriginalLink.import.keep_original_link = ["upload"] as never;
  assert.throws(() => normalizeRuntimeConfig(configWithImportTypesKeepingOriginalLink));

  const siteWithUnknownKey = structuredClone(defaults) as RuntimeConfig & {
    site: RuntimeConfig["site"] & Record<string, unknown>;
  };
  siteWithUnknownKey.site.root = "gallery";
  siteWithUnknownKey.site.unknown_site_key = "home";
  const siteWithUnknownKeyNormalized = normalizeRuntimeConfig(siteWithUnknownKey);
  assert.equal(siteWithUnknownKeyNormalized.site.root, "gallery");
  assert.equal("unknown_site_key" in siteWithUnknownKeyNormalized.site, false);

  const missingSiteRoot = structuredClone(defaults) as RuntimeConfig & {
    site: RuntimeConfig["site"] & Record<string, unknown>;
  };
  delete (missingSiteRoot.site as Partial<RuntimeConfig["site"]>).root;
  missingSiteRoot.site.unknown_site_key = "invalid";
  assert.equal(normalizeRuntimeConfig(missingSiteRoot).site.root, "home");

  const invalidCurrentSiteRoot = structuredClone(defaults) as RuntimeConfig & {
    site: RuntimeConfig["site"] & Record<string, unknown>;
  };
  invalidCurrentSiteRoot.site.root = "invalid" as RuntimeConfig["site"]["root"];
  invalidCurrentSiteRoot.site.unknown_site_key = "gallery";
  assert.throws(() => normalizeRuntimeConfig(invalidCurrentSiteRoot));

  for (const root of ["home", "gallery"] as const) {
    const current = structuredClone(defaults);
    current.site.root = root;
    assert.equal(parseRuntimeConfig(current).site.root, root);
  }

  const embedded = structuredClone(defaults);
  embedded.site.domain = "img.example.com:5518";
  embedded.embed.enabled = true;
  embedded.embed.allowed_origins = [
    " HTTPS://Portal.Example.com:443/ ",
    "https://portal.example.com",
    "https://*.trusted.example.net"
  ];
  const parsed = parseRuntimeConfig(embedded);
  assert.deepEqual(parsed.embed.allowed_origins, [
    "https://portal.example.com",
    "https://*.trusted.example.net"
  ]);
  assert.deepEqual(effectiveEmbedAncestorSources(parsed), [
    "https://img.example.com:5518",
    "https://*.img.example.com:5518",
    "https://portal.example.com",
    "https://*.trusted.example.net"
  ]);
  for (const domain of ["", "example.com"]) {
    const automatic = parseRuntimeConfig({
      ...embedded,
      site: { ...embedded.site, domain }
    });
    assert.equal(automatic.site.domain, domain);
    assert.deepEqual(effectiveEmbedAncestorSources(automatic), [
      "'self'",
      "https://portal.example.com",
      "https://*.trusted.example.net"
    ]);
  }

  const invalid = structuredClone(defaults);
  invalid.normalize.concurrency = 0;
  assert.throws(() => normalizeRuntimeConfig(invalid));

  const described = structuredClone(defaults);
  described.site.description = "  自定义站点描述  ";
  assert.equal(parseRuntimeConfig(described).site.description, "自定义站点描述");
  described.site.description = "";
  assert.equal(parseRuntimeConfig(described).site.description, "");
  described.site.description = "站".repeat(201);
  assert.throws(() => parseRuntimeConfig(described));

  const siteLimits = structuredClone(defaults);
  siteLimits.site.home.banner_title = "题".repeat(80);
  assert.equal(parseRuntimeConfig(siteLimits).site.home.banner_title.length, 80);
  siteLimits.site.home.banner_title = "题".repeat(81);
  assert.throws(() => parseRuntimeConfig(siteLimits));

  for (const maxLongEdge of [300, 32_000]) {
    const current = structuredClone(defaults);
    current.ingestion.max_long_edge = maxLongEdge;
    assert.equal(parseRuntimeConfig(current).ingestion.max_long_edge, maxLongEdge);
  }
  for (const maxLongEdge of [299, 32_001]) {
    const current = structuredClone(defaults);
    current.ingestion.max_long_edge = maxLongEdge;
    assert.throws(() => parseRuntimeConfig(current));
  }

  for (const maxFileSizeMb of [0.001, 200]) {
    const current = structuredClone(defaults);
    current.ingestion.max_file_size_mb = maxFileSizeMb;
    assert.equal(
      parseRuntimeConfig(current).ingestion.max_file_size_mb,
      maxFileSizeMb
    );
  }
  for (const maxFileSizeMb of [0, 200.001]) {
    const current = structuredClone(defaults);
    current.ingestion.max_file_size_mb = maxFileSizeMb;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const listPageSize of [1, 100]) {
    const current = structuredClone(defaults);
    current.ingestion.list_page_size = listPageSize;
    assert.equal(
      parseRuntimeConfig(current).ingestion.list_page_size,
      listPageSize
    );
  }
  for (const listPageSize of [0, 101]) {
    const current = structuredClone(defaults);
    current.ingestion.list_page_size = listPageSize;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const commitConcurrency of [1, 16]) {
    const current = structuredClone(defaults);
    current.ingestion.commit_concurrency = commitConcurrency;
    assert.equal(
      parseRuntimeConfig(current).ingestion.commit_concurrency,
      commitConcurrency
    );
  }
  for (const commitConcurrency of [0, 17]) {
    const current = structuredClone(defaults);
    current.ingestion.commit_concurrency = commitConcurrency;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const normalizeConcurrency of [1, 8]) {
    const current = structuredClone(defaults);
    current.normalize.concurrency = normalizeConcurrency;
    assert.equal(
      parseRuntimeConfig(current).normalize.concurrency,
      normalizeConcurrency
    );
  }
  for (const normalizeConcurrency of [0, 9]) {
    const current = structuredClone(defaults);
    current.normalize.concurrency = normalizeConcurrency;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const normalizedLongEdge of [300, 32_000]) {
    const current = structuredClone(defaults);
    current.normalize.max_long_edge = normalizedLongEdge;
    assert.equal(
      parseRuntimeConfig(current).normalize.max_long_edge,
      normalizedLongEdge
    );
  }
  for (const normalizedLongEdge of [299, 32_001]) {
    const current = structuredClone(defaults);
    current.normalize.max_long_edge = normalizedLongEdge;
    assert.throws(() => parseRuntimeConfig(current));
  }
  for (const recentUploads of [1, 60]) {
    const current = structuredClone(defaults);
    current.admin.recent_uploads = recentUploads;
    assert.equal(parseRuntimeConfig(current).admin.recent_uploads, recentUploads);
  }
  for (const recentUploads of [0, 61]) {
    const current = structuredClone(defaults);
    current.admin.recent_uploads = recentUploads;
    assert.throws(() => parseRuntimeConfig(current));
  }

  const validCurrentValues = structuredClone(defaults);
  validCurrentValues.ingestion.max_file_size_mb = 128;
  validCurrentValues.ingestion.max_long_edge = 24_000;
  validCurrentValues.ingestion.list_page_size = 40;
  validCurrentValues.normalize.concurrency = 6;
  validCurrentValues.normalize.max_long_edge = 4_500;
  validCurrentValues.admin.recent_uploads = 12;
  const preservedCurrentValues = normalizeRuntimeConfig(validCurrentValues);
  assert.deepEqual(preservedCurrentValues.ingestion, validCurrentValues.ingestion);
  assert.equal(preservedCurrentValues.normalize.concurrency, 6);
  assert.equal(preservedCurrentValues.normalize.max_long_edge, 4_500);
  assert.equal(preservedCurrentValues.admin.recent_uploads, 12);

  for (const method of ["proxy", "redirect"] as const) {
    const current = structuredClone(defaults);
    current.site.random_method = method;
    assert.equal(parseRuntimeConfig(current).site.random_method, method);
  }
  const invalidRandomDefault = structuredClone(defaults) as RuntimeConfig;
  invalidRandomDefault.site.random_method = "json" as never;
  assert.throws(() => parseRuntimeConfig(invalidRandomDefault));
});
test("[Server/配置] 完整环境播种严格覆盖全部已映射 RuntimeConfig 叶子与合法空值", async () => {
  function valueAtPath(value: unknown, path: string) {
    return path
      .split(".")
      .reduce<unknown>(
        (current, segment) =>
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[segment]
            : undefined,
        value
      );
  }
  function environmentLiteral(kind: string, value: unknown) {
    if (kind === "string") return value as string;
    if (kind === "boolean" || kind === "number") return String(value);
    return JSON.stringify(value);
  }

  const defaults = runtimeConfigDefaults();
  const completeSeed = Object.fromEntries(
    runtimeConfigEnvironmentBindings.map((binding) => [
      binding.environmentVariable,
      environmentLiteral(binding.valueKind, valueAtPath(defaults, binding.path))
    ])
  );
  assert.deepEqual(runtimeConfigFromEnvironment(completeSeed), defaults);
  assert.equal(runtimeConfigFromEnvironment({}).site.domain, "example.com");
  const footerSeed = runtimeConfigFromEnvironment({
    SITE_ICP: "  示例ICP备123号  ",
    SITE_MPS: "  示例公网安备12345678901234号  ",
    SITE_FOOTER: '  Powered by <a href="https://example.com/">ImageShow</a><br>站点说明  '
  });
  assert.equal(footerSeed.site.icp, "示例ICP备123号");
  assert.equal(footerSeed.site.mps, "示例公网安备12345678901234号");
  assert.equal(
    footerSeed.site.footer,
    'Powered by <a href="https://example.com/">ImageShow</a><br>站点说明'
  );
  for (const [variable, field, limit] of [
    ["SITE_ICP", "icp", 200],
    ["SITE_MPS", "mps", 200],
    ["SITE_FOOTER", "footer", 2000]
  ] as const) {
    assert.equal(defaults.site[field], "");
    assert.equal(runtimeConfigFromEnvironment({ [variable]: "  " }).site[field], "");
    assert.equal(
      runtimeConfigFromEnvironment({ [variable]: "文".repeat(limit) }).site[field].length,
      limit
    );
    assert.throws(() => runtimeConfigFromEnvironment({ [variable]: "文".repeat(limit + 1) }));
    assert.throws(() =>
      parseRuntimeConfig({
        ...defaults,
        site: { ...defaults.site, [field]: "文".repeat(limit + 1) }
      })
    );
  }
  assert.equal(runtimeConfigFromEnvironment({ SITE_DOMAIN: "" }).site.domain, "");
  assert.equal(
    runtimeConfigFromEnvironment({ SITE_DOMAIN: "  EXAMPLE.COM  " }).site.domain,
    "example.com"
  );
  assert.equal(
    runtimeConfigFromEnvironment({ SITE_DOMAIN: "img.example.com" }).site.domain,
    "img.example.com"
  );

  const environmentConfig = runtimeConfigFromEnvironment({
    SITE_TITLE: "  浏览器标题  ",
    SITE_HEADER_NAME: "  页头名称  ",
    SITE_DESCRIPTION: "",
    SITE_ROOT: "show",
    SITE_HOME_BROWSE_TARGET: "show",
    SITE_HOME_BACKGROUND: "",
    SITE_SHOW_ENABLED: "false",
    SITE_SHOW_AUTOPLAY: "false",
    SITE_SHOW_MODE: "float",
    SITE_SHOW_DENSITY: "dense",
    SITE_SHOW_DRIFT_SPEED: "42",
    SITE_SHOW_ORDER: "oldest",
    SITE_GALLERY_ENABLED: "false",
    SITE_ROBOTS_ENABLED: "false",
    SITE_RANDOM_SIZE: "thumb",
    SITE_ASSETS_BASE_URL: " https://ASSET.example.com:443///static//nested/// ",
    NORMALIZE_SKIP_WEBP_UNDER_KB: "0",
    IMPORT_KEEP_ORIGINAL_LINK: '["weibo","url"]',
    WEIBO_SOURCE_ENABLED: "false",
    EMBED_ALLOWED_ORIGINS: '["https://portal.example.com","https://*.trusted.example.net"]'
  });
  assert.equal(environmentConfig.site.description, "");
  assert.equal(environmentConfig.site.title, "浏览器标题");
  assert.equal(environmentConfig.site.header_name, "页头名称");
  assert.equal(environmentConfig.site.root, "show");
  assert.equal(environmentConfig.site.home.browse_target, "show");
  assert.equal(environmentConfig.site.home.background, "");
  assert.deepEqual(environmentConfig.site.show, {
    enabled: false,
    autoplay: false,
    mode: "float",
    density: "dense",
    drift_speed: 42,
    order: "oldest"
  });
  assert.equal(environmentConfig.site.gallery.enabled, false);
  assert.equal(environmentConfig.site.robots_enabled, false);
  assert.equal(environmentConfig.site.random_size, "thumb");
  assert.equal(environmentConfig.site.assets_base_url, "https://asset.example.com/static/nested");
  assert.equal(environmentConfig.normalize.skip_webp_under_kb, 0);
  assert.deepEqual(environmentConfig.import.keep_original_link, ["weibo", "url"]);
  assert.equal(environmentConfig.weibo.source_enabled, false);
  assert.deepEqual(
    runtimeConfigFromEnvironment({ IMPORT_KEEP_ORIGINAL_LINK: "[]" }).import.keep_original_link,
    []
  );
  assert.deepEqual(
    runtimeConfigFromEnvironment({
      IMPORT_KEEP_ORIGINAL_LINK: '["url","url","url","url"]'
    }).import.keep_original_link,
    ["url"]
  );
  assert.deepEqual(environmentConfig.embed.allowed_origins, [
    "https://portal.example.com",
    "https://*.trusted.example.net"
  ]);
  assert.equal(
    runtimeConfigFromEnvironment({ SITE_DESCRIPTION: "  环境站点描述  " }).site.description,
    "环境站点描述"
  );
  assert.equal(runtimeConfigFromEnvironment({}).site.description, "画廊与随机图片API");
  assert.equal(
    runtimeConfigFromEnvironment({
      UNKNOWN_RUNTIME_SETTING: "gallery"
    }).site.root,
    "home"
  );

  for (const [environment, expected] of [
    [{ SITE_RANDOM_SIZE: "small" }, /SITE_RANDOM_SIZE.*site\.random_size/],
    [
      { SITE_ASSETS_BASE_URL: "http://asset.example.com" },
      /SITE_ASSETS_BASE_URL.*site\.assets_base_url/
    ],
    [{ UPLOAD_MAX_ITEMS: " 1" }, /UPLOAD_MAX_ITEMS.*upload\.max_items/],
    [{ UPLOAD_MAX_ITEMS: "01" }, /UPLOAD_MAX_ITEMS.*upload\.max_items/],
    [{ UPLOAD_MAX_ITEMS: "NaN" }, /UPLOAD_MAX_ITEMS.*upload\.max_items/],
    [{ INGESTION_MAX_LONG_EDGE: "32001" }, /INGESTION_MAX_LONG_EDGE.*ingestion\.max_long_edge/],
    [{ SITE_ROBOTS_ENABLED: "yes" }, /SITE_ROBOTS_ENABLED.*site\.robots_enabled/],
    [{ SITE_ROBOTS_ENABLED: "1" }, /SITE_ROBOTS_ENABLED.*site\.robots_enabled/],
    [{ SITE_ROBOTS_ENABLED: "0" }, /SITE_ROBOTS_ENABLED.*site\.robots_enabled/],
    [{ SITE_GALLERY_ENABLED: "1" }, /SITE_GALLERY_ENABLED.*site\.gallery\.enabled/],
    [{ SITE_ROOT: "landing" }, /SITE_ROOT.*site\.root/],
    [{ SITE_HOME_BROWSE_TARGET: "home" }, /SITE_HOME_BROWSE_TARGET.*site\.home\.browse_target/],
    [{ SITE_SHOW_ENABLED: "1" }, /SITE_SHOW_ENABLED.*site\.show\.enabled/],
    [{ SITE_SHOW_AUTOPLAY: "1" }, /SITE_SHOW_AUTOPLAY.*site\.show\.autoplay/],
    [{ SITE_SHOW_MODE: "grid" }, /SITE_SHOW_MODE.*site\.show\.mode/],
    [{ SITE_SHOW_DENSITY: "maximum" }, /SITE_SHOW_DENSITY.*site\.show\.density/],
    [{ SITE_SHOW_DRIFT_SPEED: "9" }, /SITE_SHOW_DRIFT_SPEED.*site\.show\.drift_speed/],
    [{ SITE_SHOW_ORDER: "shuffle" }, /SITE_SHOW_ORDER.*site\.show\.order/],
    [{ SITE_RANDOM_METHOD: "json" }, /SITE_RANDOM_METHOD.*site\.random_method/],
    [{ IMPORT_KEEP_ORIGINAL_LINK: "url,weibo" }, /IMPORT_KEEP_ORIGINAL_LINK.*JSON/],
    [
      { IMPORT_KEEP_ORIGINAL_LINK: '["url","upload"]' },
      /IMPORT_KEEP_ORIGINAL_LINK.*import\.keep_original_link/
    ],
    [
      { EMBED_ALLOWED_ORIGINS: "https:\/\/portal.example.com" },
      /EMBED_ALLOWED_ORIGINS.*embed\.allowed_origins/
    ],
    [{ EMBED_ALLOWED_ORIGINS: "{}" }, /EMBED_ALLOWED_ORIGINS.*embed\.allowed_origins/],
    [
      { EMBED_ALLOWED_ORIGINS: '["http:\/\/portal.example.com"]' },
      /EMBED_ALLOWED_ORIGINS.*embed\.allowed_origins/
    ],
    [{ SITE_HEADER_NAME: "" }, /SITE_HEADER_NAME.*site\.header_name/],
    [{ SITE_TITLE: "  " }, /SITE_TITLE.*site\.title/],
    [
      { NORMALIZE_QUALITY: "10", NORMALIZE_MIN_QUALITY: "20" },
      /NORMALIZE_QUALITY.*normalize\.min_quality/
    ],
    [
      { WEIBO_REQUEST_DELAY_SECONDS: "[6,5]" },
      /WEIBO_REQUEST_DELAY_SECONDS.*weibo\.request_delay_seconds/
    ],
    [
      { WEIBO_REQUEST_DELAY_SECONDS: "[2]" },
      /WEIBO_REQUEST_DELAY_SECONDS.*weibo\.request_delay_seconds/
    ],
    [
      { WEIBO_REQUEST_DELAY_SECONDS: '["2",5]' },
      /WEIBO_REQUEST_DELAY_SECONDS.*weibo\.request_delay_seconds/
    ],
    [{ ALTCHA_COUNTER_RANGE: '[2000,"5000"]' }, /ALTCHA_COUNTER_RANGE.*altcha\.counter_range/],
    [
      { ALTCHA_COST: "100000", ALTCHA_COUNTER_RANGE: "[2000,100000]" },
      /ALTCHA_COST.*altcha\.counter_range/
    ]
  ] as const) {
    assert.throws(() => runtimeConfigFromEnvironment(environment), expected);
  }

  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const helperRoot = await createTestDirectory("imageshow-config-lifecycle-");
  const helperPath = join(helperRoot, "verify-config-lifecycle.mjs");
  const runtimeConfigUrl = pathToFileURL(
    resolve(
      repositoryRoot,
      "packages/server/src/config/runtime-config.ts"
    )
  ).href;
  const runtimeConfigStoreUrl = pathToFileURL(
    resolve(
      repositoryRoot,
      "packages/server/src/config/runtime-config-store.ts"
    )
  ).href;
  const appSettingsUrl = pathToFileURL(
    resolve(
      repositoryRoot,
      "packages/server/src/config/app-settings.ts"
    )
  ).href;
  const helperSource = `
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeConfigDefaults } from ${JSON.stringify(runtimeConfigUrl)};
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  reloadRuntimeConfigFromDisk,
  updateRuntimeConfig
} from ${JSON.stringify(runtimeConfigStoreUrl)};
import {
  getSettingsForAdmin,
  parseSettingsInput,
  resolveIngestionSnapshotLimit,
  saveAppSettings,
  siteConfigPayload
} from ${JSON.stringify(appSettingsUrl)};

const root = process.env.IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY;
assert.ok(root);
await mkdir(root, { recursive: true });
const scenario = process.env.CONFIG_SCENARIO;
const unknownSiteKey = "unknown_site_key";

if (scenario === "seed") {
  const generated = initializeRuntimeConfig();
  assert.equal(generated.site.root, "show");
  assert.equal(generated.site.description, "");
  assert.equal(generated.site.icp, "测试ICP备123号");
  assert.equal(generated.site.mps, "测试公网安备123456号");
  assert.equal(generated.site.footer, 'Powered by <a href="https://example.com/">ImageShow</a>');
  for (const field of ["icp", "mps", "footer"]) {
    assert.equal(siteConfigPayload().site[field], generated.site[field]);
  }
  assert.equal(generated.site.title, "环境网页标题");
  assert.equal(generated.site.header_name, "环境页头名称");
  assert.equal(siteConfigPayload().site.description, generated.site.title, "空描述只在服务端投影为网页标题");
  assert.equal(generated.site.home.browse_target, "show");
  assert.deepEqual(generated.site.show, {
    enabled: false,
    autoplay: false,
    mode: "float",
    density: "dense",
    drift_speed: 42,
    order: "oldest"
  });
  assert.equal(generated.site.gallery.enabled, false);
  assert.equal(generated.normalize.skip_webp_under_kb, 0);
  const persisted = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.deepEqual(persisted, generated);
  assert.deepEqual(Object.keys(persisted.site).slice(0, 5), ["domain", "icon", "title", "description", "header_name"]);
  console.log("config-seed-ok");
} else if (scenario === "invalid-current") {
  const invalid = structuredClone(runtimeConfigDefaults());
  invalid.site.root = "invalid";
  invalid.site[unknownSiteKey] = "gallery";
  await writeFile(join(root, "config.json"), JSON.stringify(invalid));
  assert.throws(() => initializeRuntimeConfig(), /Invalid runtime config/);
  const persisted = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
  assert.equal(persisted.site.root, "invalid");
  assert.equal(persisted.site[unknownSiteKey], "gallery");
  console.log("config-invalid-current-ok");
} else {
const drifted = structuredClone(runtimeConfigDefaults());
delete drifted.site.icp;
delete drifted.site.mps;
delete drifted.site.footer;
delete drifted.site.title;
drifted.site.header_name = "文件页头";
delete drifted.site.description;
delete drifted.site.root;
delete drifted.site.show.autoplay;
delete drifted.site.gallery.enabled;
drifted.site[unknownSiteKey] = "gallery";
drifted.site.unknown = "remove-me";
drifted.site.home.unknown = "remove-me";
drifted.unknown_section = { enabled: false };
await writeFile(join(root, "config.json"), JSON.stringify(drifted));
const normalized = initializeRuntimeConfig();
assert.equal(normalized.site.title, "ImageShow");
assert.equal(normalized.site.header_name, "文件页头");
assert.equal(normalized.site.description, "画廊与随机图片API");
assert.equal(normalized.site.icp, "");
assert.equal(normalized.site.mps, "");
assert.equal(normalized.site.footer, "");
assert.equal(normalized.site.root, "home");
assert.equal(normalized.site.gallery.enabled, true);
assert.equal(unknownSiteKey in normalized.site, false);
assert.equal("unknown" in normalized.site, false);
assert.equal("unknown" in normalized.site.home, false);
assert.equal("unknown_section" in normalized, false);
assert.equal(siteConfigPayload().site.description, "画廊与随机图片API");
assert.equal(siteConfigPayload().site.root, "home");
assert.equal(
  siteConfigPayload().site.home.background,
  "/random?mode=redirect"
);
assert.deepEqual(siteConfigPayload().site.show, {
  enabled: true,
    autoplay: true,
  mode: "waterfall",
  density: "balanced",
  drift_speed: 28,
  order: "random"
});
assert.equal(siteConfigPayload().site.gallery.enabled, true);
assert.deepEqual(siteConfigPayload().site.gallery, { enabled: true, order: "latest" });
assert.equal("description" in getSettingsForAdmin().site, false);
for (const field of ["icp", "mps", "footer"]) {
  assert.equal(field in getSettingsForAdmin().site, false);
  assert.throws(() => parseSettingsInput({ site: { [field]: "footer text" } }));
}
assert.equal(getSettingsForAdmin().site.root, "home");
assert.equal("browse_target" in getSettingsForAdmin().site.home, false);
assert.equal("show" in getSettingsForAdmin().site, false);
assert.equal("enabled" in getSettingsForAdmin().site.gallery, false);
assert.deepEqual(getSettingsForAdmin().ingestion, {
  max_file_size_mb: 100,
  max_long_edge: 32000,
  list_page_size: 20,
  commit_concurrency: 8
});
assert.deepEqual(getSettingsForAdmin().upload, {
  max_items: 200,
  browser_concurrency: 2
});
assert.deepEqual(getSettingsForAdmin().import, {
  keep_original_link: ["url", "jsonl", "weibo"],
  auto_import: true,
  max_items: 200
});
assert.deepEqual(getSettingsForAdmin().weibo, {
  max_items: 10
});
assert.deepEqual(getSettingsForAdmin().normalize, {
  concurrency: 2,
  quality: 80,
  min_quality: 20,
  max_long_edge: 4200,
  max_size_kb: 500,
  skip_webp_under_kb: 700
});
assert.equal("quality_step" in getSettingsForAdmin().normalize, false);
assert.deepEqual(new Set(Object.keys(getSettingsForAdmin())), new Set([
  "site",
  "ingestion",
  "upload",
  "import",
  "weibo",
  "normalize",
  "thumbnail",
  "admin"
]));
assert.equal("unknown_section" in getSettingsForAdmin(), false);
assert.equal("unknown_section" in siteConfigPayload(), false);
assert.equal(parseSettingsInput({ site: { root: "gallery" } }).site?.root, "gallery");
assert.deepEqual(parseSettingsInput({ site: { title: "  网页标题  ", header_name: "  页头文字  " } }).site, {
  title: "网页标题", header_name: "页头文字"
});
assert.equal(parseSettingsInput({ site: { root: "show" } }).site.root, "show");
for (const site of [
  { home: { browse_target: "show" } },
  { gallery: { enabled: false } },
  { show: { autoplay: false } },
  { show: { mode: "float" } }
]) assert.throws(() => parseSettingsInput({ site }), "普通设置拒绝尚未开放的新字段");
assert.equal(
  parseSettingsInput({ ingestion: { list_page_size: 100 } })
    .ingestion?.list_page_size,
  100
);
assert.throws(() => parseSettingsInput({ ingestion: { list_page_size: 101 } }));
assert.equal(
  parseSettingsInput({ ingestion: { commit_concurrency: 16 } })
    .ingestion?.commit_concurrency,
  16
);
assert.throws(() => parseSettingsInput({ ingestion: { commit_concurrency: 17 } }));
assert.throws(() => parseSettingsInput({ upload: { list_page_size: 20 } }));
assert.throws(() => parseSettingsInput({ import: { keep_original_link: [] } }));
assert.throws(() => parseSettingsInput({ import: { auto_import: false } }));
assert.throws(() => parseSettingsInput({ weibo: { source_enabled: false } }));
assert.throws(() => parseSettingsInput({ normalize: { quality_step: 10 } }));
assert.throws(() => parseSettingsInput({ site: { [unknownSiteKey]: "gallery" } }));
assert.throws(() => parseSettingsInput({ site: { description: "越权普通设置" } }));
assert.throws(() => parseSettingsInput({ unknown_section: { enabled: false } }));
const persisted = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
assert.deepEqual(persisted, normalized);
assert.equal(unknownSiteKey in persisted.site, false);
assert.equal("unknown" in persisted.site, false);
assert.equal("unknown" in persisted.site.home, false);
assert.equal("unknown_section" in persisted, false);

await saveAppSettings(parseSettingsInput({
  ingestion: { list_page_size: 37, commit_concurrency: 12 }
}));
assert.equal(getRuntimeConfig().ingestion.list_page_size, 37);
assert.equal(getRuntimeConfig().ingestion.commit_concurrency, 12);
assert.equal(getSettingsForAdmin().ingestion.list_page_size, 37);
assert.equal(getSettingsForAdmin().ingestion.commit_concurrency, 12);
assert.equal(resolveIngestionSnapshotLimit(undefined), 37);
assert.equal(resolveIngestionSnapshotLimit(0), 0);
assert.equal(resolveIngestionSnapshotLimit(12), 12);
const saved = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
assert.equal(saved.ingestion.list_page_size, 37);
assert.equal(saved.ingestion.commit_concurrency, 12);

await updateRuntimeConfig({
  import: { keep_original_link: ["jsonl"], auto_import: false },
  weibo: { source_enabled: false },
  normalize: { quality_step: 11 }
});
await saveAppSettings(parseSettingsInput({
  normalize: { quality: 79 },
  admin: { recent_uploads: 15 }
}));
assert.deepEqual(getRuntimeConfig().import.keep_original_link, ["jsonl"]);
assert.equal(getRuntimeConfig().import.auto_import, false);
assert.equal(getRuntimeConfig().weibo.source_enabled, false);
assert.equal(getRuntimeConfig().normalize.quality_step, 11);
assert.equal(getRuntimeConfig().normalize.quality, 79);
assert.deepEqual(siteConfigPayload().site.gallery, { enabled: true, order: "latest" });
assert.deepEqual(getSettingsForAdmin().import.keep_original_link, ["jsonl"]);
assert.equal(getSettingsForAdmin().import.auto_import, false);
assert.equal("source_enabled" in getSettingsForAdmin().weibo, false);
assert.equal("quality_step" in getSettingsForAdmin().normalize, false);

const mixed = structuredClone(getRuntimeConfig());
mixed.site.root = "gallery";
mixed.site[unknownSiteKey] = "home";
await writeFile(join(root, "config.json"), JSON.stringify(mixed));
const reloaded = await reloadRuntimeConfigFromDisk();
assert.equal(reloaded.site.root, "gallery");
assert.deepEqual(siteConfigPayload().site.gallery, { enabled: true, order: "latest" });
assert.equal(unknownSiteKey in reloaded.site, false);
const reloadedPersisted = JSON.parse(await readFile(join(root, "config.json"), "utf8"));
assert.deepEqual(reloadedPersisted, reloaded);
console.log("config-existing-ok");
}
`;
  try {
    await writeFile(helperPath, helperSource);
    const scenarios = [
      {
        name: "seed",
        environment: {
          SITE_TITLE: "环境网页标题",
          SITE_HEADER_NAME: "环境页头名称",
          SITE_ROOT: "show",
          SITE_DESCRIPTION: "",
          SITE_ICP: "测试ICP备123号",
          SITE_MPS: "测试公网安备123456号",
          SITE_FOOTER: 'Powered by <a href="https://example.com/">ImageShow</a>',
          SITE_HOME_BROWSE_TARGET: "show",
          SITE_SHOW_ENABLED: "false",
          SITE_SHOW_AUTOPLAY: "false",
          SITE_SHOW_MODE: "float",
          SITE_SHOW_DENSITY: "dense",
          SITE_SHOW_DRIFT_SPEED: "42",
          SITE_SHOW_ORDER: "oldest",
          SITE_GALLERY_ENABLED: "false",
          NORMALIZE_SKIP_WEBP_UNDER_KB: "0"
        },
        output: /config-seed-ok/
      },
      {
        name: "existing",
        environment: {
          SITE_TITLE: "忽略环境标题",
          SITE_HEADER_NAME: "忽略环境页头",
          SITE_ROOT: "invalid",
          SITE_ICP: "忽略环境备案号",
          SITE_MPS: "忽略环境公安备案号",
          SITE_FOOTER: "忽略环境页脚",
          SITE_GALLERY_ENABLED: "invalid",
          UPLOAD_MAX_ITEMS: "invalid"
        },
        output: /config-existing-ok/
      },
      {
        name: "invalid-current",
        environment: {},
        output: /config-invalid-current-ok/
      }
    ] as const;
    for (const scenario of scenarios) {
      const result = await runProcess(
        process.execPath,
        [
          resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs"),
          helperPath
        ],
        {
          cwd: repositoryRoot,
          env: {
            ...process.env,
            NODE_ENV: "development",
            CONFIG_SCENARIO: scenario.name,
            IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(join(helperRoot, scenario.name)),
            SITE_ROOT: undefined,
            SITE_DESCRIPTION: undefined,
            SITE_ICP: undefined,
            SITE_MPS: undefined,
            SITE_FOOTER: undefined,
            SITE_GALLERY_ENABLED: undefined,
            NORMALIZE_SKIP_WEBP_UNDER_KB: undefined,
            UPLOAD_MAX_ITEMS: undefined,
            ...scenario.environment
          },
          timeoutMs: 30_000
        }
      );
      assert.match(result.stdout, scenario.output);
    }
  } finally {
    await rm(helperRoot, { recursive: true, force: true });
  }
});
test("[Server/配置] 配置包按目标版本能力宽松识别并保留导入安全边界", () => {
  const s3 = s3SettingsSchema.parse({
    endpoint: "objects.example.com",
    bucket: "gallery",
    access_key_id: "key",
    secret_access_key: "secret"
  });
  const backends = [
    {
      slug: "local",
      sort_order: 0,
      display_name: "本地",
      type: "local",
      enabled: true,
      is_default: true
    },
    {
      slug: "archive",
      sort_order: -1,
      display_name: "归档",
      type: "s3",
      enabled: true,
      is_default: false,
      s3
    }
  ] satisfies StorageBackendRecord[];
  const packageRuntime = runtimeConfigDefaults();
  packageRuntime.site.header_name = "来源站点";
  packageRuntime.site.title = "来源网页标题";
  packageRuntime.site.assets_base_url = "https://source-assets.example.com/static";
  packageRuntime.site.random_size = "thumb";
  packageRuntime.site.description = "来源说明";
  const pkg = buildConfigBundle(
    packageRuntime,
    backends,
    "current-build",
    new Date("2026-08-11T00:00:00.000Z")
  );
  assert.equal(pkg.format, "imageshow-config");
  assert.equal(pkg.application_version, "current-build");
  assert.equal(pkg.config.site.root, "home");
  assert.equal("assets_base_url" in pkg.config.site, false);
  assert.equal(pkg.config.site.random_size, "thumb");
  assert.deepEqual(pkg.storage_backends, [
    {
      slug: "archive",
      display_name: "归档",
      enabled: true,
      is_default: false,
      s3
    }
  ]);
  const complete = parseConfigBundle(pkg);
  assert.deepEqual(complete.config, pkg.config);
  assert.ok(complete.config_values.recognized > 0);
  assert.equal(complete.config_values.defaulted, 0);
  assert.equal(complete.config_values.ignored, 0);
  assert.equal(complete.skipped_storage_backends, 0);

  const source = structuredClone(pkg) as unknown as Record<string, unknown>;
  source.format = "future-config";
  delete source.application_version;
  source.unused_package_field = true;
  const sourceConfig = source.config as Record<string, Record<string, unknown>>;
  const sourceSite = sourceConfig.site!;
  sourceSite.header_name = "  已采用站点  ";
  delete sourceSite.description;
  sourceSite.root = "future-root";
  sourceSite.domain = "must-not-cross.example.com";
  sourceSite.unknown_site_field = true;
  sourceConfig.future_group = { enabled: true };
  sourceConfig.normalize!.quality = 50;
  sourceConfig.normalize!.min_quality = 40;
  sourceConfig.thumbnail!.quality = 101;
  sourceConfig.thumbnail!.long_edge = "640";

  const sourceBackends = source.storage_backends as Array<Record<string, unknown>>;
  const sourceArchive = sourceBackends[0]!;
  sourceArchive.future_backend_field = true;
  (sourceArchive.s3 as Record<string, unknown>).future_s3_field = true;
  sourceBackends.push(
    { ...structuredClone(sourceArchive), display_name: "重复 slug" },
    {
      slug: "missing-settings",
      display_name: "缺少设置",
      enabled: true,
      is_default: false
    },
    {
      ...structuredClone(sourceArchive),
      slug: "disabled-default",
      display_name: "停用默认",
      enabled: false,
      is_default: true
    },
    {
      ...structuredClone(sourceArchive),
      slug: "wrong-setting-type",
      display_name: "错误设置类型",
      s3: {
        ...(sourceArchive.s3 as Record<string, unknown>),
        task_timeout_seconds: "300"
      }
    }
  );

  const parsed = parseConfigBundle(source);
  const defaults = runtimeConfigDefaults();
  assert.equal(parsed.format, "future-config");
  assert.equal(parsed.application_version, null);
  assert.equal(parsed.config.site.header_name, "已采用站点");
  assert.equal(parsed.config.site.description, defaults.site.description);
  assert.equal(parsed.config.site.root, defaults.site.root);
  assert.equal("domain" in parsed.config.site, false);
  assert.equal(parsed.config.normalize.quality, 50);
  assert.equal(parsed.config.normalize.min_quality, 40);
  assert.equal(parsed.config.thumbnail.quality, defaults.thumbnail.quality);
  assert.equal(parsed.config.thumbnail.long_edge, defaults.thumbnail.long_edge);
  assert.ok(parsed.config_values.recognized > 0);
  assert.ok(parsed.config_values.defaulted > 0);
  assert.ok(parsed.config_values.ignored > 0);
  assert.equal(parsed.storage_backends.length, 1);
  assert.equal(parsed.storage_backends[0]!.slug, "archive");
  assert.equal(parsed.storage_backends[0]!.s3.secret_access_key, "secret");
  assert.equal("future_s3_field" in parsed.storage_backends[0]!.s3, false);
  assert.equal(parsed.skipped_storage_backends, 4);
  const materialized = materializeImportedRuntimeConfig(
    parsed.config,
    "target.example.com",
    "https://target-assets.example.com/static"
  );
  assert.equal(materialized.site.domain, "target.example.com");
  assert.equal(materialized.site.assets_base_url, "https://target-assets.example.com/static");
  assert.equal(materialized.site.random_size, "thumb");

  const preview = projectConfigBundlePreview(parsed, new Set(["local", "archive"]));
  assert.deepEqual(preview.config_values, parsed.config_values);
  assert.equal(preview.skipped_storage_backends, 4);
  assert.deepEqual(preview.conflicts, ["archive"]);
  assert.deepEqual(
    resolveImportedStorageBackends(parsed, new Set(["local", "archive"]), {
      archive: "archive-imported"
    }).map((backend) => backend.slug),
    ["archive-imported"]
  );
  assert.throws(
    () => resolveImportedStorageBackends(
      parsed,
      new Set(["local", "archive"]),
      {}
    ),
    (error) => error instanceof ApiError
      && error.code === "config_storage_slug_conflict"
  );
  assert.throws(
    () =>
      resolveImportedStorageBackends(parsed, new Set(["local", "archive"]), {
        archive: "bad_slug"
      }),
    (error) =>
      error instanceof ApiError &&
      error.status === 400 &&
      error.code === "config_slug_mapping_invalid"
  );

  const empty = parseConfigBundle({});
  const { domain: _domain, assets_base_url: _assets, ...portableSiteDefaults } = defaults.site;
  assert.equal(empty.format, null);
  assert.equal(empty.application_version, null);
  assert.equal(empty.exported_at, null);
  assert.deepEqual(empty.config, { ...defaults, site: portableSiteDefaults });
  assert.equal(empty.config_values.recognized, 0);
  assert.ok(empty.config_values.defaulted > 0);
  assert.equal(empty.storage_backends.length, 0);

  const loneCombinationValue = parseConfigBundle({
    config: { normalize: { quality: 10 } }
  });
  assert.equal(loneCombinationValue.config.normalize.quality, defaults.normalize.quality);
  assert.equal(loneCombinationValue.config_values.ignored, 1);

  const competingNormalizeValues = parseConfigBundle({
    config: { normalize: { quality: 10, min_quality: 30 } }
  });
  assert.equal(
    competingNormalizeValues.config.normalize.quality,
    defaults.normalize.quality,
    "只回退造成组合无效的 quality"
  );
  assert.equal(competingNormalizeValues.config.normalize.min_quality, 30);
  assert.equal(competingNormalizeValues.config_values.ignored, 1);

  const competingAltchaValues = parseConfigBundle({
    config: { altcha: { cost: 100_000, counter_range: [100, 2_000] } }
  });
  assert.equal(competingAltchaValues.config.altcha.cost, defaults.altcha.cost);
  assert.deepEqual(
    competingAltchaValues.config.altcha.counter_range,
    [100, 2_000],
    "有效 counter_range 必须在 cost 回退后保留"
  );
  assert.equal(competingAltchaValues.config_values.ignored, 1);

  for (const scalarRoot of [null, false, 0, "", []]) {
    assert.throws(
      () => parseConfigBundle(scalarRoot),
      (error) =>
        error instanceof ApiError
          && error.status === 400
          && error.code === "config_package_invalid"
    );
  }

  assert.throws(
    () =>
      parseConfigBundle({
        storage_backends: Array.from({ length: 101 }, () => null)
      }),
    (error) =>
      error instanceof ApiError
        && error.status === 400
        && error.code === "config_package_invalid"
  );
  assert.throws(
    () => parseConfigBundle({ content: "x".repeat(appConfig.configBundle.maxBytes) }),
    (error) =>
      error instanceof ApiError
        && error.status === 413
        && error.code === "config_package_too_large"
  );
});
test("[Server/配置] SPA 复用已发布快照并同步配置、验证器和嵌入权限", async () => {
  const repositoryRoot = resolve(import.meta.dirname, "../../..");
  const helperRoot = await createTestDirectory("imageshow-spa-description-");
  const helperPath = join(helperRoot, "verify-spa-description.mjs");
  const runtimeConfigUrl = pathToFileURL(
    resolve(
      repositoryRoot,
      "packages/server/dist/config/runtime-config.js"
    )
  ).href;
  const runtimeConfigStoreUrl = pathToFileURL(
    resolve(
      repositoryRoot,
      "packages/server/dist/config/runtime-config-store.js"
    )
  ).href;
  const spaRoutesUrl = pathToFileURL(
    resolve(
      repositoryRoot,
      "packages/server/dist/routes/spa.js"
    )
  ).href;
  const publicRoutesUrl = pathToFileURL(
    resolve(repositoryRoot, "packages/server/dist/routes/public.js")
  ).href;
  const settingsRoutesUrl = pathToFileURL(
    resolve(repositoryRoot, "packages/server/dist/routes/settings.js")
  ).href;
  const honoUrl = pathToFileURL(resolve(
    repositoryRoot,
    "node_modules/hono/dist/index.js"
  )).href;
  const htmlParserUrl = pathToFileURL(
    resolve(
      repositoryRoot,
      "node_modules/linkedom/esm/index.js"
    )
  ).href;
  const helperSource = `
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from ${JSON.stringify(honoUrl)};
import { parseHTML } from ${JSON.stringify(htmlParserUrl)};
import { runtimeConfigDefaults } from ${JSON.stringify(runtimeConfigUrl)};
import {
  getRuntimeConfig,
  initializeRuntimeConfig,
  updateRuntimeConfig,
  replaceRuntimeConfig,
  reloadRuntimeConfigFromDisk,
  withRuntimeConfigWriteLease,
  persistRuntimeConfigForBundleImport,
  publishRuntimeConfigForBundleImport
} from ${JSON.stringify(runtimeConfigStoreUrl)};
import { registerSpaRoutes } from ${JSON.stringify(spaRoutesUrl)};
import { registerAssetRoutes, createAssetHandler } from ${JSON.stringify(new URL("./assets.js", spaRoutesUrl).href)};
import { resourceHostBoundary } from ${JSON.stringify(new URL("./resource-host.js", spaRoutesUrl).href)};
import { registerPublicRoutes } from ${JSON.stringify(publicRoutesUrl)};
import { registerSettingsRoutes } from ${JSON.stringify(settingsRoutesUrl)};

const root = process.env.IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY;
assert.ok(root);
const config = runtimeConfigDefaults();
config.site.title = "示例 <画廊>";
config.site.header_name = "独立页头";
config.site.description = '图片 "说明" <安全>';
await writeFile(join(root, "config.json"), JSON.stringify(config));
initializeRuntimeConfig();
const app = new Hono();
app.get("/random", (c) => c.text("random-ok"));
registerPublicRoutes(app);
registerSettingsRoutes(app);
registerAssetRoutes(app);
registerSpaRoutes(app);

async function html(path = "/") {
  const response = await app.request("http://imageshow.test" + path);
  assert.equal(response.status, 200);
  return response.text();
}

const originalStringify = JSON.stringify;
let serializations = 0;
JSON.stringify = function(value, ...args) {
  if (value?.site?.title === config.site.title) serializations += 1;
  return originalStringify.call(JSON, value, ...args);
};
const first = await app.request("http://imageshow.test/");
const described = await first.text();
assert.equal(first.headers.get("content-length"), String(Buffer.byteLength(described)));
const firstEtag = first.headers.get("etag");
assert.equal(firstEtag.length, 20);
for (const path of ["/", "/home", "/show", "/gallery", "/admin", "/admin/storage"]) {
  for (const method of ["GET", "HEAD"]) {
    const cached = await app.request("http://imageshow.test" + path, {
      method, headers: { "if-none-match": '"unrelated", ' + firstEtag.replace(/^W\\//, "") }
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.headers.get("etag"), firstEtag);
    assert.equal(await cached.text(), "");
  }
  assert.equal(await html(path), described);
}
assert.equal(serializations, 1, "one published snapshot serializes its inline config once across page and conditional requests");
JSON.stringify = originalStringify;
async function verifyJsonSnapshots() {
  const etags = [];
  for (const path of ["/api/site-config", "/api/admin/settings"]) {
    const response = await app.request("http://imageshow.test" + path);
    assert.equal(response.status, 200);
    const body = await response.text();
    const result = JSON.parse(body);
    assert.equal(result.ok, true);
    const settings = path.endsWith("/settings") ? result.settings : result;
    assert.equal(settings.site.title, getRuntimeConfig().site.title);
    if (result.settings) assert.equal(settings.thumbnail.quality, getRuntimeConfig().thumbnail.quality);
    assert.match(response.headers.get("cache-control"), result.settings ? /private/ : /public/);
    assert.equal(response.headers.get("content-length"), String(Buffer.byteLength(body)));
    const etag = response.headers.get("etag");
    etags.push(etag);
    for (const method of ["GET", "HEAD"]) {
      const cached = await app.request("http://imageshow.test" + path, {
        method, headers: { "if-none-match": etag }
      });
      assert.equal(cached.status, 304);
      assert.equal(await cached.text(), "");
    }
  }
  return etags;
}
async function verifyEncodedHtml(path = "/home") {
  const identity = await app.request("http://imageshow.test" + path);
  const body = await identity.text();
  for (const [encoding, decode] of [["br", brotliDecompressSync], ["gzip", gunzipSync]]) {
    const deadline = Date.now() + 5000;
    let response;
    do {
      response = await app.request("http://imageshow.test" + path, { headers: { "accept-encoding": encoding } });
      if (response.headers.get("content-encoding") === encoding) break;
      await response.arrayBuffer();
      assert.ok(Date.now() < deadline, "HTML encoding becomes available");
      await delay(1);
    } while (true);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(decode(bytes).toString(), body);
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    assert.equal(response.headers.get("etag"), identity.headers.get("etag"));
    assert.equal(response.headers.get("content-security-policy"), identity.headers.get("content-security-policy"));
    assert.equal(response.headers.get("cache-control"), identity.headers.get("cache-control"));
    assert.match(response.headers.get("vary"), /Accept-Encoding/i);
  }
}
const initialJsonEtags = await verifyJsonSnapshots();
await verifyEncodedHtml();
assert.match(await html("/show"), /<title>示例 &lt;画廊&gt;<\\/title>/);
assert.match(described, /<title>示例 &lt;画廊&gt;<\\/title>/);
assert.match(
  described,
  /<meta name="description" content="图片 &quot;说明&quot; &lt;安全&gt;" \\/>/
);
const inlineMarker = '<script type="application/json" id="__site_config__">';
const inlineStart = described.indexOf(inlineMarker);
assert.ok(inlineStart >= 0);
const inlineText = described.slice(
  inlineStart + inlineMarker.length,
  described.indexOf("</script>", inlineStart)
);
assert.equal(inlineText.includes("<"), false);
const inlineConfig = JSON.parse(inlineText);
assert.equal(inlineConfig.site.description, '图片 "说明" <安全>');

const originalConfig = structuredClone(getRuntimeConfig());
for (const sequence of ["$$", "$&", "$" + String.fromCharCode(96), "$'"]) {
  const name = "Name " + sequence + " <safe>";
  const description = "Description " + sequence + ' "quoted" & <safe>';
  const icon = "https://example.com/icon.svg?value=" + sequence;
  const banner = "Banner " + sequence;
  const footer = 'Powered by <a href="https://example.com/">' + sequence + "</a>";
  await updateRuntimeConfig({ site: {
    title: name, header_name: "Header " + name, description, icon, footer,
    home: { banner_label: banner, banner_title: banner }
  } });
  const response = await app.request("http://imageshow.test/home");
  const document = parseHTML(await response.text()).document;
  assert.equal(document.title, name);
  assert.equal(document.querySelector('meta[name="description"]').getAttribute("content"), description);
  assert.equal(document.querySelector('link[rel="icon"]').getAttribute("href"), icon);
  const json = document.getElementById("__site_config__").textContent;
  assert.equal(json.includes("<"), false);
  const inlined = JSON.parse(json);
  assert.equal(inlined.site.title, name);
  assert.equal(inlined.site.header_name, "Header " + name);
  assert.equal(inlined.site.description, description);
  assert.equal(inlined.site.icon, icon);
  assert.equal(inlined.site.home.banner_label, banner);
  assert.equal(inlined.site.home.banner_title, banner);
  assert.equal(inlined.site.footer, footer);
  const cached = await app.request("http://imageshow.test/home", {
    headers: { "if-none-match": response.headers.get("etag") }
  });
  assert.equal(cached.status, 304);
}
await updateRuntimeConfig(originalConfig);

// A private configuration change keeps the same public representation.
await updateRuntimeConfig({ thumbnail: { quality: originalConfig.thumbnail.quality === 75 ? 76 : 75 } });
const privateChangeEtags = await verifyJsonSnapshots();
assert.equal(privateChangeEtags[0], initialJsonEtags[0]);
assert.notEqual(privateChangeEtags[1], initialJsonEtags[1]);
assert.equal((await app.request("http://imageshow.test/home", {
  headers: { "if-none-match": firstEtag }
})).status, 304);

const replacement = structuredClone(getRuntimeConfig());
replacement.site.title = "Replacement 😀";
await replaceRuntimeConfig(replacement);
assert.notEqual((await verifyJsonSnapshots())[0], initialJsonEtags[0]);
await verifyEncodedHtml();
assert.match(await html(), /Replacement 😀/);
const reloaded = structuredClone(replacement);
reloaded.site.title = "Reloaded snapshot";
await writeFile(join(root, "config.json"), JSON.stringify(reloaded));
await verifyJsonSnapshots();
assert.match(await html(), /Replacement 😀/);
await reloadRuntimeConfigFromDisk();
await verifyJsonSnapshots();
assert.match(await html(), /Reloaded snapshot/);

await withRuntimeConfigWriteLease(async () => {
  const beforeImport = structuredClone(getRuntimeConfig());
  const candidate = structuredClone(beforeImport);
  candidate.site.title = "Imported snapshot";
  persistRuntimeConfigForBundleImport(candidate);
  await verifyJsonSnapshots();
  assert.match(await html(), /Reloaded snapshot/);
  persistRuntimeConfigForBundleImport(beforeImport);
  assert.match(await html(), /Reloaded snapshot/);
  persistRuntimeConfigForBundleImport(candidate);
  publishRuntimeConfigForBundleImport(candidate);
  await verifyJsonSnapshots();
  assert.match(await html(), /Imported snapshot/);
});
await replaceRuntimeConfig(originalConfig);

// All embedded public pages share the same enable switch and ancestor policy.
for (const path of ["/embed/home", "/embed/show", "/embed/gallery"]) {
  assert.equal((await app.request("http://imageshow.test" + path)).status, 404);
}
await updateRuntimeConfig({
  site: { root: "show", show: { mode: "float" } },
  embed: { enabled: true, allowed_origins: ["https://portal.example.com"] }
});
const rootShow = await app.request("http://imageshow.test/");
assert.equal(rootShow.status, 200);
assert.equal(rootShow.headers.get("location"), null);
assert.ok(rootShow.headers.get("content-security-policy")?.includes("script-src 'self'"));
for (const path of [
  "/embed/home", "/embed/gallery", "/embed/show",
  "/embed/show?mode=float", "/embed/show?mode=waterfall&theme=stage"
]) {
  const response = await app.request("http://imageshow.test" + path);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.ok(response.headers.get("cache-control")?.includes("no-store"));
  assert.ok(response.headers.get("content-security-policy")?.includes("frame-ancestors"));
  assert.ok(response.headers.get("content-security-policy")?.includes("frame-ancestors 'self'"));
  assert.ok(response.headers.get("content-security-policy")?.includes("https://portal.example.com"));
  assert.equal(response.headers.get("x-frame-options"), null);
  const body = await response.text();
  const start = body.indexOf(inlineMarker) + inlineMarker.length;
  const embeddedConfig = JSON.parse(body.slice(start, body.indexOf("</script>", start)));
  assert.equal(embeddedConfig.site.show.mode, "float");
}
const oldEmbed = await app.request("http://imageshow.test/embed/show");
await verifyEncodedHtml("/embed/show");
await updateRuntimeConfig({ embed: { allowed_origins: ["https://other.example.com"] } });
const newEmbed = await app.request("http://imageshow.test/embed/show", {
  headers: { "if-none-match": oldEmbed.headers.get("etag"), "accept-encoding": "br" }
});
assert.equal(newEmbed.status, 304);
assert.equal(newEmbed.headers.get("content-encoding"), null);
assert.ok(newEmbed.headers.get("content-security-policy").includes("https://other.example.com"));
assert.ok(!newEmbed.headers.get("content-security-policy").includes("https://portal.example.com"));
await updateRuntimeConfig({ embed: { enabled: false } });
assert.equal((await app.request("http://imageshow.test/embed/show?mode=float")).status, 404);

await updateRuntimeConfig({ site: { description: "" } });
assert.match(
  await html(),
  /<meta name="description" content="示例 &lt;画廊&gt;" \\/>/
);
await updateRuntimeConfig({
  site: {
    home: { enabled: false },
    show: { enabled: false },
    gallery: { enabled: false }
  }
});
const unavailableRoot = await app.request("http://imageshow.test/");
assert.equal(unavailableRoot.status, 404);
assert.deepEqual(await unavailableRoot.json(), {
  ok: false,
  code: "not_found",
  error: "Not Found"
});
assert.equal((await app.request("http://imageshow.test/random")).status, 200);
assert.equal((await app.request("http://imageshow.test/admin")).status, 200);

const serveAssets = createAssetHandler();
let gateOpen = true;
const resources = new Hono();
resources.use("*", resourceHostBoundary(() => gateOpen, serveAssets));
registerAssetRoutes(resources, serveAssets);
registerSpaRoutes(resources);
const request = (host, path, method = "GET", headers = {}) => resources.request("http://internal.test" + path, {
  method, headers: { Host: host, ...headers }
});
await updateRuntimeConfig({ site: { domain: "main.example.test", icon: "/assets/brand/favicon.svg" } });
const oldPage = await request("main.example.test", "/admin");
const oldPageEtag = oldPage.headers.get("etag");
const mainPath = parseHTML(await oldPage.text()).document.querySelector('script[type="module"][src]').getAttribute("src");
assert.ok(mainPath.startsWith("/assets/"));
for (const base of ["https://asset.example.test///", "https://asset.example.test:8443///static//nested///", "https://asset.example.test/资源///"]) {
  await updateRuntimeConfig({ site: { assets_base_url: base } });
  const canonical = getRuntimeConfig().site.assets_base_url;
  const parsed = new URL(canonical);
  const page = await request("main.example.test", "/admin/images", "GET", { "If-None-Match": oldPageEtag });
  assert.equal(page.status, 200);
  assert.notEqual(page.headers.get("etag"), oldPageEtag);
  assert.ok(page.headers.get("content-security-policy").includes(parsed.origin));
  const { document } = parseHTML(await page.text());
  const script = document.querySelector('script[type="module"][src]').getAttribute("src");
  assert.equal(script, canonical + mainPath.slice("/assets".length));
  assert.equal(document.querySelector('link[rel="icon"]').getAttribute("href"), canonical + "/brand/favicon.svg");
  const icon = await request(parsed.host, new URL(canonical + "/brand/favicon.svg").pathname);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get("content-type"), /image\\/svg/);
  await icon.text();
  const path = new URL(script).pathname;
  for (const encoding of ["identity", "br", "zstd", "gzip"]) {
    const headers = { "Accept-Encoding": encoding };
    const response = await request(parsed.host, path, "GET", headers);
    const mainResponse = await request("main.example.test", mainPath, "GET", headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(response.headers.get("Cache-Control"), /immutable/);
    assert.equal(response.headers.get("Content-Encoding"), encoding === "identity" ? null : encoding);
    assert.equal(response.headers.get("ETag"), mainResponse.headers.get("ETag"));
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(bytes, Buffer.from(await mainResponse.arrayBuffer()));
    for (const method of ["GET", "HEAD"]) {
      const unchanged = await request(parsed.host, path, method, { ...headers, "If-None-Match": response.headers.get("ETag") });
      assert.equal(unchanged.status, 304);
      assert.equal(unchanged.headers.get("Access-Control-Allow-Origin"), "*");
      assert.equal(await unchanged.text(), "");
    }
    const head = await request(parsed.host, path, "HEAD", headers);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("Content-Length"), String(bytes.length));
    assert.equal(await head.text(), "");
    const range = await request(parsed.host, path, "GET", { ...headers, Range: "bytes=0-7" });
    assert.equal(range.status, 206);
    assert.deepEqual(Buffer.from(await range.arrayBuffer()), bytes.subarray(0, 8));
  }
  const preflight = await request(parsed.host, path, "OPTIONS", {
    Origin: "https://main.example.test", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "Range, If-None-Match"
  });
  assert.equal(preflight.status, 204);
  assert.equal((await request(parsed.host, path, "OPTIONS", { "Access-Control-Request-Method": "DELETE" })).status, 403);
  const root = parsed.pathname === "/" ? "" : parsed.pathname;
  for (const forbidden of ["/", "/api/site-config", "/random", "/livez", "/admin", root + "/missing.js",
    root + "/index.html", root + "/%5c..%5cindex.html", root + "/%2e%2e%2findex.html", root + "/../index.html",
    (root || "/") + "-other/" + mainPath.split("/").at(-1)]) {
    const result = await request(parsed.host, forbidden);
    assert.equal(result.status, 404, canonical + " " + forbidden);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
  }
  assert.equal((await request(parsed.host, path, "POST")).status, 404);
  gateOpen = false;
  assert.equal((await request(parsed.host, path)).status, 503);
  gateOpen = true;
  await updateRuntimeConfig({ embed: { enabled: true }, site: { home: { enabled: true } } });
  const embed = await request("main.example.test", "/embed/home");
  assert.ok(embed.headers.get("content-security-policy").includes(parsed.origin));
  await embed.text();
}
await updateRuntimeConfig({ site: { assets_base_url: "" } });
assert.equal((await request("asset.example.test", "/assets/missing.js")).status, 404);
const restoredPage = await request("main.example.test", "/admin");
const restoredDoc = parseHTML(await restoredPage.text()).document;
assert.ok(restoredDoc.querySelector('script[type="module"][src]').getAttribute("src").startsWith("/assets/"));
console.log("spa-description-ok");
`;
  try {
    await writeFile(helperPath, helperSource);
    const result = await runProcess(process.execPath, [helperPath], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NODE_ENV: "development",
        IMAGESHOW_DEVELOPMENT_DATA_DIRECTORY: toNamespacedPath(helperRoot)
      },
      timeoutMs: 30_000
    });
    assert.match(result.stdout, /spa-description-ok/);
  } finally {
    await rm(helperRoot, { recursive: true, force: true });
  }
});
test("[Server/配置] 存储显示名统一使用配置值并为缺省名称提供稳定标签", () => {
  assert.equal(
    storageBackendLabel({
      storage_slug: "archive",
      storage_display_name: "  归档存储  "
    }),
    "归档存储"
  );
  assert.equal(
    storageBackendLabel({
      storage_slug: "local",
      storage_display_name: ""
    }),
    "本地存储"
  );
  assert.equal(
    storageBackendLabel({
      storage_slug: "archive",
      storage_display_name: null
    }),
    "archive"
  );
});
