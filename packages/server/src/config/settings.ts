import { z } from "zod";
import { appConfig, slugPattern, type StorageType } from "@imageshow/shared";
import { pool, withTransaction } from "../core/db.js";
import { getRuntimeConfig, reloadRuntimeConfig, updateRuntimeConfig, type RuntimeConfig } from "./env.js";
import { galleryLimit, galleryOrder, homeHeroBackground, homeTagline, imagePageSize, importGlobalConcurrency, linkFetchTimeoutSeconds, linkImageConcurrency, listPageSize, loginBackground, maxFileSizeMb, maxLongEdge, normalizeMaxLongEdge, normalizeMaxSizeKb, normalizeMinQuality, normalizeQuality, normalizeQualityStep, previewDelayMs, randomMethod, recentUploads, rootRedirect, siteDomain, siteIconUrl, siteName, skipWebpUnderKb, thumbnailLongEdge, thumbnailQuality, uploadConcurrency } from "./schema.js";
import { ApiError } from "../core/http.js";
import { clearStorageDriverCache } from "../storage/storage-backend.js";

const s3SettingsSchema = z.object({
  endpoint: z.string().trim().default(""),
  region: z.string().trim().default("auto"),
  bucket: z.string().trim().default(""),
  access_key_id: z.string().trim().default(""),
  secret_access_key: z.string().trim().optional(),
  force_path_style: z.boolean().default(true),
  root_path: z.string().trim().regex(/^\/?(?:[a-zA-Z0-9._-]+\/?)*$/, "root_path must be a simple absolute path").default("/"),
  public_base_url: z.string().trim().default("")
});

const webdavSettingsSchema = z.object({
  base_url: z.string().trim().default(""),
  username: z.string().trim().default(""),
  password: z.string().trim().optional(),
  root_path: z.string().trim().regex(/^\/?(?:[a-zA-Z0-9._-]+\/?)*$/, "root_path must be a simple absolute path").default("/"),
  public_base_url: z.string().trim().default(""),
  list_depth_infinity: z.boolean().default(false)
});

export type { StorageType } from "@imageshow/shared";
export type S3Settings = z.infer<typeof s3SettingsSchema>;
type WebdavSettings = z.infer<typeof webdavSettingsSchema>;

export type StorageConfig = { slug: string; type: StorageType; s3: S3Settings; webdav: WebdavSettings };

export type StorageBackendRecord = {
  slug: string;
  display_name: string;
  type: StorageType;
  enabled: boolean;
  is_default: boolean;
  s3: S3Settings;
  webdav: WebdavSettings;
};

const storageSlugInput = z.string().trim().toLowerCase().min(1).max(32).regex(slugPattern);
const storageDisplayInput = z.string().trim().max(64);

export const storageBackendCreateInput = z.object({
  slug: storageSlugInput,
  display_name: storageDisplayInput.optional().default(""),
  type: z.enum(["s3", "webdav"]).default("s3"),
  s3: s3SettingsSchema.optional().prefault({}),
  webdav: webdavSettingsSchema.optional().prefault({})
});

export const storageBackendUpdateInput = z.object({
  display_name: storageDisplayInput.optional(),
  enabled: z.boolean().optional(),
  s3: s3SettingsSchema.optional(),
  webdav: webdavSettingsSchema.optional()
});

export type StorageBackendCreateInput = z.infer<typeof storageBackendCreateInput>;
export type StorageBackendUpdateInput = z.infer<typeof storageBackendUpdateInput>;

const siteHomeConfigSchema = z.object({
  enabled: z.boolean().default(appConfig.runtimeDefaults.site.home.enabled),
  tagline: homeTagline.default(appConfig.runtimeDefaults.site.home.tagline),
  hero_background: homeHeroBackground.default(appConfig.runtimeDefaults.site.home.hero_background),
  preview_delay_ms: previewDelayMs.default(appConfig.runtimeDefaults.site.home.preview_delay_ms)
});

