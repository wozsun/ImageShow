import { appConfig } from "@imageshow/shared";
import { pool, withAdvisoryLock, withTransaction } from "../core/db.ts";
import { ApiError } from "../core/api-error.ts";
import {
  countUnresolvedMoveCleanupJobs,
  listUnresolvedMoveCleanupJobCounts
} from "../jobs/repository.ts";
import {
  defaultS3Settings,
  defaultWebdavSettings,
  missingS3Fields,
  missingWebdavFields,
  s3SettingsSchema,
  webdavSettingsSchema,
  type StorageBackendCreateInput,
  type StorageBackendImportInput,
  type StorageBackendRecord,
  type StorageBackendUpdateInput,
  type StorageConfig,
  type StorageType
} from "./backend-config.ts";
import {
  createStorageDriver,
  type StorageDriver
} from "./storage-backend.ts";
import {
  withStorageLocationReadLock,
  withStorageLocationWriteLock
} from "./maintenance-lock.ts";
import { thumbnailRef } from "./image-paths.ts";
import { storageNamespaceIdentity } from "./storage-namespace.ts";

const storageCacheTtlMs = appConfig.derivedCacheTtlSeconds * 1000;
let storageCache: StorageBackendRecord[] | null = null;
let storageCacheExpiresAt = 0;
let storageLoad: Promise<StorageBackendRecord[]> | null = null;
const storageBackendChangeListeners = new Set<() => void>();
const storageDriverCache = new Map<string, StorageDriver>();

function storageDriverCacheKey(config: StorageConfig) {
  return JSON.stringify(config);
}

function storageDriverForConfig(config: StorageConfig) {
  if (config.slug === "(test)") return createStorageDriver(config);
  const key = storageDriverCacheKey(config);
  const cached = storageDriverCache.get(key);
  if (cached) return cached;
  const driver = createStorageDriver(config);
  storageDriverCache.set(key, driver);
  return driver;
}

function clearStorageDriverCache() {
  const drivers = [...storageDriverCache.values()];
  storageDriverCache.clear();
  for (const driver of drivers) {
    void Promise.resolve(driver.close?.()).catch(() => undefined);
  }
}

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
  const currentLoad = storageLoad;
  try {
    const loaded = await currentLoad;
    storageCache = loaded;
    storageCacheExpiresAt = Date.now() + storageCacheTtlMs;
    return loaded;
  } finally {
    if (storageLoad === currentLoad) storageLoad = null;
  }
}

function invalidateStorageBackendCache() {
  storageCache = null;
  storageCacheExpiresAt = 0;
  clearStorageDriverCache();
  for (const listener of storageBackendChangeListeners) listener();
}

export function onStorageBackendChange(listener: () => void) {
  storageBackendChangeListeners.add(listener);
  return () => storageBackendChangeListeners.delete(listener);
}

function toStorageConfig(record: StorageBackendRecord): StorageConfig {
  return {
    slug: record.slug,
    type: record.type,
    s3: record.s3,
    webdav: record.webdav
  };
}

function withStoredS3Credential(candidate: StorageConfig["s3"], current?: StorageConfig["s3"]) {
  if (candidate.secret_access_key || !current?.secret_access_key) return candidate;
  return { ...candidate, secret_access_key: current.secret_access_key };
}

function withStoredWebdavCredential(candidate: StorageConfig["webdav"], current?: StorageConfig["webdav"]) {
  if (candidate.password || !current?.password) return candidate;
  return { ...candidate, password: current.password };
}

export async function listStorageBackends(): Promise<StorageBackendRecord[]> {
  return getStorageBackends();
}

export async function getStorageBackend(slug: string): Promise<StorageConfig> {
  const record = (await getStorageBackends()).find((backend) => backend.slug === slug);
  if (!record) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  return toStorageConfig(record);
}

