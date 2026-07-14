import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";
import { linkBaseUrl, staticLocalBaseUrl } from "../themes/host.ts";
import type { StorageConfig } from "./backend-config.ts";
import { getDefaultStorageBackend, getStorageBackend } from "./backend-registry.ts";
import { linkThumbnailKey, thumbnailObjectKey } from "./image-paths.ts";
import { driverFor, type CopyPrefix } from "./storage-backend.ts";
import { contentTypeForKey, STORAGE_PREFIXES, type ReadablePrefix, type StoragePrefix } from "./object-keys.ts";
import { logger } from "../core/logger.ts";

export { contentType, safeStoragePath } from "./object-keys.ts";
export type { StoragePrefix } from "./object-keys.ts";

export async function ensureRuntimeDirectories() {
  await mkdir(runtimePaths.configDirectory, { recursive: true });
  await mkdir(runtimePaths.storageDirectory, { recursive: true });
  await mkdir(runtimePaths.logDirectory, { recursive: true });
  await mkdir(runtimePaths.tempDirectory, { recursive: true });
  for (const dir of STORAGE_PREFIXES) {
    await mkdir(join(runtimePaths.storageDirectory, dir), { recursive: true });
  }
}

async function resolveConfig(slug?: string) {
  return slug ? getStorageBackend(slug) : getDefaultStorageBackend();
}

export function storageExistsWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return driverFor(config).exists(prefix, key);
}
export function readStorageBufferWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string) {
  return driverFor(config).readBuffer(prefix, key);
}
export function writeStorageBufferWithConfig(config: StorageConfig, prefix: StoragePrefix, key: string, body: Buffer, type: string) {
  return driverFor(config).writeBuffer(prefix, key, body, type);
}

export async function exists(prefix: StoragePrefix, key: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).exists(prefix, key);
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

export async function copyObject(fromPrefix: CopyPrefix, fromKey: string, toPrefix: CopyPrefix, toKey: string, slug?: string) {
  if (fromPrefix === toPrefix && fromKey === toKey) return;
  const driver = driverFor(await resolveConfig(slug));
  try {
    await driver.copy(fromPrefix, fromKey, toPrefix, toKey);
  } catch (error) {
    logger.debug(`native copy failed; using read+write fallback: ${fromPrefix}/${fromKey} -> ${toPrefix}/${toKey}`, error);
    await driver.writeBuffer(toPrefix, toKey, await driver.readBuffer(fromPrefix, fromKey), contentTypeForKey(toKey));
  }
}
export async function openObject(prefix: ReadablePrefix, key: string, slug?: string, range?: string) {
  return driverFor(await resolveConfig(slug)).openRead(prefix, key, range);
}
export async function listStorageKeys(prefix: StoragePrefix, slug?: string) {
  return driverFor(await resolveConfig(slug)).listKeys(prefix);
}
export async function publicObjectUrl(prefix: ReadablePrefix, key: string, slug?: string) {
  return driverFor(await resolveConfig(slug)).publicObjectUrl(prefix, key);
}

export async function pruneEmptyStorageDirs(slug?: string) {
  return driverFor(await resolveConfig(slug)).pruneEmptyDirs();
}

function encodeKeyPath(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function localMediaUrl(prefix: ReadablePrefix, key: string) {
  const route = prefix === "media" ? "media" : "thumbs";
  return `/${route}/${encodeKeyPath(key)}`;
}

type LinkImageUrlParts = { id: string; device: string; brightness: string; theme: string; ext: string };

export async function publicImageUrls(objectKey: string, slug: string, isLink: boolean, link?: LinkImageUrlParts) {
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

  const staticBase = staticLocalBaseUrl();
  return {
    object_url: driver.publicObjectUrl("media", objectKey) || `${staticBase}${localMediaUrl("media", objectKey)}`,
    thumb_url: driver.publicObjectUrl("thumbs", thumbKey) || `${staticBase}${localMediaUrl("thumbs", thumbKey)}`
  };
}

export async function testStorageBackend(config?: StorageConfig) {
  const effective = config ?? await getDefaultStorageBackend();
  const driver = driverFor(effective);
  try {
    return await driver.selfTest();
  } finally {
    if (effective.slug === "(test)") {
      await Promise.resolve(driver.close?.()).catch(() => undefined);
    }
  }
}
