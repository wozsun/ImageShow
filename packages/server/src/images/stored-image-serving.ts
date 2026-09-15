import { ApiError } from "../core/api-error.ts";
import { withPublicDatabaseRead } from "../core/database/public-fallback.ts";
import type { StorageRegistryAccess } from "../storage/backends/registry.ts";
import {
  immutableCacheControl,
  publicRedirectCacheControl,
  safeRedirectLocation
} from "../core/http/headers.ts";
import {
  parseImageObjectKey,
  thumbnailObjectKey
} from "../storage/objects/image-paths.ts";
import { resolveReadableObject } from "../storage/objects/access.ts";
import { contentType } from "../storage/objects/keys.ts";
import { isStorageObjectNotFound } from "../storage/objects/not-found.ts";
import {
  readImageServingRecordById,
  type ImageServingRecord
} from "./image-serving-record.ts";
import {
  streamResolvedObject,
  type StoredResponseRequest
} from "./stored-object-response.ts";

type StoredThumbnailRecord = Pick<
  ImageServingRecord,
  "object_key" | "storage_slug"
>;

export type StoredImageServingDependencies = {
  readImageServingRecordById: typeof readImageServingRecordById;
  resolveReadableObject: typeof resolveReadableObject;
  streamResolvedObject: typeof streamResolvedObject;
};

const defaultStoredImageServingDependencies: StoredImageServingDependencies = {
  readImageServingRecordById,
  resolveReadableObject,
  streamResolvedObject
};

function immutableRedirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: safeRedirectLocation(location),
      "Cache-Control": publicRedirectCacheControl
    }
  });
}

async function deliverStoredThumbnail(
  record: StoredThumbnailRecord,
  request: StoredResponseRequest,
  dependencies: StoredImageServingDependencies,
  access: StorageRegistryAccess = {}
): Promise<Response> {
  const thumbKey = thumbnailObjectKey(record.object_key);
  const resolvedThumb = await dependencies.resolveReadableObject(
    "thumbs",
    thumbKey,
    record.storage_slug,
    access
  );
  if (resolvedThumb?.publicUrl) {
    return immutableRedirect(resolvedThumb.publicUrl);
  }
  try {
    return await dependencies.streamResolvedObject(
      resolvedThumb,
      "image/webp",
      immutableCacheControl,
      request
    );
  } catch (error) {
    if (isStorageObjectNotFound(error)) {
      throw new ApiError(404, "not_found", "Thumbnail not found");
    }
    throw error;
  }
}

export async function servePublicStoredObject(
  key: string,
  request: StoredResponseRequest = {},
  dependencies: StoredImageServingDependencies =
    defaultStoredImageServingDependencies
) {
  const parsed = parseImageObjectKey(key);
  if (!parsed) {
    throw new ApiError(404, "not_found", "Object not found");
  }
  const signal = request.signal ?? new AbortController().signal;
  const record = await withPublicDatabaseRead(signal, (database) => (
    dependencies.readImageServingRecordById(parsed.id, database)
  ));
  if (!record || record.object_key !== key) {
    throw new ApiError(404, "not_found", "Object not found");
  }
  const object = await dependencies.resolveReadableObject(
    "full", key, record.storage_slug, { signal }
  );
  if (object.publicUrl) return immutableRedirect(object.publicUrl);
  return dependencies.streamResolvedObject(
    object, contentType(record.ext), immutableCacheControl, { ...request, signal }
  ).catch((error: unknown) => {
    if (isStorageObjectNotFound(error)) {
      throw new ApiError(404, "not_found", "Object not found");
    }
    throw error;
  });
}

export async function servePublicStoredThumbnail(
  key: string,
  request: StoredResponseRequest = {},
  dependencies: StoredImageServingDependencies =
    defaultStoredImageServingDependencies
) {
  const parsed = parseImageObjectKey(key);
  if (!parsed || parsed.ext !== "webp") {
    throw new ApiError(404, "not_found", "Thumbnail not found");
  }
  const signal = request.signal ?? new AbortController().signal;
  const record = await withPublicDatabaseRead(signal, (database) => (
    dependencies.readImageServingRecordById(parsed.id, database)
  ));
  if (!record || thumbnailObjectKey(record.object_key) !== key) {
    throw new ApiError(404, "not_found", "Thumbnail not found");
  }
  return deliverStoredThumbnail(record, { ...request, signal }, dependencies, { signal });
}