export async function assertStorageWritable(slug: string): Promise<StorageConfig> {
  const config = await getStorageBackend(slug);
  const missing = config.type === "s3"
    ? missingS3Fields(config.s3)
    : config.type === "webdav"
      ? missingWebdavFields(config.webdav)
      : [];
  if (missing.length) {
    throw new ApiError(400, "storage_config_incomplete", "Storage config incomplete", { missing });
  }
  return config;
}

export async function assertStorageUploadable(slug: string): Promise<StorageConfig> {
  const record = (await getStorageBackends()).find((backend) => backend.slug === slug);
  if (!record) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  if (!record.enabled) {
    throw new ApiError(400, "storage_backend_disabled", "该存储后端已停用，不能作为新图片的写入目标");
  }
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
  return toStorageConfig(await getDefaultStorageRecord());
}

export async function resolveStorageAccess(slug?: string) {
  const config = slug
    ? await getStorageBackend(slug)
    : await getDefaultStorageBackend();
  return { config, driver: storageDriverForConfig(config) };
}

export function resolveStorageAccessForConfig(config: StorageConfig) {
  return { config, driver: storageDriverForConfig(config) };
}

export async function getDefaultStorageSlug(): Promise<string> {
  return (await getDefaultStorageRecord()).slug;
}

export async function listStorageBackendOptions() {
  return (await getStorageBackends()).map((backend) => ({
    slug: backend.slug,
    display_name: backend.display_name,
    enabled: backend.enabled,
    is_default: backend.is_default
  }));
}

export async function getStorageBackendsForAdmin() {
  const backends = await getStorageBackends();
  const [imageCountRows, importSessionCountRows, cleanupCountRows] = await Promise.all([
    pool.query(
      `SELECT storage_slug, count(*)::int AS image_count
         FROM metadata
        GROUP BY storage_slug`
    ),
    pool.query(
      `SELECT storage_slug, count(*)::int AS import_session_count
         FROM import_session
        GROUP BY storage_slug`
    ),
    listUnresolvedMoveCleanupJobCounts()
  ]);
  const imageCounts = new Map<string, number>(imageCountRows.rows.map((row) => [
    String(row.storage_slug),
    Number(row.image_count ?? 0)
  ]));
  const importSessionCounts = new Map<string, number>(importSessionCountRows.rows.map((row) => [
    String(row.storage_slug),
    Number(row.import_session_count ?? 0)
  ]));
  const cleanupJobCounts = new Map<string, number>(cleanupCountRows.map((row) => [
    row.storage_slug,
    row.cleanup_job_count
  ]));
  return backends.map((backend) => {
    const summary = {
      slug: backend.slug,
      display_name: backend.display_name,
      type: backend.type,
      enabled: backend.enabled,
      is_default: backend.is_default,
      image_count: imageCounts.get(backend.slug) ?? 0,
      import_session_count: importSessionCounts.get(backend.slug) ?? 0,
      cleanup_job_count: cleanupJobCounts.get(backend.slug) ?? 0
    };
    if (backend.type === "s3") {
      const { secret_access_key, ...s3 } = backend.s3;
      return {
        ...summary,
        s3: {
          ...s3,
          secret_access_key_configured: Boolean(secret_access_key)
        }
      };
    }
    if (backend.type === "webdav") {
      const { password, ...webdav } = backend.webdav;
      return {
        ...summary,
        webdav: {
          ...webdav,
          password_configured: Boolean(password)
        }
      };
    }
    return summary;
  });
}

export async function createStorageBackend(input: StorageBackendCreateInput) {
  if (input.slug === "local") {
    throw new ApiError(400, "storage_backend_reserved", "'local' 是内置后端，不能新建");
  }
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
  invalidateStorageBackendCache();
}

