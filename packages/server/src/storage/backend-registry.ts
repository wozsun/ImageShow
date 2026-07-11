import { appConfig } from "@imageshow/shared";
import { pool, withTransaction } from "../core/db.ts";
import { ApiError } from "../core/http.ts";
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
import { clearStorageDriverCache } from "./storage-backend.ts";

const storageCacheTtlMs = appConfig.derivedCacheTtlSeconds * 1000;
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
}

function toStorageConfig(record: StorageBackendRecord): StorageConfig {
  return {
    slug: record.slug,
    type: record.type,
    s3: record.s3,
    webdav: record.webdav
  };
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

export async function getDefaultStorageSlug(): Promise<string> {
  return (await getDefaultStorageRecord()).slug;
}

export async function listStorageBackendOptions() {
  return (await getStorageBackends()).map((backend) => ({
    slug: backend.slug,
    display_name: backend.display_name,
    type: backend.type,
    enabled: backend.enabled,
    is_default: backend.is_default
  }));
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

export async function updateStorageBackend(slug: string, input: StorageBackendUpdateInput) {
  await withTransaction(async (client) => {
    const row = (await client.query(
      "SELECT slug, type, config, is_default FROM storage_backend WHERE slug=$1 FOR UPDATE",
      [slug]
    )).rows[0];
    if (!row) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
    if (input.enabled === false && row.is_default) {
      throw new ApiError(400, "storage_default_enabled", "默认后端不能停用，请先切换默认后端");
    }

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
  invalidateStorageBackendCache();
}

export async function deleteStorageBackend(slug: string) {
  if (slug === "local") {
    throw new ApiError(400, "storage_backend_reserved", "'local' 是内置后端，不能删除");
  }
  const row = (await pool.query("SELECT is_default FROM storage_backend WHERE slug=$1", [slug])).rows[0];
  if (!row) throw new ApiError(404, "storage_backend_not_found", `Unknown storage backend: ${slug}`);
  if (row.is_default) {
    throw new ApiError(400, "storage_default_delete", "默认后端不能删除，请先切换默认后端");
  }

  await pool.query("DELETE FROM storage_backend WHERE slug=$1", [slug]).catch((error: unknown) => {
    if (error && typeof error === "object" && (error as { code?: string }).code === "23503") {
      throw new ApiError(409, "storage_backend_in_use", "该存储后端仍有图片在使用，无法删除");
    }
    throw error;
  });
  invalidateStorageBackendCache();
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
  if (input.slug) return getStorageBackend(input.slug);
  if (input.type === "webdav" || input.webdav) {
    return {
      slug: "(test)",
      type: "webdav",
      s3: defaultS3Settings,
      webdav: webdavSettingsSchema.parse(input.webdav ?? {})
    };
  }
  return {
    slug: "(test)",
    type: "s3",
    s3: s3SettingsSchema.parse(input.s3 ?? {}),
    webdav: defaultWebdavSettings
  };
}
