import { staticLocalBaseUrl } from "../config/site-host.ts";
import { resolveStorageAccess } from "./backend-registry.ts";
import { thumbnailObjectKey } from "./image-paths.ts";
import type { ReadablePrefix } from "./object-keys.ts";

function encodeKeyPath(key: string) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function localMediaUrl(prefix: ReadablePrefix, key: string) {
  const route = prefix === "media" ? "media" : "thumbs";
  return `/${route}/${encodeKeyPath(key)}`;
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
  const { driver } = await resolveStorageAccess(slug);
  const thumbKey = thumbnailObjectKey(objectKey);
  const staticBase = staticLocalBaseUrl();
  const applicationThumbUrl = `${staticBase}${localMediaUrl("thumbs", thumbKey)}`;
  const directThumbUrl = driver.publicObjectUrl("thumbs", thumbKey);
  return {
    object_url: driver.publicObjectUrl("media", objectKey)
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
