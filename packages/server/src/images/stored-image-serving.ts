import { ApiError, errorMessage } from "../core/api-error.ts";
import {
  immutableCacheControl,
  noStoreCacheControl,
  privateNoStoreCacheControl,
  publicProxyFallbackThumbCacheControl,
  publicRedirectCacheControl,
  safeResponseHeaderValue
} from "../core/http/headers.ts";
import { logger } from "../core/logger.ts";
import { thumbnailObjectKey } from "../storage/image-paths.ts";
import {
  resolveReadableObject,
  storageObjectExists,
  type ResolvedReadableObject
} from "../storage/object-access.ts";
import { contentType } from "../storage/object-keys.ts";
import { isStorageObjectNotFound } from "../storage/not-found.ts";
import { thumbnailRepairIsPending } from "../storage/move-cleanup.ts";
import {
  readImageServingRecordById,
  readReadyImageServingRecordByObjectKey,
  readReadyImageServingRecordByThumbKey,
  type ImageServingRecord
} from "./image-serving-record.ts";
import { repairStoredThumbnail } from "./thumbnail-repair.ts";
import {
  readablePublicThumbnailUrl,
  recoverStoredThumbnail,
  thumbnailFallbackOrNotFound
} from "./thumbnail-serving-lifecycle.ts";
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
  pendingFallbackCacheControl: string;
  missingFallbackCacheControl: string | null;
  allowPublicRedirect: boolean;
};

export type StoredImageServingDependencies = {
  readImageServingRecordById: typeof readImageServingRecordById;
  readReadyImageServingRecordByObjectKey:
    typeof readReadyImageServingRecordByObjectKey;
  readReadyImageServingRecordByThumbKey:
    typeof readReadyImageServingRecordByThumbKey;
  resolveReadableObject: typeof resolveReadableObject;
  storageObjectExists: typeof storageObjectExists;
  thumbnailRepairIsPending: typeof thumbnailRepairIsPending;
  repairStoredThumbnail: typeof repairStoredThumbnail;
  readablePublicThumbnailUrl: typeof readablePublicThumbnailUrl;
  recoverStoredThumbnail: typeof recoverStoredThumbnail;
  thumbnailFallbackOrNotFound: typeof thumbnailFallbackOrNotFound;
  streamResolvedObject: typeof streamResolvedObject;
};

const defaultStoredImageServingDependencies: StoredImageServingDependencies = {
  readImageServingRecordById,
  readReadyImageServingRecordByObjectKey,
  readReadyImageServingRecordByThumbKey,
  resolveReadableObject,
  storageObjectExists,
  thumbnailRepairIsPending,
  repairStoredThumbnail,
  readablePublicThumbnailUrl,
  recoverStoredThumbnail,
  thumbnailFallbackOrNotFound,
  streamResolvedObject
};

const publicThumbnailPolicy: ThumbnailDeliveryPolicy = {
  cacheControl: immutableCacheControl,
  pendingFallbackCacheControl: noStoreCacheControl,
  missingFallbackCacheControl: publicProxyFallbackThumbCacheControl,
  allowPublicRedirect: true
};

const adminThumbnailPolicy: ThumbnailDeliveryPolicy = {
  cacheControl: privateNoStoreCacheControl,
  pendingFallbackCacheControl: privateNoStoreCacheControl,
  missingFallbackCacheControl: null,
  allowPublicRedirect: false
};

async function streamStoredObject(
  prefix: "media" | "thumbs",
  key: string,
  backend: string,
  contentTypeValue: string,
  cacheControl: string,
  request: StoredResponseRequest,
  dependencies: StoredImageServingDependencies
) {
  return dependencies.streamResolvedObject(
    await dependencies.resolveReadableObject(prefix, key, backend),
    contentTypeValue,
    cacheControl,
    request
  );
}

function streamThumbnail(
  key: string,
  backend: string,
  cacheControl: string,
  request: StoredResponseRequest,
  dependencies: StoredImageServingDependencies
) {
  return streamStoredObject(
    "thumbs",
    key,
    backend,
    "image/webp",
    cacheControl,
    request,
    dependencies
  );
}

