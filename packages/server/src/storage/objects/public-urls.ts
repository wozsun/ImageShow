import { imageResourceBaseUrl } from "../../config/site-host.ts";
import { getStorageBackend, type StorageRegistryAccess } from "../backends/registry.ts";
import type { StorageConfig } from "../backends/config.ts";
import { thumbnailObjectKey } from "./image-paths.ts";
import {
  storageS3ObjectName,
  type ReadablePrefix
} from "./keys.ts";

function encodeKeyPath(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function localStorageObjectUrl(prefix: ReadablePrefix, key: string) {
  return `/${prefix}/${encodeKeyPath(key)}`;
}

export function directStorageObjectUrl(
  config: StorageConfig,
  prefix: ReadablePrefix,
  key: string
) {
  if (config.type !== "s3" || !config.s3.public_base_url) return "";
  const base = config.s3.public_base_url.replace(/\/+$/, "");
  const objectName = storageS3ObjectName(config, prefix, key);
  return `${base}/${encodeKeyPath(objectName)}`;
}

export async function publicImageUrls(
  objectKey: string,
  slug: string,
  access: StorageRegistryAccess = {}
) {
  const config = await getStorageBackend(slug, access);
  return publicImageUrlsForConfig(objectKey, config);
}

export function publicThumbnailUrlForConfig(objectKey: string, config: StorageConfig) {
  const thumbKey = thumbnailObjectKey(objectKey);
  return directStorageObjectUrl(config, "thumbs", thumbKey)
    || `${imageResourceBaseUrl()}${localStorageObjectUrl("thumbs", thumbKey)}`;
}

export function publicImageUrlsForConfig(objectKey: string, config: StorageConfig) {
  return {
    object_url: directStorageObjectUrl(config, "full", objectKey)
      || `${imageResourceBaseUrl()}${localStorageObjectUrl("full", objectKey)}`,
    thumb_url: publicThumbnailUrlForConfig(objectKey, config)
  };
}
