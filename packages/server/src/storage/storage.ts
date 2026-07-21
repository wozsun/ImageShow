import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runtimePaths } from "../config/bootstrap-env.ts";
import { linkBaseUrl, staticLocalBaseUrl } from "../themes/host.ts";
import type { StorageConfig } from "./backend-config.ts";
import {
  getDefaultStorageBackend,
  resolveStorageAccess,
  resolveStorageAccessForConfig
} from "./backend-registry.ts";
import { linkThumbnailKey, thumbnailObjectKey } from "./image-paths.ts";
import type { OpenedRead } from "./storage-backend.ts";
import { STORAGE_PREFIXES, type ReadablePrefix, type StoragePrefix } from "./object-keys.ts";

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

export async function exists(prefix: StoragePrefix, key: string, slug?: string) {
  return (await resolveStorageAccess(slug)).driver.exists(prefix, key);
}
export async function readStorageBuffer(prefix: StoragePrefix, key: string, slug?: string) {
  return (await resolveStorageAccess(slug)).driver.readBuffer(prefix, key);
}
export async function writeStorageBuffer(prefix: StoragePrefix, key: string, body: Buffer, type: string, slug?: string) {
  return (await resolveStorageAccess(slug)).driver.writeBuffer(prefix, key, body, type);
}
export async function removeObject(prefix: StoragePrefix, key: string, slug?: string) {
  return (await resolveStorageAccess(slug)).driver.remove(prefix, key);
}

export async function listStorageKeys(prefix: StoragePrefix, slug?: string) {
  return (await resolveStorageAccess(slug)).driver.listKeys(prefix);
}
export async function pruneEmptyStorageDirs(slug?: string) {
  return (await resolveStorageAccess(slug)).driver.pruneEmptyDirs();
}

export type ResolvedReadableObject = {
  prefix: ReadablePrefix;
  key: string;
  storageSlug: string;
  publicUrl: string;
  exists: () => Promise<boolean>;
  open: (range?: string) => Promise<OpenedRead>;
};

export async function resolveReadableObject(
  prefix: ReadablePrefix,
  key: string,
  slug?: string
): Promise<ResolvedReadableObject> {
  const { config, driver } = await resolveStorageAccess(slug);
  return {
    prefix,
    key,
    storageSlug: config.slug,
    publicUrl: driver.publicObjectUrl(prefix, key),
    exists: () => driver.exists(prefix, key),
    open: (range) => driver.openRead(prefix, key, range)
  };
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
    const { driver: thumbDriver } = await resolveStorageAccess(slug);
    const linkInfo = link ?? { id: "", device: "pc", brightness: "dark", theme: "none", ext: "jpg" };
    const thumbKey = linkThumbnailKey(linkInfo.device, linkInfo.brightness, linkInfo.theme, linkInfo.id);
    const directThumb = thumbDriver.publicObjectUrl("link", thumbKey);
    const linkBase = linkBaseUrl();
    return {
      object_url: `${linkBase}/media/${encodeURIComponent(linkInfo.id)}.${linkInfo.ext}`,
      thumb_url: directThumb || `${linkBase}/thumbs/${encodeKeyPath(thumbKey)}`
    };
  }
  const { driver } = await resolveStorageAccess(slug);
  const thumbKey = thumbnailObjectKey(objectKey);

  const staticBase = staticLocalBaseUrl();
  return {
    object_url: driver.publicObjectUrl("media", objectKey) || `${staticBase}${localMediaUrl("media", objectKey)}`,
    thumb_url: driver.publicObjectUrl("thumbs", thumbKey) || `${staticBase}${localMediaUrl("thumbs", thumbKey)}`
  };
}

export async function testStorageBackend(config?: StorageConfig) {
  const effective = config ?? await getDefaultStorageBackend();
  const driver = resolveStorageAccessForConfig(effective).driver;
  try {
    return await driver.selfTest();
  } finally {
    if (effective.slug === "(test)") {
      await Promise.resolve(driver.close?.()).catch(() => undefined);
    }
  }
}
