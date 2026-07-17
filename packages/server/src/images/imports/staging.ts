import { privateNoStoreCacheControl } from "../../core/http.ts";
import { readStorageBuffer, removeObject } from "../../storage/storage.ts";
import type { PreparedPayload } from "./types.ts";

const stagingImageSuffix = ".image.webp";
const stagingThumbnailSuffix = ".thumb.webp";
const stagingObjectSuffixes = [stagingImageSuffix, stagingThumbnailSuffix] as const;

export function stagingImageKey(id: string) {
  return `${id}${stagingImageSuffix}`;
}

export function stagingThumbnailKey(id: string) {
  return `${id}${stagingThumbnailSuffix}`;
}

export function stagingSessionId(key: string) {
  const suffix = stagingObjectSuffixes.find((candidate) => (
    key.length > candidate.length && key.endsWith(candidate)
  ));
  return suffix ? key.slice(0, -suffix.length) : "";
}

export async function preparedThumbnailResponse(
  payload: Pick<PreparedPayload, "prepared_thumbnail_key">,
  storageSlug: string
) {
  const buffer = await readStorageBuffer("_uploads", payload.prepared_thumbnail_key, storageSlug);
  return new Response(buffer as unknown as BodyInit, {
    headers: { "Content-Type": "image/webp", "Cache-Control": privateNoStoreCacheControl }
  });
}

export async function cleanupStagedObjects(id: string, storageSlug: string) {
  await Promise.all([
    removeObject("_uploads", stagingImageKey(id), storageSlug).catch(() => undefined),
    removeObject("_uploads", stagingThumbnailKey(id), storageSlug).catch(() => undefined)
  ]);
}