async function streamThumbnailEnsuring(
  record: StoredThumbnailRecord,
  thumbKey: string,
  cacheControl: string,
  request: StoredResponseRequest,
  dependencies: StoredImageServingDependencies,
  resolvedThumb?: ResolvedReadableObject
): Promise<Response | null> {
  const readThumbnail = () => (
    resolvedThumb
      ? dependencies.streamResolvedObject(
          resolvedThumb,
          "image/webp",
          cacheControl,
          request
        )
      : streamThumbnail(
          thumbKey,
          record.storage_slug,
          cacheControl,
          request,
          dependencies
        )
  );
  return dependencies.recoverStoredThumbnail({
    context: {
      objectKey: record.object_key,
      thumbKey,
      backend: record.storage_slug
    },
    readThumbnail,
    sourceExists: () => dependencies.storageObjectExists(
      "media",
      record.object_key,
      record.storage_slug,
      { signal: request.signal }
    ),
    rebuild: () => dependencies.repairStoredThumbnail(record.id),
    isNotFound: isStorageObjectNotFound,
    log: logger
  });
}

async function streamOriginalThumbnailFallback(
  record: StoredThumbnailRecord,
  request: StoredResponseRequest,
  cacheControl: string,
  dependencies: StoredImageServingDependencies
) {
  return dependencies.thumbnailFallbackOrNotFound(
    () => streamStoredObject(
      "media",
      record.object_key,
      record.storage_slug,
      contentType(record.ext),
      cacheControl,
      request,
      dependencies
    ),
    isStorageObjectNotFound
  );
}

async function thumbnailRepairRequiresFallback(
  record: StoredThumbnailRecord,
  thumbKey: string,
  dependencies: StoredImageServingDependencies
) {
  try {
    return await dependencies.thumbnailRepairIsPending(record.id, thumbKey);
  } catch (error) {
    logger.error("thumbnail_repair_state_check_failed", {
      object_key: record.object_key,
      storage_backend: record.storage_slug,
      reason: errorMessage(error)
    });
    return true;
  }
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
  dependencies: StoredImageServingDependencies
): Promise<Response> {
  const thumbKey = thumbnailObjectKey(record.object_key);
  if (await thumbnailRepairRequiresFallback(record, thumbKey, dependencies)) {
    return streamOriginalThumbnailFallback(
      record,
      request,
      policy.pendingFallbackCacheControl,
      dependencies
    );
  }

  const resolvedThumb = policy.allowPublicRedirect
    ? await dependencies.resolveReadableObject(
        "thumbs",
        thumbKey,
        record.storage_slug
      )
    : undefined;
  if (resolvedThumb?.publicUrl) {
    const publicUrl = await dependencies.readablePublicThumbnailUrl({
      publicUrl: resolvedThumb.publicUrl,
      exists: () => resolvedThumb.exists({ signal: request.signal }),
      context: {
        objectKey: record.object_key,
        thumbKey,
        backend: record.storage_slug
      },
      log: logger
    });
    if (publicUrl) return immutableRedirect(publicUrl);
  }

  const streamed = await streamThumbnailEnsuring(
    record,
    thumbKey,
    policy.cacheControl,
    request,
    dependencies,
    resolvedThumb
  );
  if (streamed) return streamed;
  if (policy.missingFallbackCacheControl) {
    return streamOriginalThumbnailFallback(
      record,
      request,
      policy.missingFallbackCacheControl,
      dependencies
    );
  }
  throw new ApiError(404, "not_found", "Thumbnail not found");
}

export async function servePublicStoredObject(
  key: string,
  request: StoredResponseRequest = {},
  dependencies: StoredImageServingDependencies =
    defaultStoredImageServingDependencies
) {
  const record = await dependencies.readReadyImageServingRecordByObjectKey(key);
  if (!record) throw new ApiError(404, "not_found", "Object not found");
  const object = await dependencies.resolveReadableObject(
    "media",
    key,
    record.storage_slug
  );
  if (object.publicUrl) return immutableRedirect(object.publicUrl);
  return dependencies.streamResolvedObject(
    object,
    contentType(record.ext),
    immutableCacheControl,
    request
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
  const record = await dependencies.readReadyImageServingRecordByThumbKey(key);
  if (!record) throw new ApiError(404, "not_found", "Thumbnail not found");
  return deliverStoredThumbnail(
    record,
    request,
    publicThumbnailPolicy,
    dependencies
  );
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
