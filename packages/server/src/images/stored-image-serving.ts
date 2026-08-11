import { ApiError } from "../core/api-error.ts";
import {
  withPublicDatabaseRead,
  type PublicDatabaseReadAccess
} from "../core/public-db-fallback.ts";
import {
  immutableCacheControl,
  privateNoStoreCacheControl,
  publicRedirectCacheControl,
  safeResponseHeaderValue
} from "../core/http/headers.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import { resolveReadableObject } from "../storage/object-access.ts";
import { contentType } from "../storage/object-keys.ts";
import { isStorageObjectNotFound } from "../storage/not-found.ts";
import {
  readImageServingRecordById,
  readReadyImageServingRecordByObjectKey,
  readReadyImageServingRecordByThumbKey,
  type ImageServingRecord
} from "./image-serving-record.ts";
import {
  streamResolvedObject,
  type StoredResponseRequest
} from "./stored-object-response.ts";

type StoredThumbnailRecord = Pick<
  ImageServingRecord,
  "id" | "object_key" | "ext" | "storage_slug"
>;

type ThumbnailDeliveryPolicy = {
  cacheControl: string;
  allowPublicRedirect: boolean;
};

export type StoredImageServingDependencies = {
  readImageServingRecordById: typeof readImageServingRecordById;
  readReadyImageServingRecordByObjectKey:
    typeof readReadyImageServingRecordByObjectKey;
  readReadyImageServingRecordByThumbKey:
    typeof readReadyImageServingRecordByThumbKey;
  resolveReadableObject: typeof resolveReadableObject;
  streamResolvedObject: typeof streamResolvedObject;
};

const defaultStoredImageServingDependencies: StoredImageServingDependencies = {
  readImageServingRecordById,
  readReadyImageServingRecordByObjectKey,
  readReadyImageServingRecordByThumbKey,
  resolveReadableObject,
  streamResolvedObject
};

const publicThumbnailPolicy: ThumbnailDeliveryPolicy = {
  cacheControl: immutableCacheControl,
  allowPublicRedirect: true
};

const adminThumbnailPolicy: ThumbnailDeliveryPolicy = {
  cacheControl: privateNoStoreCacheControl,
  allowPublicRedirect: false
};

async function streamStoredObject(
  prefix: "media" | "thumbs",
  key: string,
  backend: string,
  contentTypeValue: string,
  cacheControl: string,
  request: StoredResponseRequest,
  dependencies: StoredImageServingDependencies,
  database: PublicDatabaseReadAccess = {}
) {
  return dependencies.streamResolvedObject(
    await dependencies.resolveReadableObject(prefix, key, backend, database),
    contentTypeValue,
    cacheControl,
    request
  );
}

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
  policy: ThumbnailDeliveryPolicy,
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
    if (policy.allowPublicRedirect) {
      return immutableRedirect(resolvedThumb.publicUrl);
    }
  }
  try {
    return await dependencies.streamResolvedObject(
      resolvedThumb,
      "image/webp",
      policy.cacheControl,
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
  const signal = request.signal ?? new AbortController().signal;
  return withPublicDatabaseRead(signal, async (database, databaseSignal) => {
    const record = await dependencies.readReadyImageServingRecordByObjectKey(
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
  const signal = request.signal ?? new AbortController().signal;
  return withPublicDatabaseRead(signal, async (database, databaseSignal) => {
    const record = await dependencies.readReadyImageServingRecordByThumbKey(
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
      publicThumbnailPolicy,
      dependencies,
      database
    );
  });
}

export async function serveAdminStoredThumbnail(
  id: string,
  request: StoredResponseRequest = {},
  dependencies: StoredImageServingDependencies =
    defaultStoredImageServingDependencies
) {
  const record = await dependencies.readImageServingRecordById(id, {
    includeDeleted: true
  });
  if (!record) throw new ApiError(404, "not_found", "Image not found");
  return deliverStoredThumbnail(
    record,
    request,
    adminThumbnailPolicy,
    dependencies
  );
}

export async function serveAdminStoredObject(
  id: string,
  request: StoredResponseRequest = {},
  dependencies: StoredImageServingDependencies =
    defaultStoredImageServingDependencies
) {
  const record = await dependencies.readImageServingRecordById(id, {
    includeDeleted: true
  });
  if (!record) throw new ApiError(404, "not_found", "Image not found");
  return streamStoredObject(
    "media",
    record.object_key,
    record.storage_slug,
    contentType(record.ext),
    privateNoStoreCacheControl,
    request,
    dependencies
  );
}
