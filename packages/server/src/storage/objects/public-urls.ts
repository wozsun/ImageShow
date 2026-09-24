import { imageResourceBaseUrl } from "../../config/site-host.ts";
import { getRuntimeConfig } from "../../config/runtime-config-store.ts";
import { assertLocalPublicUrlDomain } from "../backends/config.ts";
import { getStorageBackend, type StorageRegistryAccess } from "../backends/registry.ts";
import type { StorageConfig } from "../backends/config.ts";
import { storageObjectKey } from "@imageshow/shared/browser";
import { assertCanonicalImageObjectKey, thumbnailObjectKey } from "./image-paths.ts";
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
  if (config.type === "local") {
    if (config.public_base_url)
      assertLocalPublicUrlDomain(config.public_base_url, getRuntimeConfig().site.domain);
    return config.public_base_url
      ? `${config.public_base_url}${localStorageObjectUrl(prefix, key)}`
      : "";
  }
  if (!config.s3.public_base_url) return "";
  const base = config.s3.public_base_url.replace(/\/+$/, "");
  const objectName = storageS3ObjectName(config, prefix, key);
  return `${base}/${encodeKeyPath(objectName)}`;
}

export async function publicImageUrl(
  image: { id: string; ext: string },
  slug: string,
  access: StorageRegistryAccess = {}
) {
  const config = await getStorageBackend(slug, access);
  return publicImageUrlForConfig(image, config);
}

export function publicThumbnailUrlForConfig(id: string, config: StorageConfig) {
  const thumbKey = thumbnailObjectKey(id);
  return (
    directStorageObjectUrl(config, "thumbs", thumbKey) ||
    `${imageResourceBaseUrl()}${localStorageObjectUrl("thumbs", thumbKey)}`
  );
}

function publicImageUrlForConfig(image: { id: string; ext: string }, config: StorageConfig) {
  const objectKey = storageObjectKey(image.id, image.ext);
  assertCanonicalImageObjectKey(objectKey);
  return (
    directStorageObjectUrl(config, "full", objectKey) ||
    `${imageResourceBaseUrl()}${localStorageObjectUrl("full", objectKey)}`
  );
}

export function publicImageUrlsForConfig(
  image: { id: string; ext: string },
  config: StorageConfig
) {
  return {
    object_url: publicImageUrlForConfig(image, config),
    thumb_url: publicThumbnailUrlForConfig(image.id, config)
  };
}
