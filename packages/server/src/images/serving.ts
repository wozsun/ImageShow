import { createHash } from "node:crypto";
import { queryForPublicRead } from "../core/public-pg-fallback.ts";
import { ApiError, errorMessage } from "../core/api-error.ts";
import { logger } from "../core/logger.ts";
import {
  immutableCacheControl,
  noStoreCacheControl,
  privateNoStoreCacheControl,
  publicProxyFallbackThumbCacheControl,
  publicProxyImageCacheControl,
  publicRedirectCacheControl,
  safeResponseHeaderValue
} from "../core/http/headers.ts";
import { safeFetchExternalImage } from "../core/external-image-fetch.ts";
import { coalesce } from "../core/coalesce.ts";
import { repairStoredThumbnail } from "./thumbnail-repair.ts";
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
  getOriginalDirectCache,
  setOriginalDirectCache
} from "./original-direct-cache.ts";
import {
  readReadyImageById,
  readReadyImageByObjectKey,
  readReadyImageByThumbKey
} from "./ready-cache/query.ts";
import { linkBaseUrl } from "../config/site-host.ts";
import { displayUrlForOriginalComparison, hasDistinctOriginalUrl } from "./original-link.ts";
import {
  readablePublicThumbnailUrl,
  recoverStoredThumbnail,
  thumbnailFallbackOrNotFound
} from "./thumbnail-serving-lifecycle.ts";
import {
  streamResolvedObject,
  type StoredResponseRequest
} from "./stored-object-response.ts";
import {
  externalImageProxyTimeoutMs,
  externalImageProxyUserAgent,
  proxyExternalImage
} from "./external-image-proxy.ts";

export type { StoredResponseRequest } from "./stored-object-response.ts";

type ImageLookupByIdItem = {
  id: string;
  object_key: string;
  original: string;
  ext: string;
  storage_slug: string;
  device: "pc" | "mb";
  brightness: "dark" | "light";
  theme: string;
  status: string;
  description: string;
  source: string;
  updated_at: string;
};

function externalImageExt(url: string) {
  try {
    const ext = new URL(url).pathname.split(".").pop()?.toLowerCase();
    return ext === "jpeg" ? "jpg" : (ext && ["jpg", "png", "webp", "gif", "avif"].includes(ext) ? ext : "jpg");
  } catch {
    return "jpg";
  }
}

