import { staticLocalBaseUrl } from "../themes/host.ts";
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
  const { driver } = await resolveStorageAccess(slug);
  const thumbKey = thumbnailObjectKey(objectKey);
  const staticBase = staticLocalBaseUrl();
  return {
    object_url: driver.publicObjectUrl("media", objectKey)
      || `${staticBase}${localMediaUrl("media", objectKey)}`,
    thumb_url: driver.publicObjectUrl("thumbs", thumbKey)
      || `${staticBase}${localMediaUrl("thumbs", thumbKey)}`
  };
}