const appSettingsSchema = z.object({
  site: z.object({
    name: siteName.optional(),
    domain: siteDomain.optional(),
    icon_url: siteIconUrl.optional(),
    root_redirect: rootRedirect.optional(),
    docs_enabled: z.boolean().optional(),
    home: siteHomeConfigSchema.optional(),
    gallery: z.object({
      default_limit: galleryLimit.default(appConfig.runtimeDefaults.site.gallery.default_limit),
      order: galleryOrder.default(appConfig.runtimeDefaults.site.gallery.order)
    }).optional(),
    random_default_method: randomMethod.optional()
  }).optional(),
  upload: z.object({
    max_file_size_mb: maxFileSizeMb.default(appConfig.runtimeDefaults.upload.max_file_size_mb),
    max_long_edge: maxLongEdge.default(appConfig.runtimeDefaults.upload.max_long_edge),
    list_page_size: listPageSize.default(appConfig.runtimeDefaults.upload.list_page_size),
    concurrency: uploadConcurrency.default(appConfig.runtimeDefaults.upload.concurrency),
    global_concurrency: importGlobalConcurrency.default(appConfig.runtimeDefaults.upload.global_concurrency)
  }).optional(),
  link_image: z.object({
    fill_original_url: z.boolean().default(appConfig.runtimeDefaults.link_image.fill_original_url),
    concurrency: linkImageConcurrency.default(appConfig.runtimeDefaults.link_image.concurrency),
    global_concurrency: importGlobalConcurrency.default(appConfig.runtimeDefaults.link_image.global_concurrency),
    fetch_timeout_seconds: linkFetchTimeoutSeconds.default(appConfig.runtimeDefaults.link_image.fetch_timeout_seconds)
  }).optional(),
  normalize: z.object({
    quality: normalizeQuality.default(appConfig.runtimeDefaults.normalize.quality),
    quality_step: normalizeQualityStep.default(appConfig.runtimeDefaults.normalize.quality_step),
    min_quality: normalizeMinQuality.default(appConfig.runtimeDefaults.normalize.min_quality),
    max_long_edge: normalizeMaxLongEdge.default(appConfig.runtimeDefaults.normalize.max_long_edge),
    max_size_kb: normalizeMaxSizeKb.default(appConfig.runtimeDefaults.normalize.max_size_kb),
    skip_webp_under_kb: skipWebpUnderKb.default(appConfig.runtimeDefaults.normalize.skip_webp_under_kb)
  }).optional(),
  thumbnail: z.object({
    long_edge: thumbnailLongEdge.default(appConfig.runtimeDefaults.thumbnail.long_edge),
    quality: thumbnailQuality.default(appConfig.runtimeDefaults.thumbnail.quality)
  }).optional(),
  image_detail: z.object({
    title_opens_image: z.boolean().default(appConfig.runtimeDefaults.image_detail.title_opens_image)
  }).optional(),
  admin: z.object({
    login_background: loginBackground.default(appConfig.runtimeDefaults.admin.login_background),
    image_page_size: imagePageSize.default(appConfig.runtimeDefaults.admin.image_page_size),
    recent_uploads: recentUploads.default(appConfig.runtimeDefaults.admin.recent_uploads),
    show_unset_theme_card: z.boolean().default(appConfig.runtimeDefaults.admin.show_unset_theme_card)
  }).optional()
});

export type AppSettingsInput = z.infer<typeof appSettingsSchema>;

const defaultS3Settings: S3Settings = Object.freeze(s3SettingsSchema.parse({}));
const defaultWebdavSettings: WebdavSettings = Object.freeze(webdavSettingsSchema.parse({}));

export function missingS3Fields(s3: S3Settings): string[] {
  const fields: Array<[string, string | undefined]> = [
    ["endpoint", s3.endpoint],
    ["bucket", s3.bucket],
    ["access_key_id", s3.access_key_id],
    ["secret_access_key", s3.secret_access_key]
  ];
  return fields.filter(([, value]) => !value).map(([key]) => key);
}

function missingWebdavFields(webdav: WebdavSettings): string[] {
  return webdav.base_url ? [] : ["base_url"];
}

export function parseSettingsInput(value: unknown) {
  const result = appSettingsSchema.safeParse(value);
  if (!result.success) {
    throw new ApiError(400, "validation_error", "Validation failed", result.error.flatten());
  }
  return result.data;
}

