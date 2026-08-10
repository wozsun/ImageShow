import { appConfig } from "@imageshow/shared";
import { ApiError, errorMessage } from "../core/api-error.ts";
import {
  coalescePublicRead,
  publicPgFallbackWorkLimitExceeded,
  publicReadUsesFallbackAdmission,
  queryForPublicRead
} from "../core/public-query-gateway.ts";
import { logger } from "../core/logger.ts";
import {
  missingS3Fields,
  type StorageBackendRecord,
  type StorageConfig
} from "./backend-config.ts";
import {
  storageBackendRecordFromRow,
  storageConfigFromRecord,
  type StorageBackendConfigRow
} from "./backend-record.ts";
import { createStorageDriver } from "./driver-factory.ts";
import type { StorageDriver } from "./driver.ts";
import { manageStorageDriver } from "./driver-lifecycle.ts";
import { StorageBackendRegistryGeneration } from "./backend-registry-generation.ts";

const storageCacheTtlMs = appConfig.derivedCacheTtlSeconds * 1000;
let storageCache: StorageBackendRecord[] | null = null;
let storageCacheExpiresAt = 0;
let storageLoad: Promise<StorageBackendRecord[]> | null = null;
const registryGeneration = new StorageBackendRegistryGeneration();
const storageDriverCache = new Map<string, StorageDriver>();
let storageDriverCloseQueue = Promise.resolve();

function storageDriverCacheKey(config: StorageConfig) {
  return JSON.stringify(config);
}

function storageDriverForConfig(config: StorageConfig) {
  registryGeneration.assertOpen();
  if (config.slug === "(test)") {
    return manageStorageDriver(createStorageDriver(config));
  }
  const key = storageDriverCacheKey(config);
  const cached = storageDriverCache.get(key);
  if (cached) return cached;
  const driver = manageStorageDriver(createStorageDriver(config));
  storageDriverCache.set(key, driver);
  return driver;
}

function retireStorageDrivers() {
  const drivers = [...storageDriverCache.values()];
  storageDriverCache.clear();
  if (!drivers.length) return;
  // Invoke close synchronously so every wrapper rejects new leases as soon as
  // the cache generation is retired. Physical clients close only after their
  // already-issued operations and response bodies drain (or hit the bound).
  const closing = Promise.allSettled(drivers.map((driver) => {
    try {
      return Promise.resolve(driver.close?.());
    } catch (error) {
      return Promise.reject(error);
    }
  }));
  storageDriverCloseQueue = Promise.all([
    storageDriverCloseQueue,
    closing
  ]).then(([, results]) => {
    for (const result of results) {
      if (result.status === "fulfilled") continue;
      logger.warn("storage_driver_close_failed", {
        error: errorMessage(result.reason)
      });
    }
  });
}

async function loadStorageBackends(): Promise<StorageBackendRecord[]> {
  const maximumRows = appConfig.publicPgFallback.maximumStorageBackendRows;
  const publicFallback = publicReadUsesFallbackAdmission();
  const rows = (await queryForPublicRead<StorageBackendConfigRow & {
    display_name: string;
    enabled: boolean;
    is_default: boolean;
  }>(
    `SELECT slug, display_name, type, config, enabled, is_default,
            namespace_identities
       FROM storage_backend
      ORDER BY (slug = 'local') DESC, sort_order ASC, slug ASC
      ${publicFallback ? "LIMIT $1" : ""}`,
    publicFallback ? [maximumRows + 1] : undefined
  )).rows;
  if (publicFallback && rows.length > maximumRows) {
    throw publicPgFallbackWorkLimitExceeded(
      "Storage backend registry exceeds the public result limit"
    );
  }
  return rows.map((row) => storageBackendRecordFromRow(row));
}

