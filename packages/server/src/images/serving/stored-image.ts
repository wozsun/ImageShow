import { ApiError } from "../../core/api-error.ts";
import { withPublicDatabaseRead } from "../../core/database/public-fallback.ts";
import type { StoragePrefix } from "../../storage/objects/keys.ts";
import {
  immutableCacheControl,
  publicRedirectCacheControl,
  safeRedirectLocation
} from "../../core/http/headers.ts";
import {
  parseImageObjectKey
} from "../../storage/objects/image-paths.ts";
import { resolveReadableObject } from "../../storage/objects/access.ts";
import { isStorageObjectNotFound } from "../../storage/objects/not-found.ts";
import {
  readImageServingRecordById
} from "./record.ts";
import {
  streamResolvedObject,
  type StoredResponseRequest
} from "./stored-object-response.ts";


export async function serveLocalStoredObject(
  prefix: StoragePrefix,
  key: string,
  request: StoredResponseRequest & { signal: AbortSignal }
) {
  const parsed = parseImageObjectKey(key);
  if (!parsed) {
    throw new ApiError(404, "not_found", "Object not found");
  }
  const object = await resolveReadableObject(prefix, key, "local", { signal: request.signal });
  // This is the local object's origin, regardless of its current database location.
  return streamResolvedObject(object, "image/webp", immutableCacheControl, request);
}

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

export async function servePublicStoredObject(
  prefix: StoragePrefix,
  key: string,
  request: StoredResponseRequest & { signal: AbortSignal },
  dependencies: StoredImageServingDependencies = defaultStoredImageServingDependencies
) {
  const parsed = parseImageObjectKey(key);
  if (!parsed) {
    throw new ApiError(404, "not_found", "Object not found");
  }
  const signal = request.signal;
  const record = await withPublicDatabaseRead(signal, (database) =>
    dependencies.readImageServingRecordById(parsed.id, database)
  );
  if (!record) {
    throw new ApiError(404, "not_found", "Object not found");
  }
  const object = await dependencies.resolveReadableObject(prefix, key, record.storage_slug, {
    signal
  });
  if (object.publicUrl) return immutableRedirect(object.publicUrl);
  return dependencies
    .streamResolvedObject(object, "image/webp", immutableCacheControl, {
      ...request,
      signal
    })
    .catch((error: unknown) => {
      if (isStorageObjectNotFound(error)) {
        throw new ApiError(404, "not_found", "Object not found");
      }
      throw error;
    });
}
