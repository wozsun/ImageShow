// Public storage facade for the rest of the app. Per-backend behavior lives behind the
// StorageDriver interface (storage-backend.ts: Local / S3 / WebDAV); this module only resolves
// which backend an operation uses (by slug, via the storage_backend registry) and re-exports the
// shared helpers, so adding a backend never changes a caller's imports.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../config/env.js";
import { linkBaseUrl, staticLocalBaseUrl } from "../themes/host.js";
import { getDefaultStorageBackend, getStorageBackend, type StorageConfig } from "../config/settings.js";
import { linkThumbnailKey, thumbnailObjectKey } from "./image-paths.js";
import { driverFor, type CopyPrefix } from "./storage-backend.js";
import { contentTypeForKey, NAMESPACED_PREFIXES, type ReadablePrefix, type StoragePrefix } from "./object-keys.js";
import { logger } from "../core/logger.js";

// Re-exported so callers reach these storage helpers (path mapping, content types) through the one
// facade rather than the low-level modules.
export { contentType, safeStoragePath } from "./object-keys.js";
export type { StoragePrefix } from "./object-keys.js";

// Creates the local filesystem layout (config/storage/log + storage subdirs).
// Always run at startup so the local backend just works.
export async function ensureStorage() {
  await mkdir(env.CONFIG_DIR, { recursive: true });
  await mkdir(env.STORAGE_DIR, { recursive: true });
  await mkdir(env.LOG_DIR, { recursive: true });
  for (const dir of NAMESPACED_PREFIXES) {
    await mkdir(join(env.STORAGE_DIR, dir), { recursive: true });
  }
}

// Resolves the config for an operation. Without a slug it uses the default backend
// (new uploads); with one it resolves that specific backend from the registry.
async function resolveConfig(slug?: string) {
  return slug ? getStorageBackend(slug) : getDefaultStorageBackend();
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

// --- convenience operations that resolve the (optional) backend slug first ---
export async function exists(prefix: StoragePrefix, key: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).exists(prefix, key);
}
export async function openStorageRead(prefix: StoragePrefix, key: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).openRead(prefix, key);
}
export async function readStorageBuffer(prefix: StoragePrefix, key: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).readBuffer(prefix, key);
}
export async function writeStorageBuffer(prefix: StoragePrefix, key: string, body: Buffer, type: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).writeBuffer(prefix, key, body, type);
}
export async function removeObject(prefix: StoragePrefix, key: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).remove(prefix, key);
}
export async function moveObject(fromPrefix: "objects" | "_uploads", fromKey: string, toPrefix: "objects", toKey: string, targetContentType?: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).move(fromPrefix, fromKey, toPrefix, toKey, targetContentType);
}
// Copies an object within one backend, re-keying it. Tries the native copy first (local copyFile,
// S3 CopyObject, WebDAV COPY) so bytes never round-trip through the app; on ANY failure it falls back
// to read+write (every backend implements it), covering servers without COPY and quirky CopyObject
// impls. The fallback preserves bytes + a key-derived content-type only, not S3 metadata / ACL /
// storage-class (we never set those on writes).
export async function copyObject(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string, slug?: string) {
  if (fromPrefix === toPrefix && fromKey === toKey) return; // copying an object onto itself is a no-op
  const driver = driverFor(await resolveConfig(slug));
  try {
    await driver.copy(fromPrefix, fromKey, toPrefix, toKey);
  } catch (error) {
    logger.debug(`native copy failed; using read+write fallback: ${fromPrefix}/${fromKey} -> ${toPrefix}/${toKey}`, error);
    await driver.writeBuffer(toPrefix, toKey, await driver.readBuffer(fromPrefix, fromKey), contentTypeForKey(toKey));
  }
}
export async function writeUploadFromWeb(id: string, body: ReadableStream<Uint8Array>, expectedSize: number, slug?: string) {
  return driverFor(await resolveConfig(slug)).writeUploadFromWeb(id, body, expectedSize);
}
export async function readObject(prefix: ReadablePrefix, key: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).readObject(prefix, key);
}
export async function listStorageKeys(prefix: StoragePrefix, slug?: string) {
  return driverFor(await resolveConfig(slug)).listKeys(prefix);
}
export async function publicObjectUrl(prefix: ReadablePrefix, key: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).publicObjectUrl(prefix, key);
}
// Removes empty directories left behind in a backend (local only; object stores return 0).
export async function pruneEmptyStorageDirs(slug?: string) {
  return driverFor(await resolveConfig(slug)).pruneEmptyDirs();
}

function encodeKeyPath(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function localMediaUrl(prefix: ReadablePrefix, key: string) {
  const route = prefix === "objects" ? "media" : "thumbs";
  return `/${route}/${encodeKeyPath(key)}`;
}

// Link image whose public URLs are wanted: the foldered-by-category thumbnail name
// (<device>-<brightness>/<theme>/<id>.webp) is built from these, and the proxied-original
// /media path is keyed by id + ext.
type LinkImageUrls = { id: string; device: string; brightness: string; theme: string; ext: string };

// Builds the public original + thumbnail URLs for an image. `slug` is the backend the
// image's bytes live in (storage_slug). For link images (isLink) the original is the
// external URL in objectKey but it is never linked directly: both URLs point at the
// dedicated link.<domain> host — /thumbs serves the stored thumbnail, and /media
// proxies the external original server-side (beating hotlink protection). An S3 backend
// with a public base URL still serves the thumbnail directly from the CDN.
export async function publicImageUrls(objectKey: string, slug: string, isLink: boolean, link?: LinkImageUrls) {
  if (isLink) {
    const thumbDriver = driverFor(await resolveConfig(slug));
    const linkInfo = link ?? { id: "", device: "pc", brightness: "dark", theme: "none", ext: "jpg" };
    const thumbKey = linkThumbnailKey(linkInfo.device, linkInfo.brightness, linkInfo.theme, linkInfo.id);
    const directThumb = thumbDriver.publicObjectUrl("link", thumbKey);
    const linkBase = linkBaseUrl();
    return {
      object_url: `${linkBase}/media/${encodeURIComponent(linkInfo.id)}.${linkInfo.ext}`,
      thumb_url: directThumb || `${linkBase}/thumbs/${encodeKeyPath(thumbKey)}`
    };
  }
  const driver = driverFor(await resolveConfig(slug));
  const thumbKey = thumbnailObjectKey(objectKey);
  // Anything without an S3 public URL (local, or S3 without public_base_url) is
  // served from the cookie-isolated static.<domain> host's /media and /thumbs routes.
  const staticBase = staticLocalBaseUrl();
  return {
    object_url: driver.publicObjectUrl("objects", objectKey) || `${staticBase}${localMediaUrl("objects", objectKey)}`,
    thumb_url: driver.publicObjectUrl("thumbs", thumbKey) || `${staticBase}${localMediaUrl("thumbs", thumbKey)}`
  };
}

export async function testStorage(config?: StorageConfig) {
  const effective = config ?? await getDefaultStorageBackend();
  return driverFor(effective).selfTest();
}