export async function importStorageBackends(
  backends: StorageBackendImportInput[],
  beforeCommit: () => void | Promise<void>
) {
  try {
    await withTransaction(async (client) => {
      const highestSortOrder = Number((await client.query(
        "SELECT COALESCE(MAX(sort_order), 0) AS value FROM storage_backend"
      )).rows[0]?.value ?? 0);

      for (const [index, backend] of backends.entries()) {
        await client.query(
          `INSERT INTO storage_backend(slug, display_name, type, config, enabled, is_default, sort_order)
           VALUES($1, $2, $3, $4::jsonb, $5, false, $6)`,
          [
            backend.slug,
            backend.display_name,
            backend.type,
            JSON.stringify(backend.config),
            backend.enabled,
            highestSortOrder + index + 1
          ]
        );
      }

      const importedDefault = backends.find((backend) => backend.is_default);
      if (importedDefault) {
        await client.query("UPDATE storage_backend SET is_default=false, updated_at=now() WHERE is_default");
        await client.query(
          "UPDATE storage_backend SET is_default=true, updated_at=now() WHERE slug=$1",
          [importedDefault.slug]
        );
      }

      await beforeCommit();
    });
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: string }).code === "23505") {
      throw new ApiError(409, "storage_backend_exists", "导入的存储后端 slug 已存在");
    }
    throw error;
  }
  invalidateStorageBackendCache();
}

function storageConfigFromRow(row: {
  slug: string;
  type: StorageType;
  config: unknown;
}): StorageConfig {
  const raw = typeof row.config === "object" && row.config ? row.config : {};
  if (row.type === "s3") {
    return {
      slug: row.slug,
      type: "s3",
      s3: s3SettingsSchema.parse(raw),
      webdav: defaultWebdavSettings
    };
  }
  if (row.type === "webdav") {
    return {
      slug: row.slug,
      type: "webdav",
      s3: defaultS3Settings,
      webdav: webdavSettingsSchema.parse(raw)
    };
  }
  return {
    slug: row.slug,
    type: "local",
    s3: defaultS3Settings,
    webdav: defaultWebdavSettings
  };
}

function updatedStorageConfig(
  current: StorageConfig,
  input: StorageBackendUpdateInput
): StorageConfig {
  if (current.type === "s3") {
    if (input.webdav) {
      throw new ApiError(
        400,
        "storage_backend_type_mismatch",
        "S3 后端不能接收 WebDAV 配置"
      );
    }
    return input.s3
      ? {
          ...current,
          s3: withStoredS3Credential(s3SettingsSchema.parse(input.s3), current.s3)
        }
      : current;
  }
  if (current.type === "webdav") {
    if (input.s3) {
      throw new ApiError(
        400,
        "storage_backend_type_mismatch",
        "WebDAV 后端不能接收 S3 配置"
      );
    }
    return input.webdav
      ? {
          ...current,
          webdav: withStoredWebdavCredential(
            webdavSettingsSchema.parse(input.webdav),
            current.webdav
          )
        }
      : current;
  }
  if (input.s3 || input.webdav) {
    throw new ApiError(
      400,
      "storage_backend_reserved",
      "内置本地后端没有可编辑的远程存储配置"
    );
  }
  return current;
}

function changedPhysicalLocationFields(
  current: StorageConfig,
  next: StorageConfig
) {
  const currentSettings = current.type === "s3" ? current.s3 : current.webdav;
  const nextSettings = next.type === "s3" ? next.s3 : next.webdav;
  const fields = current.type === "s3"
    ? ["endpoint", "bucket", "root_path"] as const
    : current.type === "webdav"
      ? ["base_url", "root_path"] as const
      : [];
  const currentRecord = currentSettings as unknown as Record<string, unknown>;
  const nextRecord = nextSettings as unknown as Record<string, unknown>;
  return fields.filter((field) => currentRecord[field] !== nextRecord[field]);
}

type StorageBackendUsage = {
  image_count: number;
  import_session_count: number;
  cleanup_job_count: number;
  staging_object_count: number;
};

type StorageBackendSnapshot = {
  slug: string;
  type: StorageType;
  config: unknown;
  is_default: boolean;
  image_count: number;
  import_session_count: number;
  cleanup_job_count: number;
};

