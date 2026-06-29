// Application settings. Two independent stores:
//   1. Named storage backends — a `storage_backend` table (slug PK, type, JSON
//      config incl. the S3 secret). Resolved on hot paths through an in-process TTL
//      memo (secrets are kept out of Redis on purpose).
//   2. All other runtime settings — the file-backed config (config/env.ts).
import { z } from "zod";
import { appConfig, slugPattern } from "@imageshow/shared";
import { pool, withTransaction } from "../core/db.js";
import { getRuntimeConfig, reloadRuntimeConfig, updateRuntimeConfig, type RuntimeConfig } from "./env.js";
import { galleryLimit, galleryOrder, imagePageSize, listPageSize, maxFileSizeMb, maxLongEdge, previewDelayMs, randomMethod, recentUploads, rootRedirect, siteDomain, siteHomeHeroBackground, siteIconUrl, siteLoginBackground, siteName, uploadConcurrency } from "./schema.js";
import { ApiError } from "../core/http.js";

// S3-compatible object-storage settings. Stored as the storage_backend.config JSON
// for type='s3' rows; '{}' for local rows parses to these (unused) defaults.
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

// WebDAV settings (HTTP Basic auth). Stored as the storage_backend.config JSON for
// type='webdav' rows. `password` is the secret, stripped on read like the S3 secret.
const webdavSettingsSchema = z.object({
  base_url: z.string().trim().default(""),
  username: z.string().trim().default(""),
  password: z.string().trim().optional(),
  root_path: z.string().trim().regex(/^\/?(?:[a-zA-Z0-9._-]+\/?)*$/, "root_path must be a simple absolute path").default("/"),
  public_base_url: z.string().trim().default(""),
  // Off by default — some WebDAV servers reject a Depth: infinity PROPFIND. When the server
  // does support it, turning this on lets listKeys enumerate a whole prefix in one request
  // instead of a recursive Depth: 1 walk (much faster for the storage check).
  list_depth_infinity: z.boolean().default(false)
});

// A backend's driver kind.
export type StorageType = "local" | "s3" | "webdav";
export type S3Settings = z.infer<typeof s3SettingsSchema>;
export type WebdavSettings = z.infer<typeof webdavSettingsSchema>;

// A resolved backend, ready to drive storage operations. `s3` and `webdav` are always
// present (defaulted for other types) so each driver / key mapper reads its own
// unconditionally.
export type StorageConfig = { slug: string; type: StorageType; s3: S3Settings; webdav: WebdavSettings };

// A registry row as the admin manages it (the resolved view, secrets included).
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

// S3 and WebDAV backends are user-creatable; 'local' is the seeded built-in. The
// config object for the chosen type is read (s3 for s3, webdav for webdav).
export const storageBackendCreateInput = z.object({
  slug: storageSlugInput,
  display_name: storageDisplayInput.optional().default(""),
  type: z.enum(["s3", "webdav"]).default("s3"),
  s3: s3SettingsSchema.optional().default({}),
  webdav: webdavSettingsSchema.optional().default({})
});

export const storageBackendUpdateInput = z.object({
  display_name: storageDisplayInput.optional(),
  enabled: z.boolean().optional(),
  s3: s3SettingsSchema.optional(),
  webdav: webdavSettingsSchema.optional()
});

export type StorageBackendCreateInput = z.infer<typeof storageBackendCreateInput>;
export type StorageBackendUpdateInput = z.infer<typeof storageBackendUpdateInput>;

const homeConfigSchema = z.object({
  preview_delay_ms: previewDelayMs.default(1_000)
});

// Runtime (file-backed) settings only; storage lives in its own table.
const appSettingsSchema = z.object({
  site: z.object({
    name: siteName.optional(),
    domain: siteDomain.optional(),
    icon_url: siteIconUrl.optional(),
    root_redirect: rootRedirect.optional(),
    login_background: siteLoginBackground.optional(),
    home_hero_background: siteHomeHeroBackground.optional()
  }).optional(),
  home: homeConfigSchema.optional(),
  upload: z.object({
    max_file_size_mb: maxFileSizeMb.default(appConfig.runtimeDefaults.upload.max_file_size_mb),
    max_long_edge: maxLongEdge.default(appConfig.runtimeDefaults.upload.max_long_edge),
    list_page_size: listPageSize.default(appConfig.runtimeDefaults.upload.list_page_size),
    concurrency: uploadConcurrency.default(appConfig.runtimeDefaults.upload.concurrency)
  }).optional(),
  admin: z.object({
    image_page_size: imagePageSize.default(appConfig.runtimeDefaults.admin.image_page_size),
    recent_uploads: recentUploads.default(appConfig.runtimeDefaults.admin.recent_uploads)
  }).optional(),
  gallery: z.object({
    default_limit: galleryLimit.default(appConfig.runtimeDefaults.gallery.default_limit),
    order: galleryOrder.default(appConfig.runtimeDefaults.gallery.order)
  }).optional(),
  random: z.object({
    default_method: randomMethod
  }).optional(),
  image_detail: z.object({
    title_opens_image: z.boolean().default(appConfig.runtimeDefaults.image_detail.title_opens_image)
  }).optional()
  // operation_log.*_concurrency is intentionally absent: those are file-only worker
  // knobs, never sent to or edited from the settings UI.
});

