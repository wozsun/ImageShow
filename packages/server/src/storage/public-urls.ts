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
  const { driver } = await resolveStorageAccess(slug);
  const thumbKey = thumbnailObjectKey(objectKey);
  const staticBase = staticLocalBaseUrl();
  return {
    object_url: driver.publicObjectUrl("media", objectKey)
      || `${staticBase}${localMediaUrl("media", objectKey)}`,
    // Every thumbnail enters the application once so missing remote objects
    // can repair or fall back. Public stored-thumbnail delivery still
    // redirects healthy remote objects to their public URL with a short
    // cache lifetime.
    thumb_url: `${staticBase}${localMediaUrl("thumbs", thumbKey)}`
  };
}
