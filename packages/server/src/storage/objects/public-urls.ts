import { staticLocalBaseUrl } from "../../config/site-host.ts";
import { getStorageBackend } from "../backends/registry.ts";
import type { PublicDatabaseReadAccess } from "../../core/database/public-fallback.ts";
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
  access: PublicDatabaseReadAccess = {}
) {
  const config = await getStorageBackend(slug, access);
  const thumbKey = thumbnailObjectKey(objectKey);
  const staticBase = staticLocalBaseUrl();
  const applicationThumbUrl = `${staticBase}${localStorageObjectUrl("thumbs", thumbKey)}`;
  const directThumbUrl = directStorageObjectUrl(config, "thumbs", thumbKey);
  return {
    object_url: directStorageObjectUrl(config, "full", objectKey)
      || `${staticBase}${localStorageObjectUrl("full", objectKey)}`,
    thumb_url: directThumbUrl || applicationThumbUrl
  };
}