export type AppSettingsInput = z.infer<typeof appSettingsSchema>;

// Frozen shared defaults, assigned by reference to every backend whose type doesn't match
// (a local/webdav row's `.s3`, an s3 row's `.webdav`). Every consumer only reads them, so one
// shared instance is safe and skips re-parsing on each load; freezing turns any accidental
// future mutation into a throw instead of silently corrupting all those backends.
const defaultS3Settings: S3Settings = Object.freeze(s3SettingsSchema.parse({}));
const defaultWebdavSettings: WebdavSettings = Object.freeze(webdavSettingsSchema.parse({}));

// Returns the names of the required S3 fields that are still empty, so callers can
// report exactly what is missing before treating a backend as S3-ready.
export function missingS3Fields(s3: S3Settings): string[] {
  const fields: Array<[string, string | undefined]> = [
    ["endpoint", s3.endpoint],
    ["bucket", s3.bucket],
    ["access_key_id", s3.access_key_id],
    ["secret_access_key", s3.secret_access_key]
  ];
  return fields.filter(([, value]) => !value).map(([key]) => key);
}

// WebDAV only strictly needs a base URL; credentials are optional (some servers allow
// anonymous access), so a missing user/password just surfaces as a per-object failure.
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

// --- storage backend registry (in-process TTL memo + PostgreSQL source of truth) ---
const storageCacheTtlMs = appConfig.folderMapTtlSeconds * 1000;
let storageCache: StorageBackendRecord[] | null = null;
let storageCacheExpiresAt = 0;
let storageLoad: Promise<StorageBackendRecord[]> | null = null;

async function loadStorageBackends(): Promise<StorageBackendRecord[]> {
  const rows = (await pool.query(
    // 'local' is always pinned first; the rest follow the manual drag-to-sort order.
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
      // The row's config JSON holds exactly one settings shape (by type); the other
      // stays at its (unused) defaults.
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
}

function toConfig(record: StorageBackendRecord): StorageConfig {
  return { slug: record.slug, type: record.type, s3: record.s3, webdav: record.webdav };
}

// All backends (resolved, with secrets) — for cross-checks and admin listing.
export async function listStorageBackends(): Promise<StorageBackendRecord[]> {
  return getStorageBackends();
}

// Resolves one backend to a driver config. Throws only when the slug is unknown
// (the FK makes that impossible for real image rows); a misconfigured-but-present
// backend resolves fine and fails per-object instead of breaking the instance.
export async function getStorageBackend(slug: string): Promise<StorageConfig> {
  const record = (await getStorageBackends()).find((backend) => backend.slug === slug);
  if (!record) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  return toConfig(record);
}

// Resolves a backend and asserts it can actually accept writes (S3 creds present).
// Used by the migrate write path and by assertStorageUploadable (upload/link) so an
// unconfigured target fails fast instead of accepting bytes we can't store.
export async function assertStorageWritable(slug: string): Promise<StorageConfig> {
  const config = await getStorageBackend(slug);
  const missing = config.type === "s3" ? missingS3Fields(config.s3)
    : config.type === "webdav" ? missingWebdavFields(config.webdav)
    : [];
  if (missing.length) throw new ApiError(400, "storage_config_incomplete", "Storage config incomplete", { missing });
  return config;
}

// Like assertStorageWritable, but also rejects a disabled backend — so a *new* image
// (upload / link import) can't be written to a backend that's been turned off. Migration
// deliberately keeps using assertStorageWritable, so existing images can still move onto a
// disabled backend; reads never check enabled at all.
export async function assertStorageUploadable(slug: string): Promise<StorageConfig> {
  const record = (await getStorageBackends()).find((backend) => backend.slug === slug);
  if (!record) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  if (!record.enabled) throw new ApiError(400, "storage_backend_disabled", "该存储后端已停用，不能作为新图片的写入目标");
  return assertStorageWritable(slug);
}

// The new-upload target row: the is_default backend (falling back to local / first row).
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

// Lightweight, secret-free list of every backend (with its enabled flag) for the
// upload/migrate/check pickers, safe for any admin. `enabled` gates only the upload/link
// write-selector (the frontend filters on it); migrate and reads use the full list.
export async function listStorageBackendOptions() {
  return (await getStorageBackends())
    .map((backend) => ({ slug: backend.slug, display_name: backend.display_name, type: backend.type, enabled: backend.enabled, is_default: backend.is_default }));
}

// Admin view: same rows with the S3 secret stripped and replaced by a "configured" flag.
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
  // New backends append to the end of the manual order (local stays pinned first).
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
    // Rebuild the config JSON only for backends that have one (s3 / webdav); 'local'
    // keeps its empty config. Empty incoming secret/password means "keep the existing".
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
    // FK RESTRICT: still referenced by images (any status). Migrate them off first.
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
    // Clear then set within the transaction so the single-default partial unique
    // index never sees two true rows.
    await client.query("UPDATE storage_backend SET is_default=false, updated_at=now() WHERE is_default");
    await client.query("UPDATE storage_backend SET is_default=true, updated_at=now() WHERE slug=$1", [slug]);
  });
  invalidateStorageCache();
}

