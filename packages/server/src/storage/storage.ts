// Public storage surface for the rest of the app. The actual per-backend behavior
// lives behind the StorageDriver interface (storage-backend.ts) with LocalBackend
// and S3Backend implementations; this module only resolves which config/driver an
// operation should use and re-exports the shared helpers. Keeping the public API
// here means adding a backend never changes any caller's imports.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env.js";
import { ApiError } from "../core/http.js";
import { staticLocalBaseUrl } from "../core/theme-host.js";
import { getStorageConfig, missingS3Fields, type StorageBackend, type StorageConfig } from "../config/settings.js";
import { thumbnailObjectKey } from "./image-paths.js";
import { driverFor, type UploadTarget, type UploadTargetRow } from "./storage-backend.js";
import type { ReadablePrefix, StoragePrefix } from "./object-keys.js";

// Re-exported so existing importers keep their import paths unchanged.
export { safeStoragePath, storageS3ObjectName } from "./object-keys.js";
export { storageS3Client } from "./s3-backend.js";
export type { StoragePrefix } from "./object-keys.js";

// Creates the local filesystem layout (config/storage/log + storage subdirs).
// Always run at startup so switching to/from the local backend just works.
export async function ensureStorage() {
  await mkdir(env.CONFIG_DIR, { recursive: true });
  await mkdir(env.STORAGE_DIR, { recursive: true });
  await mkdir(env.LOG_DIR, { recursive: true });
  for (const dir of ["thumbs", "_uploads", "trash"]) {
    await mkdir(join(env.STORAGE_DIR, dir), { recursive: true });
  }
}

// Derives a backend's config (shallow copy) without validating S3 credentials, so
// a misconfigured backend fails per-object (e.g. 404) instead of breaking the
// whole instance.
export function storageConfigForBackendUnchecked(config: StorageConfig, backend: StorageBackend) {
  return { ...config, backend, s3: { ...config.s3 } };
}

export function storageConfigForBackend(config: StorageConfig, backend: "local" | "s3") {
  const next = storageConfigForBackendUnchecked(config, backend);
  if (backend === "s3") {
    next.s3.enabled = true;
    const missing = missingS3Fields(next.s3);
    if (missing.length) throw new ApiError(400, "storage_config_incomplete", "Storage config incomplete", { missing });
  }
  return next;
}

// Resolves the config for an operation. Without a backend it uses the saved
// default (new uploads); with one it derives that specific backend's config.
async function resolveConfig(backend?: StorageBackend) {
  const config = await getStorageConfig();
  return backend ? storageConfigForBackendUnchecked(config, backend) : config;
}

// --- operations bound to an already-resolved config (cross-backend migration) ---
export function storageExistsWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return driverFor(config).exists(prefix, key);
}
export function readStorageBufferWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return driverFor(config).readBuffer(prefix, key);
}
export function writeStorageBufferWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string, body: Buffer, type: string) {
  return driverFor(config).writeBuffer(prefix, key, body, type);
}

// --- convenience operations that resolve the (optional) backend first ---
export async function exists(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).exists(prefix, key);
}
export async function openStorageRead(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).openRead(prefix, key);
}
export async function readStorageBuffer(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).readBuffer(prefix, key);
}
export async function writeStorageBuffer(prefix: StoragePrefix, key: string, body: Buffer, type: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).writeBuffer(prefix, key, body, type);
}
export async function removeObject(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).remove(prefix, key);
}
export async function moveObject(fromPrefix: "objects" | "_uploads" | "trash", fromKey: string, toPrefix: "objects" | "trash", toKey: string, targetContentType?: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).move(fromPrefix, fromKey, toPrefix, toKey, targetContentType);
}
export async function copyObject(fromPrefix: "objects" | "thumbs" | "trash", fromKey: string, toPrefix: "objects" | "thumbs" | "trash", toKey: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).copy(fromPrefix, fromKey, toPrefix, toKey);
}
export async function objectStat(prefix: StoragePrefix, key: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).stat(prefix, key);
}
export async function writeUploadFromWeb(id: string, body: ReadableStream<Uint8Array>, expectedSize: number, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).writeUploadFromWeb(id, body, expectedSize);
}
export async function readObject(prefix: ReadablePrefix, key: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).readObject(prefix, key);
}
export async function listStorageKeys(prefix: StoragePrefix, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).listKeys(prefix);
}
export async function publicObjectUrl(prefix: ReadablePrefix, key: string, backend?: StorageBackend) {
  return driverFor(await resolveConfig(backend)).publicObjectUrl(prefix, key);
}

function localMediaUrl(prefix: ReadablePrefix, key: string) {
  const route = prefix === "objects" ? "media" : "thumbs";
  return `/${route}/${key.split("/").map(encodeURIComponent).join("/")}`;
}

export async function publicImageUrls(objectKey: string, backend: StorageBackend) {
  const driver = driverFor(await resolveConfig(backend));
  const thumbKey = thumbnailObjectKey(objectKey);
  // Anything without an S3 public URL (local, or S3 without public_base_url) is
  // served from the cookie-isolated static.<domain> host's /media and /thumbs routes.
  const staticBase = staticLocalBaseUrl();
  return {
    object_url: driver.publicObjectUrl("objects", objectKey) || `${staticBase}${localMediaUrl("objects", objectKey)}`,
    thumb_url: driver.publicObjectUrl("thumbs", thumbKey) || `${staticBase}${localMediaUrl("thumbs", thumbKey)}`
  };
}

export async function createUploadTarget(row: UploadTargetRow): Promise<UploadTarget> {
  // Resolve the session's own backend (not just the current default) so a batch
  // pinned to a specific location uploads there. S3 credentials were validated
  // when the session was created.
  const base = await getStorageConfig();
  const config = row.storage_backend === "s3" ? storageConfigForBackend(base, "s3") : storageConfigForBackendUnchecked(base, "local");
  return driverFor(config).createUploadTarget(row);
}

export async function testStorage(config?: StorageConfig) {
  const effective = config ?? await getStorageConfig();
  return driverFor(effective).selfTest();
}