function storageBackendUsage(
  row: Record<string, unknown>,
  stagingObjectCount = 0
): StorageBackendUsage {
  return {
    image_count: Number(row.image_count ?? 0),
    import_session_count: Number(row.import_session_count ?? 0),
    cleanup_job_count: Number(row.cleanup_job_count ?? 0),
    staging_object_count: stagingObjectCount
  };
}

function assertPhysicalLocationChangeAllowed(
  changedFields: readonly string[],
  usage: StorageBackendUsage
) {
  if (
    !changedFields.length
    || (!usage.image_count
      && !usage.import_session_count
      && !usage.cleanup_job_count
      && !usage.staging_object_count)
  ) {
    return;
  }
  throw new ApiError(
    409,
    "storage_location_change_requires_migration",
    "该后端仍有图片、未清理导入会话、待处理清理任务或暂存对象，物理位置暂不可变更",
    { fields: changedFields, ...usage }
  );
}

async function storageBackendSnapshot(slug: string): Promise<StorageBackendSnapshot> {
  const row = (await pool.query(
    `SELECT backend.slug,
            backend.type,
            backend.config,
            backend.is_default,
            (SELECT count(*)::int
               FROM metadata
              WHERE metadata.storage_slug=backend.slug) AS image_count,
            (SELECT count(*)::int
               FROM import_session
              WHERE import_session.storage_slug=backend.slug) AS import_session_count
       FROM storage_backend AS backend
      WHERE backend.slug=$1`,
    [slug]
  )).rows[0] as StorageBackendSnapshot | undefined;
  if (!row) {
    throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  }
  row.cleanup_job_count = await countUnresolvedMoveCleanupJobs(slug);
  return row;
}

async function countStagingObjects(config: StorageConfig) {
  const keys = await storageDriverForConfig(config).listKeys("_uploads");
  return keys.filter((key) => !key.startsWith(".storage-test-")).length;
}

type ExistingStorageProbe = {
  id: string;
  object_key: string;
  storage_slug: string;
  is_link: boolean;
  device: string;
  brightness: string;
  theme: string;
};

async function validateStorageUpdate(
  config: StorageConfig,
  existingObject?: ExistingStorageProbe
) {
  const testConfig = { ...config, slug: "(test)" };
  const driver = storageDriverForConfig(testConfig);
  try {
    if (existingObject) {
      const reference = existingObject.is_link
        ? thumbnailRef(existingObject)
        : { prefix: "media" as const, key: existingObject.object_key };
      if (!await driver.exists(reference.prefix, reference.key)) {
        throw new ApiError(
          502,
          "storage_access_probe_failed",
          "Storage backend could not access an existing referenced object",
          { image_id: existingObject.id }
        );
      }
    }
    const result = await driver.selfTest();
    if (!result.writable) {
      throw new ApiError(
        502,
        "storage_test_failed",
        "Storage backend did not confirm write access"
      );
    }
  } finally {
    await Promise.resolve(driver.close?.()).catch(() => undefined);
  }
}

class StorageLocationWriteLockRequired extends Error {}

