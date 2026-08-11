import { staticLocalBaseUrl } from "../config/site-host.ts";
import { getStorageBackend } from "./backend-registry.ts";
import type { StorageConfig } from "./backend-config.ts";
import { thumbnailObjectKey } from "./image-paths.ts";
import {
  storageS3ObjectName,
  type ReadablePrefix
} from "./object-keys.ts";

function encodeKeyPath(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function localMediaUrl(prefix: ReadablePrefix, key: string) {
  const route = prefix === "media" ? "media" : "thumbs";
  return `/${route}/${encodeKeyPath(key)}`;
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

export async function publicImageUrls(objectKey: string, slug: string) {
  return publicImageUrlsForDelivery(objectKey, slug, "application");
}

export type ThumbnailUrlDelivery = "application" | "direct";

function thumbnailUrlsForDelivery(
  applicationThumbUrl: string,
  directThumbUrl: string,
  thumbnailDelivery: ThumbnailUrlDelivery
) {
  if (thumbnailDelivery !== "direct" || !directThumbUrl) {
    return { thumb_url: applicationThumbUrl };
  }
  return {
    thumb_url: directThumbUrl,
    thumb_fallback_url: applicationThumbUrl
  };
}

export async function publicImageUrlsForDelivery(
  objectKey: string,
  slug: string,
  thumbnailDelivery: ThumbnailUrlDelivery
) {
  const config = await getStorageBackend(slug);
  const thumbKey = thumbnailObjectKey(objectKey);
  const staticBase = staticLocalBaseUrl();
  const applicationThumbUrl = `${staticBase}${localMediaUrl("thumbs", thumbKey)}`;
  const directThumbUrl = directStorageObjectUrl(config, "thumbs", thumbKey);
  return {
    object_url: directStorageObjectUrl(config, "media", objectKey)
      || `${staticBase}${localMediaUrl("media", objectKey)}`,
    // Public API consumers keep the repair-first route. Admin cards prefer
    // the final remote URL and enter the same repair route only after a real
    // image load failure, avoiding an unconditional redirect per card.
    ...thumbnailUrlsForDelivery(
      applicationThumbUrl,
      directThumbUrl,
      thumbnailDelivery
    )
  };
}
