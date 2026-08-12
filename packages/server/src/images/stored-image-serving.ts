import { ApiError } from "../core/api-error.ts";
import {
  withPublicDatabaseRead,
  type PublicDatabaseReadAccess
} from "../core/public-db-fallback.ts";
import {
  immutableCacheControl,
  publicRedirectCacheControl,
  safeResponseHeaderValue
} from "../core/http/headers.ts";
import {
  isCanonicalImageObjectKey,
  isCanonicalThumbnailObjectKey,
  thumbnailObjectKey
} from "../storage/image-paths.ts";
import { resolveReadableObject } from "../storage/object-access.ts";
import { contentType } from "../storage/object-keys.ts";
import { isStorageObjectNotFound } from "../storage/not-found.ts";
import {
  readImageServingRecordByObjectKey,
  readImageServingRecordByThumbKey,
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
  readImageServingRecordByObjectKey:
    typeof readImageServingRecordByObjectKey;
  readImageServingRecordByThumbKey:
    typeof readImageServingRecordByThumbKey;
  resolveReadableObject: typeof resolveReadableObject;
  streamResolvedObject: typeof streamResolvedObject;
};

const defaultStoredImageServingDependencies: StoredImageServingDependencies = {
  readImageServingRecordByObjectKey,
  readImageServingRecordByThumbKey,
  resolveReadableObject,
  streamResolvedObject
};

function immutableRedirect(location: string) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: safeResponseHeaderValue("Location", location),
      "Cache-Control": publicRedirectCacheControl
    }
  });
}

async function deliverStoredThumbnail(
  record: StoredThumbnailRecord,
  request: StoredResponseRequest,
  dependencies: StoredImageServingDependencies,
  database: PublicDatabaseReadAccess = {}
): Promise<Response> {
  const thumbKey = thumbnailObjectKey(record.object_key);
  const resolvedThumb = await dependencies.resolveReadableObject(
    "thumbs",
    thumbKey,
    record.storage_slug,
    database
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
  if (!isCanonicalImageObjectKey(key)) {
    throw new ApiError(404, "not_found", "Object not found");
  }
  const signal = request.signal ?? new AbortController().signal;
  return withPublicDatabaseRead(signal, async (database, databaseSignal) => {
    const record = await dependencies.readImageServingRecordByObjectKey(
      key,
      database
    );
    if (!record) throw new ApiError(404, "not_found", "Object not found");
    const object = await dependencies.resolveReadableObject(
      "media",
      key,
      record.storage_slug,
      database
    );
    if (object.publicUrl) return immutableRedirect(object.publicUrl);
    const boundedRequest = {
      ...request,
      signal: request.signal
        ? AbortSignal.any([request.signal, databaseSignal])
        : databaseSignal
    };
    return dependencies.streamResolvedObject(
      object,
      contentType(record.ext),
      immutableCacheControl,
      boundedRequest
    ).catch((error: unknown) => {
      if (isStorageObjectNotFound(error)) {
        throw new ApiError(404, "not_found", "Object not found");
      }
      throw error;
    });
  });
}

export async function servePublicStoredThumbnail(
  key: string,
  request: StoredResponseRequest = {},
  dependencies: StoredImageServingDependencies =
    defaultStoredImageServingDependencies
) {
  if (!isCanonicalThumbnailObjectKey(key)) {
    throw new ApiError(404, "not_found", "Thumbnail not found");
  }
  const signal = request.signal ?? new AbortController().signal;
  return withPublicDatabaseRead(signal, async (database, databaseSignal) => {
    const record = await dependencies.readImageServingRecordByThumbKey(
      key,
      database
    );
    if (!record) throw new ApiError(404, "not_found", "Thumbnail not found");
    return deliverStoredThumbnail(
      record,
      {
        ...request,
        signal: request.signal
          ? AbortSignal.any([request.signal, databaseSignal])
          : databaseSignal
      },
      dependencies,
      database
    );
  });
}