async function loadCachedStorageBackends(): Promise<StorageBackendRecord[]> {
  if (storageCache && Date.now() < storageCacheExpiresAt) return storageCache;
  const loadGeneration = registryGeneration.current;
  if (publicReadUsesFallbackAdmission()) {
    return coalescePublicRead(
      `storage-backends:${loadGeneration}`,
      async () => {
        const loaded = await loadStorageBackends();
        if (registryGeneration.current === loadGeneration) {
          storageCache = loaded;
          storageCacheExpiresAt = Date.now() + storageCacheTtlMs;
        }
        return loaded;
      }
    );
  }
  if (!storageLoad) storageLoad = loadStorageBackends();
  const currentLoad = storageLoad;
  try {
    const loaded = await currentLoad;
    if (registryGeneration.current === loadGeneration) {
      storageCache = loaded;
      storageCacheExpiresAt = Date.now() + storageCacheTtlMs;
    }
    return loaded;
  } finally {
    if (storageLoad === currentLoad) storageLoad = null;
  }
}

async function getStorageBackends(): Promise<StorageBackendRecord[]> {
  return registryGeneration.commitStable(
    loadCachedStorageBackends,
    (backends) => backends
  );
}

export function invalidateStorageBackendRegistry(
  options: { retireDrivers?: boolean } = {}
) {
  registryGeneration.invalidate();
  storageCache = null;
  storageCacheExpiresAt = 0;
  // A caller that started before invalidation may finish its physical query,
  // but the generation gate prevents that snapshot from being committed or
  // used to create a driver.
  storageLoad = null;
  if (options.retireDrivers) retireStorageDrivers();
}

export async function closeStorageBackendRegistry() {
  registryGeneration.close();
  storageCache = null;
  storageCacheExpiresAt = 0;
  storageLoad = null;
  retireStorageDrivers();
  await storageDriverCloseQueue;
}

export async function listStorageBackends(): Promise<StorageBackendRecord[]> {
  return getStorageBackends();
}

export async function getStorageBackend(slug: string): Promise<StorageConfig> {
  return registryGeneration.commitStable(
    loadCachedStorageBackends,
    (backends) => storageConfigFromRecord(storageRecordBySlug(backends, slug))
  );
}

function storageRecordBySlug(
  backends: readonly StorageBackendRecord[],
  slug: string
) {
  const record = backends.find((backend) => backend.slug === slug);
  if (!record) {
    throw new ApiError(
      404,
      "storage_backend_not_found",
      `Unknown storage backend: ${slug}`
    );
  }
  return record;
}

function assertStorageConfigComplete(config: StorageConfig) {
  const missing = config.type === "s3" ? missingS3Fields(config.s3) : [];
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

export async function assertStorageWriteTarget(
  slug: string
): Promise<StorageConfig> {
  return registryGeneration.commitStable(loadCachedStorageBackends, (backends) => {
    const record = storageRecordBySlug(backends, slug);
    if (!record.enabled) {
      throw new ApiError(
        400,
        "storage_backend_disabled",
        "该存储后端已停用，不能作为图片写入或迁移目标"
      );
    }
    return assertStorageConfigComplete(storageConfigFromRecord(record));
  });
}

function defaultStorageRecord(
  backends: readonly StorageBackendRecord[]
): StorageBackendRecord {
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

async function getDefaultStorageRecord(): Promise<StorageBackendRecord> {
  return registryGeneration.commitStable(
    loadCachedStorageBackends,
    defaultStorageRecord
  );
}

export async function resolveStorageAccess(slug?: string) {
  return registryGeneration.commitStable(loadCachedStorageBackends, (backends) => {
    const record = slug
      ? storageRecordBySlug(backends, slug)
      : defaultStorageRecord(backends);
    const config = storageConfigFromRecord(record);
    return { config, driver: storageDriverForConfig(config) };
  });
}

export function resolveStorageAccessForConfig(config: StorageConfig) {
  return { config, driver: storageDriverForConfig(config) };
}

export async function getDefaultStorageSlug(): Promise<string> {
  return (await getDefaultStorageRecord()).slug;
}
