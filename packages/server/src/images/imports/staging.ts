import { privateNoStoreCacheControl } from "../../core/http.ts";
import { withStorageLocationReadLock } from "../../storage/maintenance-lock.ts";
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
  return withStorageLocationReadLock(async () => {
    const results = await Promise.allSettled([
      removeObject("_uploads", stagingImageKey(id), storageSlug),
      removeObject("_uploads", stagingThumbnailKey(id), storageSlug)
    ]);
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length) {
      throw new AggregateError(failures, "Import staging cleanup failed");
    }
  });
}