const storageCacheTtlMs = appConfig.folderMapTtlSeconds * 1000;
let storageCache: StorageBackendRecord[] | null = null;
let storageCacheExpiresAt = 0;
let storageLoad: Promise<StorageBackendRecord[]> | null = null;

async function loadStorageBackends(): Promise<StorageBackendRecord[]> {
  const rows = (await pool.query(
    "SELECT slug, display_name, type, config, enabled, is_default FROM storage_backend ORDER BY (slug = 'local') DESC, sort_order ASC, slug ASC"
  )).rows;
  return rows.map((row) => {
    const config = typeof row.config === "object" && row.config ? row.config : {};
    const type = row.type as StorageType;
    return {
      slug: row.slug as string,
      display_name: row.display_name as string,
      type,
      enabled: Boolean(row.enabled),
      is_default: Boolean(row.is_default),
      s3: type === "s3" ? s3SettingsSchema.parse(config) : defaultS3Settings,
      webdav: type === "webdav" ? webdavSettingsSchema.parse(config) : defaultWebdavSettings
    };
  });
}

async function getStorageBackends(): Promise<StorageBackendRecord[]> {
  if (storageCache && Date.now() < storageCacheExpiresAt) return storageCache;
  if (!storageLoad) storageLoad = loadStorageBackends();
  const current = storageLoad;
  try {
    const loaded = await current;
    storageCache = loaded;
    storageCacheExpiresAt = Date.now() + storageCacheTtlMs;
    return loaded;
  } finally {
    if (storageLoad === current) storageLoad = null;
  }
}

function invalidateStorageCache() {
  storageCache = null;
  storageCacheExpiresAt = 0;
  clearStorageDriverCache();
}

function toConfig(record: StorageBackendRecord): StorageConfig {
  return { slug: record.slug, type: record.type, s3: record.s3, webdav: record.webdav };
}

export async function listStorageBackends(): Promise<StorageBackendRecord[]> {
  return getStorageBackends();
}

export async function getStorageBackend(slug: string): Promise<StorageConfig> {
  const record = (await getStorageBackends()).find((backend) => backend.slug === slug);
  if (!record) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  return toConfig(record);
}

export async function assertStorageWritable(slug: string): Promise<StorageConfig> {
  const config = await getStorageBackend(slug);
  const missing = config.type === "s3" ? missingS3Fields(config.s3)
    : config.type === "webdav" ? missingWebdavFields(config.webdav)
    : [];
  if (missing.length) throw new ApiError(400, "storage_config_incomplete", "Storage config incomplete", { missing });
  return config;
}

export async function assertStorageUploadable(slug: string): Promise<StorageConfig> {
  const record = (await getStorageBackends()).find((backend) => backend.slug === slug);
  if (!record) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  if (!record.enabled) throw new ApiError(400, "storage_backend_disabled", "该存储后端已停用，不能作为新图片的写入目标");
  return assertStorageWritable(slug);
}

async function getDefaultStorageRecord(): Promise<StorageBackendRecord> {
  const backends = await getStorageBackends();
  const record = backends.find((backend) => backend.is_default)
    ?? backends.find((backend) => backend.slug === "local")
    ?? backends[0];
  if (!record) throw new ApiError(503, "storage_unconfigured", "No storage backend configured");
  return record;
}

export async function getDefaultStorageBackend(): Promise<StorageConfig> {
  return toConfig(await getDefaultStorageRecord());
}

export async function getDefaultStorageSlug(): Promise<string> {
  return (await getDefaultStorageRecord()).slug;
}

export async function listStorageBackendOptions() {
  return (await getStorageBackends())
    .map((backend) => ({ slug: backend.slug, display_name: backend.display_name, type: backend.type, enabled: backend.enabled, is_default: backend.is_default }));
}