// Persists the manual drag order: each given slug's sort_order becomes its list position.
// 'local' is pinned first by the read query, so it is never part of `slugs`.
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

// Resolves a config for a connection test: an existing backend by slug, or an ad-hoc
// config from the form (s3 or webdav per the type/payload).
export async function resolveStorageTestConfig(input: { slug?: string; type?: string; s3?: unknown; webdav?: unknown }): Promise<StorageConfig> {
  if (input.slug) return getStorageBackend(input.slug);
  if (input.type === "webdav" || input.webdav) {
    return { slug: "(test)", type: "webdav", s3: defaultS3Settings, webdav: webdavSettingsSchema.parse(input.webdav ?? {}) };
  }
  return { slug: "(test)", type: "s3", s3: s3SettingsSchema.parse(input.s3 ?? {}), webdav: defaultWebdavSettings };
}

// --- runtime (file-backed) application settings ---
async function getAppSettings() {
  const runtime = getRuntimeConfig();
  return {
    site: runtime.site,
    home: homeConfigSchema.parse(runtime.home),
    upload: runtime.upload,
    admin: runtime.admin,
    gallery: runtime.gallery,
    random: runtime.random,
    image_detail: runtime.image_detail,
    link_image: runtime.link_image,
    operation_log: runtime.operation_log
  };
}

// Hot-reloads config.json from disk and drops the storage memo so the next read
// reflects any hand-edits.
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

// Thumbnail output config (long-edge cap + webp quality). File-only; read per call so a
// config.json edit + reload applies to subsequently generated thumbnails.
export function getThumbnailSettings() {
  return getRuntimeConfig().thumbnail;
}

export async function getSettingsForAdmin() {
  const settings = await getAppSettings();
  // Strip the file-only site fields (the reserved subdomain labels) so they never reach
  // the admin frontend; saving merges the rest back untouched.
  // login_background is returned raw (possibly empty = "auto") so the edit form shows
  // what's actually stored, not the derived URL.
  const { name, domain, icon_url, root_redirect, login_background, home_hero_background } = settings.site;
  // operation_log (file-only worker concurrency) is deliberately omitted — the admin
  // settings form neither shows nor saves it.
  return {
    site: { name, domain, icon_url, root_redirect, login_background, home_hero_background },
    home: settings.home,
    upload: settings.upload,
    admin: settings.admin,
    gallery: settings.gallery,
    random: settings.random,
    image_detail: settings.image_detail,
    // Read-only for the uploader (whether to pre-fill 原图URL with the imported link);
    // file-only, so the settings form neither shows nor saves it.
    link_image: settings.link_image
  };
}

// Background images (admin login page, homepage hero) default to the site's own
// random-image API, pinned to m=redirect so the background is always the cheap cacheable
// path (never the proxy), regardless of the global random.default_method. An explicit
// value (any image URL) wins.
function randomApiBackground(domain: string) {
  return `https://${domain}/random?m=redirect`;
}
export function effectiveLoginBackground(site: { login_background?: string; domain: string }) {
  return site.login_background?.trim() || randomApiBackground(site.domain);
}
export function effectiveHomeHeroBackground(site: { home_hero_background?: string; domain: string }) {
  return site.home_hero_background?.trim() || randomApiBackground(site.domain);
}

export async function saveAppSettings(input: AppSettingsInput) {
  const runtimePatch: Partial<RuntimeConfig> = {};
  if (input.site) runtimePatch.site = input.site as RuntimeConfig["site"];
  if (input.home) runtimePatch.home = input.home;
  if (input.upload) runtimePatch.upload = input.upload as RuntimeConfig["upload"];
  if (input.admin) runtimePatch.admin = input.admin as RuntimeConfig["admin"];
  if (input.gallery) runtimePatch.gallery = input.gallery;
  if (input.random) runtimePatch.random = input.random;
  if (input.image_detail) runtimePatch.image_detail = input.image_detail;
  if (Object.keys(runtimePatch).length) updateRuntimeConfig(runtimePatch);
}
