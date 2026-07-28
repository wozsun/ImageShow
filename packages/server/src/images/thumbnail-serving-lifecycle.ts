import { ApiError, errorMessage } from "../core/api-error.ts";
import { coalesce } from "../core/coalesce.ts";

export type ThumbnailServingContext = {
  objectKey: string;
  thumbKey: string;
  backend: string;
};

export type ThumbnailServingLogger = {
  warn: (message: string, context: unknown) => void;
  error: (message: string, context: unknown) => void;
};

function logContext(
  context: ThumbnailServingContext,
  reason: string
) {
  return {
    object_key: context.objectKey,
    storage_backend: context.backend,
    reason
  };
}

export async function readablePublicThumbnailUrl({
  publicUrl,
  exists,
  context,
  log
}: {
  publicUrl: string;
  exists: () => Promise<boolean>;
  context: ThumbnailServingContext;
  log: ThumbnailServingLogger;
}) {
  if (!publicUrl) return "";
  try {
    return await exists() ? publicUrl : "";
  } catch (error) {
    log.error(
      "thumbnail_availability_check_failed",
      logContext(context, errorMessage(error))
    );
    return "";
  }
}

export async function recoverStoredThumbnail<T>({
  context,
  readThumbnail,
  sourceExists,
  rebuild,
  isNotFound,
  log
}: {
  context: ThumbnailServingContext;
  readThumbnail: () => Promise<T>;
  sourceExists: () => Promise<boolean>;
  rebuild: () => Promise<unknown>;
  isNotFound: (error: unknown) => boolean;
  log: ThumbnailServingLogger;
}): Promise<T | null> {
  try {
    return await readThumbnail();
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  let mediaExists = false;
  try {
    mediaExists = await sourceExists();
  } catch (error) {
    log.error(
      "thumbnail_source_check_failed",
      logContext(context, errorMessage(error))
    );
    return null;
  }
  if (!mediaExists) {
    log.warn(
      "thumbnail_rebuild_source_missing",
      logContext(context, "source object not found")
    );
    return null;
  }

  try {
    await coalesce(
      `thumbnail-rebuild:${context.backend}:${context.objectKey}`,
      rebuild
    );
  } catch (error) {
    log.error(
      "thumbnail_rebuild_failed",
      logContext(context, errorMessage(error))
    );
    return null;
  }

  try {
    return await readThumbnail();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    log.error(
      "thumbnail_rebuild_result_missing",
      logContext(
        context,
        `generated thumbnail ${context.thumbKey} was not readable`
      )
    );
    return null;
  }
}

export async function thumbnailFallbackOrNotFound<T>(
  readFallback: () => Promise<T>,
  isNotFound: (error: unknown) => boolean
) {
  try {
    return await readFallback();
  } catch (error) {
    if (isNotFound(error)) {
      throw new ApiError(404, "not_found", "Thumbnail not found");
    }
    throw error;
  }
}