export async function getStorageBackendsForAdmin() {
  const backends = await getStorageBackends();
  return backends.map((backend) => ({
    slug: backend.slug,
    display_name: backend.display_name,
    type: backend.type,
    enabled: backend.enabled,
    is_default: backend.is_default,
    s3: {
      ...backend.s3,
      secret_access_key: undefined,
      secret_access_key_configured: Boolean(backend.s3.secret_access_key)
    },
    webdav: {
      ...backend.webdav,
      password: undefined,
      password_configured: Boolean(backend.webdav.password)
    }
  }));
}

export async function createStorageBackend(input: StorageBackendCreateInput) {
  if (input.slug === "local") throw new ApiError(400, "storage_backend_reserved", "'local' 是内置后端，不能新建");
  const config = input.type === "webdav" ? input.webdav : input.s3;

  await pool.query(
    `INSERT INTO storage_backend(slug, display_name, type, config, enabled, sort_order)
     VALUES($1, $2, $3, $4::jsonb, true, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM storage_backend))`,
    [input.slug, input.display_name, input.type, JSON.stringify(config)]
  ).catch((error: unknown) => {
    if (error && typeof error === "object" && (error as { code?: string }).code === "23505") {
      throw new ApiError(409, "storage_backend_exists", `存储后端已存在: ${input.slug}`);
    }
    throw error;
  });
  invalidateStorageCache();
}

export async function updateStorageBackend(slug: string, input: StorageBackendUpdateInput) {
  await withTransaction(async (client) => {
    const row = (await client.query("SELECT slug, type, config, is_default FROM storage_backend WHERE slug=$1 FOR UPDATE", [slug])).rows[0];
    if (!row) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
    if (input.enabled === false && row.is_default) throw new ApiError(400, "storage_default_enabled", "默认后端不能停用，请先切换默认后端");
    const rowConfig = typeof row.config === "object" && row.config ? row.config : {};

    let configJson: string | null = null;
    if (row.type === "s3") {
      const current = s3SettingsSchema.parse(rowConfig);
      const next = input.s3 ? s3SettingsSchema.parse(input.s3) : current;
      if (!next.secret_access_key) next.secret_access_key = current.secret_access_key;
      configJson = JSON.stringify(next);
    } else if (row.type === "webdav") {
      const current = webdavSettingsSchema.parse(rowConfig);
      const next = input.webdav ? webdavSettingsSchema.parse(input.webdav) : current;
      if (!next.password) next.password = current.password;
      configJson = JSON.stringify(next);
    }
    await client.query(
      `UPDATE storage_backend
       SET display_name=COALESCE($2, display_name),
           enabled=COALESCE($3, enabled),
           config=COALESCE($4::jsonb, config),
           updated_at=now()
       WHERE slug=$1`,
      [slug, input.display_name ?? null, input.enabled ?? null, configJson]
    );
  });
  invalidateStorageCache();
}

export async function deleteStorageBackend(slug: string) {
  if (slug === "local") throw new ApiError(400, "storage_backend_reserved", "'local' 是内置后端，不能删除");
  const row = (await pool.query("SELECT is_default FROM storage_backend WHERE slug=$1", [slug])).rows[0];
  if (!row) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  if (row.is_default) throw new ApiError(400, "storage_default_delete", "默认后端不能删除，请先切换默认后端");
  await pool.query("DELETE FROM storage_backend WHERE slug=$1", [slug]).catch((error: unknown) => {
    if (error && typeof error === "object" && (error as { code?: string }).code === "23503") {
      throw new ApiError(409, "storage_backend_in_use", "该存储后端仍有图片在使用，无法删除");
    }
    throw error;
  });
  invalidateStorageCache();
}

export async function setDefaultStorageBackend(slug: string) {
  await withTransaction(async (client) => {
    const row = (await client.query("SELECT enabled FROM storage_backend WHERE slug=$1 FOR UPDATE", [slug])).rows[0];
    if (!row) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
    if (!row.enabled) throw new ApiError(400, "storage_default_disabled", "不能将已停用的后端设为默认");

    await client.query("UPDATE storage_backend SET is_default=false, updated_at=now() WHERE is_default");
    await client.query("UPDATE storage_backend SET is_default=true, updated_at=now() WHERE slug=$1", [slug]);
  });
  invalidateStorageCache();
}

