import { appConfig } from "@imageshow/shared";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { logger } from "../core/logger.ts";
import {
  missingS3Fields,
  missingWebdavFields,
  type StorageBackendRecord,
  type StorageConfig
} from "./backend-config.ts";
import {
  storageBackendRecordFromRow,
  storageConfigFromRecord
} from "./backend-record.ts";
import { createStorageDriver } from "./driver-factory.ts";
import type { StorageDriver } from "./driver.ts";

const storageCacheTtlMs = appConfig.derivedCacheTtlSeconds * 1000;
let storageCache: StorageBackendRecord[] | null = null;
let storageCacheExpiresAt = 0;
let storageLoad: Promise<StorageBackendRecord[]> | null = null;
let storageCacheGeneration = 0;
const storageBackendChangeListeners = new Set<() => void>();
const storageDriverCache = new Map<string, StorageDriver>();
let storageDriverCloseQueue = Promise.resolve();

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

function retireStorageDrivers() {
  const drivers = [...storageDriverCache.values()];
  storageDriverCache.clear();
  if (!drivers.length) return;
  storageDriverCloseQueue = storageDriverCloseQueue.then(async () => {
    const results = await Promise.allSettled(
      drivers.map((driver) => Promise.resolve().then(() => driver.close?.()))
    );
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      logger.warn("storage_driver_close_failed", {
        error: errorMessage(result.reason)
      });
    }
  });
}

async function loadStorageBackends(): Promise<StorageBackendRecord[]> {
  const rows = (await pool.query(
    `SELECT slug, display_name, type, config, enabled, is_default,
            namespace_identities
       FROM storage_backend
      ORDER BY (slug = 'local') DESC, sort_order ASC, slug ASC`
  )).rows;
  return rows.map((row) => storageBackendRecordFromRow(row));
}

async function getStorageBackends(): Promise<StorageBackendRecord[]> {
  if (storageCache && Date.now() < storageCacheExpiresAt) return storageCache;
  const loadGeneration = storageCacheGeneration;
  if (!storageLoad) storageLoad = loadStorageBackends();
  const currentLoad = storageLoad;
  try {
    const loaded = await currentLoad;
    if (storageCacheGeneration === loadGeneration) {
      storageCache = loaded;
      storageCacheExpiresAt = Date.now() + storageCacheTtlMs;
    }
    return loaded;
  } finally {
    if (storageLoad === currentLoad) storageLoad = null;
  }
}

export function invalidateStorageBackendRegistry(
  options: { retireDrivers?: boolean } = {}
) {
  storageCacheGeneration += 1;
  storageCache = null;
  storageCacheExpiresAt = 0;
  // A caller that started before this invalidation may still await its own
  // snapshot, but no later caller may join or publish that stale load.
  storageLoad = null;
  if (options.retireDrivers) retireStorageDrivers();
  for (const listener of storageBackendChangeListeners) {
    try {
      listener();
    } catch (error) {
      logger.error("storage_backend_change_listener_failed", {
        error: errorMessage(error)
      });
    }
  }
}

export async function closeStorageBackendRegistry() {
  storageCacheGeneration += 1;
  storageCache = null;
  storageCacheExpiresAt = 0;
  storageLoad = null;
  retireStorageDrivers();
  await storageDriverCloseQueue;
}

export function onStorageBackendChange(listener: () => void) {
  storageBackendChangeListeners.add(listener);
  return () => storageBackendChangeListeners.delete(listener);
}

export async function listStorageBackends(): Promise<StorageBackendRecord[]> {
  return getStorageBackends();
}

export async function getStorageBackend(slug: string): Promise<StorageConfig> {
  const record = (await getStorageBackends()).find(
    (backend) => backend.slug === slug
  );
  if (!record) {
    throw new ApiError(
      404,
      "storage_backend_not_found",
      `Unknown storage backend: ${slug}`
    );
  }
  return storageConfigFromRecord(record);
}

function assertStorageConfigComplete(config: StorageConfig) {
  const missing = config.type === "s3"
    ? missingS3Fields(config.s3)
    : config.type === "webdav"
      ? missingWebdavFields(config.webdav)
      : [];
  if (missing.length) {
    throw new ApiError(
      400,
      "storage_config_incomplete",
      "Storage config incomplete",
      { missing }
    );
  }
  return config;
}

export async function assertStorageWritable(
  slug: string
): Promise<StorageConfig> {
  return assertStorageConfigComplete(await getStorageBackend(slug));
}

export async function assertStorageUploadable(
  slug: string
): Promise<StorageConfig> {
  const record = (await getStorageBackends()).find(
    (backend) => backend.slug === slug
  );
  if (!record) {
    throw new ApiError(
      404,
      "storage_backend_not_found",
      `Unknown storage backend: ${slug}`
    );
  }
  if (!record.enabled) {
    throw new ApiError(
      400,
      "storage_backend_disabled",
      "该存储后端已停用，不能作为新图片的写入目标"
    );
  }
  return assertStorageConfigComplete(storageConfigFromRecord(record));
}

async function getDefaultStorageRecord(): Promise<StorageBackendRecord> {
  const backends = await getStorageBackends();
  const record = backends.find((backend) => backend.is_default)
    ?? backends.find((backend) => backend.slug === "local")
    ?? backends[0];
  if (!record) {
    throw new ApiError(
      503,
      "storage_unconfigured",
      "No storage backend configured"
    );
  }
  return record;
}

export async function getDefaultStorageBackend(): Promise<StorageConfig> {
  return storageConfigFromRecord(await getDefaultStorageRecord());
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