async function originalSupportsDirectAccess(url: string, userAgent: string) {
  try {
    // 用 Range 只探测第一个字节，确认“无 Referer 直连是否可达”，避免为了探测下载整张原图。
    const response = await safeFetchExternalImage(url, {
      method: "GET",
      timeoutMs: externalImageProxyTimeoutMs,
      headers: { "User-Agent": userAgent || externalImageProxyUserAgent, Accept: "image/*,*/*", Range: "bytes=0-0" },
      imageValidation: "header"
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}

function originalDirectUserAgentFamily(userAgent: string) {
  const ua = userAgent.toLowerCase();
  if (/(bot|crawler|spider|preview)/.test(ua)) return "bot";
  if (ua.includes("micromessenger")) return "wechat";
  if (ua.includes("firefox") || ua.includes("fxios")) return "firefox";
  if (ua.includes("edg/") || ua.includes("edgios") || ua.includes("edga")) return "edge";
  if (ua.includes("chrome") || ua.includes("crios") || ua.includes("chromium")) return "chrome";
  if (ua.includes("safari") && !ua.includes("android")) return "safari";
  return "other";
}

function originalDirectCacheKey(url: string, userAgent: string) {
  return createHash("sha1")
    .update(url)
    .update("\n")
    .update(originalDirectUserAgentFamily(userAgent))
    .digest("hex");
}

async function cachedOriginalSupportsDirectAccess(url: string, userAgent: string) {
  const cacheKey = originalDirectCacheKey(url, userAgent || externalImageProxyUserAgent);
  const cached = await getOriginalDirectCache(cacheKey);
  if (cached) return cached.direct;

  return coalesce(`original-direct:${cacheKey}`, async () => {
    const raced = await getOriginalDirectCache(cacheKey);
    if (raced) return raced.direct;

    const direct = await originalSupportsDirectAccess(url, userAgent);
    await setOriginalDirectCache(cacheKey, direct);
    return direct;
  });
}

async function streamStoredObject(
  prefix: "media" | "thumbs",
  key: string,
  backend: string,
  contentTypeValue: string,
  cacheControl: string,
  request: StoredResponseRequest = {}
) {
  return streamResolvedObject(
    await resolveReadableObject(prefix, key, backend),
    contentTypeValue,
    cacheControl,
    request
  );
}

async function streamThumb(key: string, backend: string, cacheControl = immutableCacheControl, request: StoredResponseRequest = {}) {
  return streamStoredObject("thumbs", key, backend, "image/webp", cacheControl, request);
}

async function streamThumbEnsuring(
  imageId: string,
  objectKey: string,
  thumbKey: string,
  backend: string,
  cacheControl = immutableCacheControl,
  request: StoredResponseRequest = {},
  resolvedThumb?: ResolvedReadableObject
): Promise<Response | null> {
  const readThumbnail = () => (
    resolvedThumb
      ? streamResolvedObject(
          resolvedThumb,
          "image/webp",
          cacheControl,
          request
        )
      : streamThumb(thumbKey, backend, cacheControl, request)
  );
  return recoverStoredThumbnail({
    context: { objectKey, thumbKey, backend },
    readThumbnail,
    sourceExists: () => storageObjectExists("media", objectKey, backend),
    rebuild: () => repairStoredThumbnail(imageId),
    isNotFound: isStorageObjectNotFound,
    log: logger
  });
}

async function readablePublicThumbUrl(
  object: ResolvedReadableObject,
  objectKey: string,
  thumbKey: string,
  backend: string
) {
  return readablePublicThumbnailUrl({
    publicUrl: object.publicUrl,
    exists: object.exists,
    context: { objectKey, thumbKey, backend },
    log: logger
  });
}

async function streamOriginalThumbnailFallback(
  objectKey: string,
  ext: string,
  backend: string,
  request: StoredResponseRequest,
  cacheControl = publicProxyFallbackThumbCacheControl
) {
  return thumbnailFallbackOrNotFound(
    () => streamStoredObject(
      "media",
      objectKey,
      backend,
      contentType(ext),
      cacheControl,
      request
    ),
    isStorageObjectNotFound
  );
}

async function thumbnailRepairRequiresFallback(
  imageId: string,
  objectKey: string,
  backend: string,
  thumbKey: string
) {
  try {
    return thumbnailRepairIsPending(imageId, thumbKey);
  } catch (error) {
    logger.error("thumbnail_repair_state_check_failed", {
      object_key: objectKey,
      storage_backend: backend,
      reason: errorMessage(error)
    });
    return true;
  }
}

async function imageLookupById(
  id: string,
  includeDeleted = false
): Promise<ImageLookupByIdItem | null> {
  const cached = await readReadyImageById(id);
  if (cached.cached && cached.value) {
    return { ...cached.value, status: "ready" };
  }
  if (cached.cached && !includeDeleted) return null;
  const row = (await queryForPublicRead(
    `SELECT id, object_key, original, ext, storage_slug, device, brightness, theme,
            status, description, source, updated_at::text AS updated_at
       FROM metadata
      WHERE id=$1
        AND ($2::boolean OR status='ready')
      LIMIT 1`,
    [id, includeDeleted]
  )).rows[0] as ImageLookupByIdItem | undefined;
  if (!row) return null;
  return row;
}

export async function serveObject(key: string, request: StoredResponseRequest = {}) {
  const cached = await readReadyImageByObjectKey(key);
  let ext = cached.cached ? cached.value?.ext : undefined;
  let storageSlug = cached.cached ? cached.value?.storage_slug : undefined;
  if (cached.cached && !cached.value) {
    throw new ApiError(404, "not_found", "Object not found");
  }
  if (!cached.cached) {
    const row = (await queryForPublicRead(
      "SELECT object_key, ext, storage_slug, status FROM metadata WHERE object_key=$1 LIMIT 1",
      [key]
    )).rows[0] as { ext: string; storage_slug: string; status: string } | undefined;

    if (!row || row.status !== "ready") throw new ApiError(404, "not_found", "Object not found");
    ext = row.ext;
    storageSlug = row.storage_slug;
  }
  if (!ext || !storageSlug) throw new ApiError(404, "not_found", "Object not found");
  const object = await resolveReadableObject("media", key, storageSlug);
  if (object.publicUrl) return immutableRedirect(object.publicUrl);
  return streamResolvedObject(object, contentType(ext), immutableCacheControl, request).catch((error: unknown) => {
    if (isStorageObjectNotFound(error)) throw new ApiError(404, "not_found", "Object not found");
    throw error;
  });
}

export async function serveThumb(key: string, request: StoredResponseRequest = {}): Promise<Response> {
  const cached = await readReadyImageByThumbKey(key);
  if (cached.cached && !cached.value) {
    throw new ApiError(404, "not_found", "Thumbnail not found");
  }
  type ThumbServingRow = {
    id: string;
    object_key: string;
    ext: string;
    storage_slug: string;
    status: string;
  };
  const row: ThumbServingRow | undefined = cached.cached
    ? { ...cached.value!, status: "ready" }
    : (await queryForPublicRead<ThumbServingRow>(
        `SELECT id, object_key, ext, storage_slug, status
           FROM metadata
          WHERE object_key=$1
             OR regexp_replace(object_key, '\\.[^/.]+$', '.webp')=$1
          LIMIT 1`,
        [key]
      )).rows[0];
  if (!row || row.status !== "ready") {
    throw new ApiError(404, "not_found", "Thumbnail not found");
  }
  const objectKey = row.object_key;
  const thumbKey = thumbnailObjectKey(objectKey);
  const ext = row.ext;
  const backend = row.storage_slug;
  if (await thumbnailRepairRequiresFallback(
    row.id,
    objectKey,
    backend,
    thumbKey
  )) {
    return streamOriginalThumbnailFallback(
      objectKey,
      ext,
      backend,
      request,
      noStoreCacheControl
    );
  }
  const object = await resolveReadableObject("thumbs", thumbKey, backend);
  const publicUrl = await readablePublicThumbUrl(
    object,
    objectKey,
    thumbKey,
    backend
  );
  if (publicUrl) return immutableRedirect(publicUrl);
  const streamed = await streamThumbEnsuring(
    row.id,
    objectKey,
    thumbKey,
    backend,
    immutableCacheControl,
    request,
    object
  );
  if (streamed) return streamed;

  return streamOriginalThumbnailFallback(
    objectKey,
    ext,
    backend,
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

async function resolvePublicExternalOriginal(id: string) {
  const row = await imageLookupById(id);
  const original = String(row?.original ?? "");
  if (!row || row.status !== "ready") {
    throw new ApiError(404, "not_found", "Original link not found");
  }

  if (!/^https:\/\//i.test(original)) throw new ApiError(404, "not_found", "Original link not found");
  const displayUrl = await displayUrlForOriginalComparison(row);
  if (!hasDistinctOriginalUrl(original, displayUrl)) throw new ApiError(404, "not_found", "Original link not found");
  return { url: original, updatedAt: row.updated_at };
}

export async function redirectOriginalLink(id: string, userAgent: string) {
  const original = await resolvePublicExternalOriginal(id);
  const direct = await cachedOriginalSupportsDirectAccess(original.url, userAgent);
  // 原图链接可无 Referer 直连时直接 302；否则跳到 link 子域代理，避免详情页按钮打开后被防盗链拦截。
  return new Response(null, {
    status: 302,
    headers: {
      Location: safeResponseHeaderValue(
        "Location",
        direct ? original.url : `${linkBaseUrl()}/original/${encodeURIComponent(id)}`
      ),
      "Cache-Control": privateNoStoreCacheControl,
      "Referrer-Policy": "no-referrer"
    }
  });
}

export async function serveOriginalLinkProxy(
  id: string,
  request: {
    method?: "GET" | "HEAD";
    ifNoneMatch?: string;
    ifModifiedSince?: string;
  } = {}
) {
  const original = await resolvePublicExternalOriginal(id);
  return proxyExternalImage(
    original.url,
    externalImageExt(original.url),
    {
      method: request.method ?? "GET",
      validators: {
        ifNoneMatch: request.ifNoneMatch,
        ifModifiedSince: request.ifModifiedSince,
        resourceUpdatedAt: original.updatedAt
      }
    },
    {
      "Cache-Control": noStoreCacheControl,
      "Referrer-Policy": "no-referrer"
    },
    publicProxyImageCacheControl
  );
}

export async function serveAdminThumb(id: string, request: StoredResponseRequest = {}): Promise<Response> {
  const row = await imageLookupById(id, true);
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  const backend = row.storage_slug;
  const thumbKey = thumbnailObjectKey(row.object_key);
  if (await thumbnailRepairRequiresFallback(
    row.id,
    row.object_key,
    backend,
    thumbKey
  )) {
    return streamOriginalThumbnailFallback(
      row.object_key,
      row.ext,
      backend,
      request,
      privateNoStoreCacheControl
    );
  }
  const streamed = await streamThumbEnsuring(
    row.id,
    row.object_key,
    thumbKey,
    backend,
    privateNoStoreCacheControl,
    request
  );
  if (streamed) return streamed;
  throw new ApiError(404, "not_found", "Thumbnail not found");
}

export async function serveAdminObject(id: string, request: StoredResponseRequest = {}): Promise<Response> {
  const row = await imageLookupById(id, true);
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  const backend = row.storage_slug;
  return streamStoredObject("media", row.object_key, backend, contentType(row.ext), privateNoStoreCacheControl, request);
}

export async function serveAdminOriginalLink(id: string, userAgent: string): Promise<Response> {
  const row = await imageLookupById(id, true);
  const original = String(row?.original ?? "");
  if (!row || !/^https:\/\//i.test(original)) throw new ApiError(404, "not_found", "Original link not found");
  const displayUrl = await displayUrlForOriginalComparison(row);
  if (!hasDistinctOriginalUrl(original, displayUrl)) throw new ApiError(404, "not_found", "Original link not found");
  if (await cachedOriginalSupportsDirectAccess(original, userAgent)) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: safeResponseHeaderValue("Location", original),
        "Cache-Control": privateNoStoreCacheControl,
        "Referrer-Policy": "no-referrer"
      }
    });
  }
  return proxyExternalImage(original, externalImageExt(original), { method: "GET" }, {
    "Cache-Control": privateNoStoreCacheControl,
    "Referrer-Policy": "no-referrer"
  });
}