async function updateStorageBackendUnderLock(
  slug: string,
  input: StorageBackendUpdateInput,
  allowPhysicalLocationChange: boolean
) {
  const snapshot = await storageBackendSnapshot(slug);
  const currentConfig = storageConfigFromRow(snapshot);
  const nextConfig = updatedStorageConfig(currentConfig, input);
  const configChanged = currentConfig.type === "s3"
    ? JSON.stringify(currentConfig.s3) !== JSON.stringify(nextConfig.s3)
    : currentConfig.type === "webdav"
      ? JSON.stringify(currentConfig.webdav) !== JSON.stringify(nextConfig.webdav)
      : false;
  const physicalLocationChanged = storageNamespaceIdentity(currentConfig)
    !== storageNamespaceIdentity(nextConfig);
  if (physicalLocationChanged && !allowPhysicalLocationChange) {
    throw new StorageLocationWriteLockRequired();
  }

  const changedFields = physicalLocationChanged
    ? changedPhysicalLocationFields(currentConfig, nextConfig)
    : [];
  const snapshotUsage = storageBackendUsage(snapshot);
  if (physicalLocationChanged) {
    assertPhysicalLocationChangeAllowed(changedFields, snapshotUsage);
    snapshotUsage.staging_object_count = await countStagingObjects(currentConfig);
    assertPhysicalLocationChangeAllowed(changedFields, snapshotUsage);
  }

  const existingObject = snapshotUsage.image_count > 0
    ? (await pool.query(
        `SELECT id, object_key, storage_slug, is_link, device, brightness, theme
           FROM metadata
          WHERE storage_slug=$1
          ORDER BY id
          LIMIT 1`,
        [slug]
      )).rows[0] as ExistingStorageProbe | undefined
    : undefined;
  if (configChanged) {
    await validateStorageUpdate(nextConfig, existingObject);
  }

  await withTransaction(async (client) => {
    const row = (await client.query(
      `SELECT slug, type, config, is_default
         FROM storage_backend
        WHERE slug=$1
        FOR UPDATE`,
      [slug]
    )).rows[0];
    if (!row) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
    const lockedConfig = storageConfigFromRow(row as {
      slug: string;
      type: StorageType;
      config: unknown;
    });
    if (
      row.type !== snapshot.type
      || storageNamespaceIdentity(lockedConfig)
        !== storageNamespaceIdentity(currentConfig)
    ) {
      throw new ApiError(
        409,
        "storage_backend_changed",
        "存储后端配置已被其他请求修改，请刷新后重试"
      );
    }
    if (input.enabled === false && row.is_default) {
      throw new ApiError(400, "storage_default_enabled", "默认后端不能停用，请先切换默认后端");
    }
    if (input.enabled === false && row.slug === "local") {
      const alternativeDefault = await client.query(
        `SELECT 1
         FROM storage_backend
         WHERE slug <> 'local' AND enabled AND is_default
         LIMIT 1`
      );
      if (!alternativeDefault.rowCount) {
        throw new ApiError(
          400,
          "storage_local_requires_alternative",
          "停用本地存储前，请先启用其他存储并将其设为默认后端"
        );
      }
    }

    const configJson = !configChanged
      ? null
      : nextConfig.type === "s3"
        ? JSON.stringify(nextConfig.s3)
        : nextConfig.type === "webdav"
          ? JSON.stringify(nextConfig.webdav)
          : null;

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
  invalidateStorageBackendCache();
}

export async function updateStorageBackend(slug: string, input: StorageBackendUpdateInput) {
  const updateWithBackendLock = (allowPhysicalLocationChange: boolean) =>
    withAdvisoryLock(`imageshow:storage-backend:${slug}`, () =>
      updateStorageBackendUnderLock(slug, input, allowPhysicalLocationChange)
    );

  if (!input.s3 && !input.webdav) {
    await updateWithBackendLock(false);
    return;
  }

  const snapshot = await storageBackendSnapshot(slug);
  const currentConfig = storageConfigFromRow(snapshot);
  const nextConfig = updatedStorageConfig(currentConfig, input);
  const requiresWriteLock = storageNamespaceIdentity(currentConfig)
    !== storageNamespaceIdentity(nextConfig);
  if (requiresWriteLock) {
    await withStorageLocationWriteLock(() => updateWithBackendLock(true));
    return;
  }

  try {
    await withStorageLocationReadLock(() => updateWithBackendLock(false));
  } catch (error) {
    if (!(error instanceof StorageLocationWriteLockRequired)) throw error;
    await withStorageLocationWriteLock(() => updateWithBackendLock(true));
  }
}

export async function deleteStorageBackend(slug: string) {
  if (slug === "local") {
    throw new ApiError(400, "storage_backend_reserved", "'local' 是内置后端，不能删除");
  }
  await withStorageLocationWriteLock(() =>
    withAdvisoryLock(`imageshow:storage-backend:${slug}`, async () => {
      const snapshot = await storageBackendSnapshot(slug);
      if (snapshot.is_default) {
        throw new ApiError(
          400,
          "storage_default_delete",
          "默认后端不能删除，请先切换默认后端"
        );
      }

      const usage = storageBackendUsage(snapshot);
      if (
        !usage.image_count
        && !usage.import_session_count
        && !usage.cleanup_job_count
      ) {
        usage.staging_object_count = await countStagingObjects(
          storageConfigFromRow(snapshot)
        );
      }
      if (
        usage.image_count
        || usage.import_session_count
        || usage.cleanup_job_count
        || usage.staging_object_count
      ) {
        throw new ApiError(
          409,
          "storage_backend_in_use",
          "该存储后端仍有图片、未清理导入会话、待处理清理任务或暂存对象，无法删除",
          usage
        );
      }

      const deleted = await pool.query(
        "DELETE FROM storage_backend WHERE slug=$1 AND NOT is_default RETURNING slug",
        [slug]
      )
        .catch((error: unknown) => {
          if (
            error
            && typeof error === "object"
            && (error as { code?: string }).code === "23503"
          ) {
            throw new ApiError(
              409,
              "storage_backend_in_use",
              "该存储后端在删除时被新的数据引用，请刷新后重试"
            );
          }
          throw error;
        });
      if (!deleted.rowCount) {
        throw new ApiError(
          400,
          "storage_default_delete",
          "后端已被设为默认，不能删除；请刷新后重试"
        );
      }
      invalidateStorageBackendCache();
    })
  );
}

export async function setDefaultStorageBackend(slug: string) {
  await withTransaction(async (client) => {
    const row = (await client.query(
      "SELECT enabled FROM storage_backend WHERE slug=$1 FOR UPDATE",
      [slug]
    )).rows[0];
    if (!row) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
    if (!row.enabled) {
      throw new ApiError(400, "storage_default_disabled", "不能将已停用的后端设为默认");
    }

    await client.query("UPDATE storage_backend SET is_default=false, updated_at=now() WHERE is_default");
    await client.query("UPDATE storage_backend SET is_default=true, updated_at=now() WHERE slug=$1", [slug]);
  });
  invalidateStorageBackendCache();
}

export async function reorderStorageBackends(slugs: string[]) {
  if (!slugs.length) return;
  await pool.query(
    `UPDATE storage_backend b SET sort_order = v.ord, updated_at = now()
     FROM unnest($1::text[]) WITH ORDINALITY AS v(slug, ord)
     WHERE b.slug = v.slug AND b.slug <> 'local'`,
    [slugs]
  );
  invalidateStorageBackendCache();
}

export async function resolveStorageTestConfig(input: {
  slug?: string;
  type?: string;
  s3?: unknown;
  webdav?: unknown;
}): Promise<StorageConfig> {
  const current = input.slug ? await getStorageBackend(input.slug) : undefined;
  if (current?.type === "local") return current;

  const type = current?.type ?? (input.type === "webdav" || input.webdav ? "webdav" : "s3");
  if (type === "webdav") {
    const candidate = webdavSettingsSchema.parse(input.webdav ?? current?.webdav ?? {});
    return {
      slug: "(test)",
      type: "webdav",
      s3: defaultS3Settings,
      webdav: withStoredWebdavCredential(candidate, current?.type === "webdav" ? current.webdav : undefined)
    };
  }

  const candidate = s3SettingsSchema.parse(input.s3 ?? current?.s3 ?? {});
  return {
    slug: "(test)",
    type: "s3",
    s3: withStoredS3Credential(candidate, current?.type === "s3" ? current.s3 : undefined),
    webdav: defaultWebdavSettings
  };
}