export async function reorderStorageBackends(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE storage_backend b SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE b.slug = v.slug AND b.slug <> 'local'`,
    [slugs]
  );
  invalidateStorageCache();
}

export async function resolveStorageTestConfig(input: { slug?: string; type?: string; s3?: unknown; webdav?: unknown }): Promise<StorageConfig> {
  if (input.slug) return getStorageBackend(input.slug);
  if (input.type === "webdav" || input.webdav) {
    return { slug: "(test)", type: "webdav", s3: defaultS3Settings, webdav: webdavSettingsSchema.parse(input.webdav ?? {}) };
  }
  return { slug: "(test)", type: "s3", s3: s3SettingsSchema.parse(input.s3 ?? {}), webdav: defaultWebdavSettings };
}

async function getAppSettings() {
  const runtime = getRuntimeConfig();
  return {
    site: runtime.site,
    upload: runtime.upload,
    link_image: runtime.link_image,
    normalize: runtime.normalize,
    thumbnail: runtime.thumbnail,
    image_detail: runtime.image_detail,
    admin: runtime.admin,
    background_job: runtime.background_job
  };
}

export function reloadAppConfig() {
  reloadRuntimeConfig();
  invalidateStorageCache();
}

export async function getUploadLimitBytes() {
  return Math.floor(getRuntimeConfig().upload.max_file_size_mb * 1024 * 1024);
}

export async function getImageMaxLongEdge() {
  return Math.floor(getRuntimeConfig().upload.max_long_edge);
}

export function getThumbnailSettings() {
  return getRuntimeConfig().thumbnail;
}

export async function getSettingsForAdmin() {
  const settings = await getAppSettings();
  const { name, domain, icon_url, root_redirect, home, gallery, random_default_method, docs_enabled } = settings.site;
  const { login_background, image_page_size, recent_uploads, show_unset_theme_card } = settings.admin;
  return {
    site: { name, domain, icon_url, root_redirect, home, gallery, random_default_method, docs_enabled },
    upload: settings.upload,
    normalize: settings.normalize,
    thumbnail: settings.thumbnail,
    image_detail: settings.image_detail,
    admin: { login_background, image_page_size, recent_uploads, show_unset_theme_card },
    link_image: settings.link_image
  };
}

function randomApiBackground(domain: string) {
  return `https://${domain}/random?m=redirect`;
}
function effectiveLoginBackground(input: { login_background?: string }) {
  return input.login_background?.trim() || "/random?m=redirect";
}
function effectiveHomeHeroBackground(site: { home: { hero_background?: string }; domain: string }) {
  return site.home.hero_background?.trim() || randomApiBackground(site.domain);
}

export function getEffectiveLoginBackground() {
  const runtime = getRuntimeConfig();
  return effectiveLoginBackground({ login_background: runtime.admin.login_background });
}

export function siteConfigPayload() {
  const runtime = getRuntimeConfig();
  const { name, domain, icon_url, root_redirect, home, gallery, random_default_method, docs_enabled } = runtime.site;
  return {
    site: {
      name,
      domain,
      icon_url,
      root_redirect,
      home: { ...home, hero_background: effectiveHomeHeroBackground(runtime.site) },
      gallery,
      random_default_method,
      docs_enabled
    },
    image_detail: runtime.image_detail
  };
}

export async function saveAppSettings(input: AppSettingsInput) {
  const runtimePatch: Partial<RuntimeConfig> = {};
  if (input.site) runtimePatch.site = input.site as RuntimeConfig["site"];
  if (input.upload) runtimePatch.upload = input.upload as RuntimeConfig["upload"];
  if (input.link_image) runtimePatch.link_image = input.link_image as RuntimeConfig["link_image"];
  if (input.normalize) runtimePatch.normalize = input.normalize as RuntimeConfig["normalize"];
  if (input.thumbnail) runtimePatch.thumbnail = input.thumbnail as RuntimeConfig["thumbnail"];
  if (input.image_detail) runtimePatch.image_detail = input.image_detail;
  if (input.admin) runtimePatch.admin = input.admin as RuntimeConfig["admin"];
  if (Object.keys(runtimePatch).length) updateRuntimeConfig(runtimePatch);
}
