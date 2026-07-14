import { createHash } from "node:crypto";
import { pool } from "../core/db.ts";
import { ApiError, immutableCacheControl, noStoreCacheControl, privateNoStoreCacheControl, publicProxyFallbackThumbCacheControl, publicProxyImageCacheControl, publicRedirectCacheControl } from "../core/http.ts";
import { isExternalImageRejection, safeFetchExternalImage } from "../core/external-image-fetch.ts";
import { coalesce } from "../core/coalesce.ts";
import { ifNoneMatchMatches, ifRangeMatches } from "../core/http-validator.ts";
import { generateStoredThumbnail } from "./processing.ts";
import { linkThumbnailKey, thumbnailObjectKey } from "../storage/image-paths.ts";
import { contentType, exists, openObject, publicObjectUrl } from "../storage/storage.ts";
import { isStorageNotFoundError } from "../storage/storage-backend.ts";
import type { OpenedRead } from "../storage/storage-backend.ts";
import { webReadableFromNode } from "../storage/stream-buffer.ts";
import { getImageLookupById, getImageLookupByObjectKey, getImageLookupByThumbKey, getOriginalDirectCache, setImageLookup, setImageLookupById, setOriginalDirectCache, type ImageLookupByIdItem } from "./image-cache.ts";
import { linkBaseUrl } from "../themes/host.ts";
import { displayUrlForOriginalComparison, hasDistinctOriginalUrl } from "./original-link.ts";

const proxyTimeoutMs = 12_000;
const proxyUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type ProxyFallback = () => Response | Promise<Response>;
export type StoredResponseRequest = {
  range?: string;
  ifNoneMatch?: string;
  ifRange?: string;
  isHead?: boolean;
};

function shouldNotRedirectExternalError(error: unknown) {
  return isExternalImageRejection(error);
}

export async function proxyExternalImage(
  externalUrl: string,
  ext: string,
  isHead: boolean,
  baseHeaders: Record<string, string> = {},
  fallbackCacheControl?: string,
  fallback?: ProxyFallback
): Promise<Response> {
  const redirectFallback = async () => fallback ? fallback() : new Response(null, {
    status: 302,
    headers: { ...baseHeaders, Location: externalUrl, "Referrer-Policy": "no-referrer" }
  });
  if (isHead) return new Response(null, { headers: { ...baseHeaders, "Content-Type": contentType(ext) } });

  let origin: string;
  try {
    origin = `${new URL(externalUrl).origin}/`;
  } catch {
    if (fallback) return fallback();
    throw new ApiError(400, "external_image_rejected", "外部图片请求未通过安全校验");
  }

  try {
    // 外链代理带源站同源 Referer 绕过简单防盗链；取流失败时走调用方 fallback，默认退回 302。
    const upstream = await safeFetchExternalImage(externalUrl, {
      timeoutMs: proxyTimeoutMs,
      headers: { Referer: origin, "User-Agent": proxyUserAgent, Accept: "image/*,*/*" },
      imageValidation: "sniff"
    });
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      return redirectFallback();
    }

    const headers: Record<string, string> = { ...baseHeaders, "Content-Type": upstream.headers.get("content-type") || contentType(ext) };
    if (fallbackCacheControl) {
      // 代理图优先继承源站缓存策略；只有源站没有声明时才使用站内 CDN fallback。
      const originCacheControl = upstream.headers.get("cache-control");
      const originExpires = upstream.headers.get("expires");
      if (originCacheControl) headers["Cache-Control"] = originCacheControl;
      else if (originExpires) {
        delete headers["Cache-Control"];
        headers.Expires = originExpires;
      } else {
        headers["Cache-Control"] = fallbackCacheControl;
      }
    }
    return new Response(upstream.body, { headers });
  } catch (error) {
    if (shouldNotRedirectExternalError(error)) {
      if (fallback) return fallback();
      throw error;
    }
    return redirectFallback();
  }
}

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
      timeoutMs: proxyTimeoutMs,
      headers: { "User-Agent": userAgent || proxyUserAgent, Accept: "image/*,*/*", Range: "bytes=0-0" },
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
  const cacheKey = originalDirectCacheKey(url, userAgent || proxyUserAgent);
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

/** @internal Exported only for HTTP validator verification. */
export function etagMatches(header: string | undefined, etag: string) {
  return ifNoneMatchMatches(header, etag);
}

/** @internal Exported only for HTTP validator verification. */
export { ifRangeMatches };

function sameObjectVersion(left: OpenedRead, right: OpenedRead) {
  if (left.etag || right.etag) return Boolean(left.etag && right.etag && left.etag === right.etag);
  return Boolean(
    left.lastModified && right.lastModified &&
    left.lastModified === right.lastModified &&
    left.totalSize !== undefined && left.totalSize === right.totalSize
  );
}

async function streamStoredObject(
  prefix: "media" | "thumbs" | "link",
  key: string,
  backend: string,
  contentTypeValue: string,
  cacheControl: string,
  request: StoredResponseRequest = {}
) {
  const validateBeforeRange = Boolean(request.range && (request.ifNoneMatch || request.ifRange));
  let opened = await openObject(prefix, key, backend, validateBeforeRange ? undefined : request.range);
  if (ifNoneMatchMatches(request.ifNoneMatch, opened.etag)) {
    opened.body.destroy();
    const headers = new Headers({ "Cache-Control": cacheControl, "Accept-Ranges": "bytes" });
    if (opened.etag) headers.set("ETag", opened.etag);
    if (opened.lastModified) headers.set("Last-Modified", opened.lastModified);
    return new Response(null, { status: 304, headers });
  }
  const shouldApplyRange = Boolean(request.range && (!request.ifRange || ifRangeMatches(request.ifRange, opened)));
  if (validateBeforeRange && shouldApplyRange) {
    const full = opened;
    full.body.destroy();
    opened = await openObject(prefix, key, backend, request.range);
    if (!sameObjectVersion(full, opened)) {
      opened.body.destroy();
      opened = await openObject(prefix, key, backend);
    }
  }
  const headers = new Headers({
    "Content-Type": contentTypeValue,
    "Cache-Control": cacheControl,
    "Accept-Ranges": "bytes"
  });
  if (opened.etag) headers.set("ETag", opened.etag);
  if (opened.lastModified) headers.set("Last-Modified", opened.lastModified);
  if (opened.size !== undefined) headers.set("Content-Length", String(opened.size));
  if (opened.contentRange) headers.set("Content-Range", opened.contentRange);
  if (request.isHead) opened.body.destroy();
  return new Response(request.isHead ? null : webReadableFromNode(opened.body), {
    status: opened.contentRange ? 206 : 200,
    headers
  });
}

async function streamThumb(key: string, backend: string, cacheControl = immutableCacheControl, request: StoredResponseRequest = {}) {
  return streamStoredObject("thumbs", key, backend, "image/webp", cacheControl, request);
}

async function streamThumbEnsuring(objectKey: string, thumbKey: string, backend: string, cacheControl = immutableCacheControl, request: StoredResponseRequest = {}): Promise<Response | null> {
  try {
    return await streamThumb(thumbKey, backend, cacheControl, request);
  } catch (error) {
    if (!isStorageNotFoundError(error)) throw error;
  }

  // 缩略图缺失但原图仍在时即时补建，修复历史数据或迁移中断造成的缩略图空洞。
  if (await exists("media", objectKey, backend)) {
    await generateStoredThumbnail(objectKey, backend).catch(() => undefined);
  }
  return streamThumb(thumbKey, backend, cacheControl, request).catch((error: unknown) => {
    if (isStorageNotFoundError(error)) return null;
    throw error;
  });
}

async function linkThumbFallback(id: string, row: { storage_slug: string; device: string; brightness: string; theme: string }, cacheControl: string) {
  const backend = row.storage_slug;
  const key = linkThumbnailKey(row.device, row.brightness, row.theme, id);
  return streamStoredObject("link", key, backend, "image/webp", cacheControl).catch((error: unknown) => {
    if (isStorageNotFoundError(error)) throw new ApiError(404, "not_found", "Link thumbnail not found");
    throw error;
  });
}

async function imageLookupById(id: string): Promise<ImageLookupByIdItem | null> {
  const cached = await getImageLookupById(id);
  if (cached) return cached;
  const row = (await pool.query(
    `SELECT id, object_key, original, ext, storage_slug, is_link, device, brightness, theme,
            status, description, source
       FROM metadata
      WHERE id=$1
      LIMIT 1`,
    [id]
  )).rows[0] as Partial<ImageLookupByIdItem> | undefined;
  if (!row) return null;
  const item: ImageLookupByIdItem = {
    id,
    object_key: String(row.object_key ?? ""),
    original: String(row.original ?? ""),
    ext: String(row.ext ?? ""),
    storage_slug: String(row.storage_slug),
    is_link: Boolean(row.is_link),
    device: row.device as ImageLookupByIdItem["device"],
    brightness: row.brightness as ImageLookupByIdItem["brightness"],
    theme: String(row.theme ?? "none"),
    status: String(row.status ?? ""),
    description: String(row.description ?? ""),
    source: String(row.source ?? "")
  };
  await setImageLookupById(item);
  return item;
}

export async function serveObject(key: string, request: StoredResponseRequest = {}) {
  const cached = await getImageLookupByObjectKey(key);
  let ext = cached?.ext;
  let storageSlug = cached?.storage_slug;
  if (!cached) {
    // Redis lookup 是加速层；缺失时回到 PostgreSQL 查元数据，并顺手回填 object/thumb 双向索引。
    const row = (await pool.query(
      "SELECT object_key, ext, storage_slug, status FROM metadata WHERE object_key=$1 LIMIT 1",
      [key]
    )).rows[0] as { ext: string; storage_slug: string; status: string } | undefined;

    if (!row || row.status !== "ready") throw new ApiError(404, "not_found", "Object not found");
    ext = row.ext;
    storageSlug = row.storage_slug;
    await setImageLookup({
      object_key: key,
      thumb_key: thumbnailObjectKey(key),
      ext,
      storage_slug: storageSlug,
      status: "ready"
    });
  }
  if (!ext || !storageSlug) throw new ApiError(404, "not_found", "Object not found");
  const publicUrl = await publicObjectUrl("media", key, storageSlug);
  if (publicUrl) return immutableRedirect(publicUrl);
  return streamStoredObject("media", key, storageSlug, contentType(ext), immutableCacheControl, request).catch((error: unknown) => {
    if (isStorageNotFoundError(error)) throw new ApiError(404, "not_found", "Object not found");
    throw error;
  });
}

export async function serveThumb(key: string, request: StoredResponseRequest = {}): Promise<Response> {
  const cached = await getImageLookupByThumbKey(key);
  if (cached) {
    const backend = cached.storage_slug;
    const publicUrl = await publicObjectUrl("thumbs", key, backend);
    if (publicUrl) return immutableRedirect(publicUrl);

    const streamed = await streamThumbEnsuring(cached.object_key, key, backend, immutableCacheControl, request);
    if (streamed) return streamed;

    return streamStoredObject("media", cached.object_key, backend, contentType(cached.ext), publicProxyFallbackThumbCacheControl, request);
  }
  const row = (await pool.query("SELECT object_key, ext, storage_slug, status FROM metadata WHERE object_key=$1 OR regexp_replace(object_key, '\\.[^/.]+$', '.webp')=$1 LIMIT 1", [key])).rows[0];

  if (!row || row.status !== "ready") throw new ApiError(404, "not_found", "Thumbnail not found");
  const objectKey = row.object_key;
  const thumbKey = thumbnailObjectKey(objectKey);
  const ext = row.ext;
  const backend = row.storage_slug;
  await setImageLookup({ object_key: objectKey, thumb_key: thumbKey, ext, storage_slug: backend, status: "ready" });
  const publicUrl = await publicObjectUrl("thumbs", thumbKey, backend);
  if (publicUrl) return immutableRedirect(publicUrl);
  const streamed = await streamThumbEnsuring(objectKey, thumbKey, backend, immutableCacheControl, request);
  if (streamed) return streamed;

  return streamStoredObject("media", objectKey, backend, contentType(ext), publicProxyFallbackThumbCacheControl, request);
}

function immutableRedirect(location: string) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": publicRedirectCacheControl } });
}

export async function serveLinkThumb(key: string, request: StoredResponseRequest = {}): Promise<Response> {
  const id = (key.split("/").pop() ?? key).replace(/\.[^/.]+$/, "");
  const row = await imageLookupById(id);
  if (!row || !row.is_link || row.status !== "ready") throw new ApiError(404, "not_found", "Thumbnail not found");
  const backend = row.storage_slug;
  const publicUrl = await publicObjectUrl("link", key, backend);
  if (publicUrl) return immutableRedirect(publicUrl);
  return streamStoredObject("link", key, backend, "image/webp", immutableCacheControl, request).catch((error: unknown) => {
    if (isStorageNotFoundError(error)) throw new ApiError(404, "not_found", "Thumbnail not found");
    throw error;
  });
}

export async function serveLinkMedia(key: string, isHead = false): Promise<Response> {
  const id = key.replace(/\.[^/.]+$/, "");
  const row = await imageLookupById(id);

  if (!row || !row.is_link || row.status !== "ready") throw new ApiError(404, "not_found", "Link image not found");

  return proxyExternalImage(
    row.object_key as string,
    (row.ext as string) || "jpg",
    isHead,
    { "Cache-Control": noStoreCacheControl },
    publicProxyImageCacheControl,
    () => linkThumbFallback(id, row, publicProxyFallbackThumbCacheControl)
  );
}

export async function redirectOriginalLink(id: string, userAgent: string) {
  const row = await imageLookupById(id);
  const original = String(row?.original ?? "");
  if (!row || row.status !== "ready") {
    throw new ApiError(404, "not_found", "Original link not found");
  }

  if (!/^https:\/\//i.test(original)) throw new ApiError(404, "not_found", "Original link not found");
  const displayUrl = await displayUrlForOriginalComparison(row);
  if (!hasDistinctOriginalUrl(original, displayUrl)) throw new ApiError(404, "not_found", "Original link not found");

  const direct = await cachedOriginalSupportsDirectAccess(original, userAgent);
  // 原图链接可无 Referer 直连时直接 302；否则跳到 link 子域代理，避免详情页按钮打开后被防盗链拦截。
  return new Response(null, {
    status: 302,
    headers: {
      Location: direct ? original : `${linkBaseUrl()}/original/${encodeURIComponent(id)}`,
      "Cache-Control": privateNoStoreCacheControl,
      "Referrer-Policy": "no-referrer"
    }
  });
}

export async function serveOriginalLinkProxy(id: string, isHead = false) {
  const row = await imageLookupById(id);
  const original = String(row?.original ?? "");
  if (!row || row.status !== "ready") {
    throw new ApiError(404, "not_found", "Original link not found");
  }

  if (!/^https:\/\//i.test(original)) throw new ApiError(404, "not_found", "Original link not found");
  const displayUrl = await displayUrlForOriginalComparison(row);
  if (!hasDistinctOriginalUrl(original, displayUrl)) throw new ApiError(404, "not_found", "Original link not found");

  return proxyExternalImage(
    original,
    externalImageExt(original),
    isHead,
    { "Cache-Control": noStoreCacheControl },
    publicProxyImageCacheControl
  );
}

export async function serveAdminThumb(id: string, request: StoredResponseRequest = {}): Promise<Response> {
  const row = await imageLookupById(id);
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  const backend = row.storage_slug;
  if (row.is_link) {
    const linkKey = linkThumbnailKey(row.device, row.brightness, row.theme, id);
    return streamStoredObject("link", linkKey, backend, "image/webp", privateNoStoreCacheControl, request);
  }
  const thumbKey = thumbnailObjectKey(row.object_key);
  const streamed = await streamThumbEnsuring(row.object_key, thumbKey, backend, privateNoStoreCacheControl, request);
  if (streamed) return streamed;
  throw new ApiError(404, "not_found", "Thumbnail not found");
}

export async function serveAdminObject(id: string, request: StoredResponseRequest = {}): Promise<Response> {
  const row = await imageLookupById(id);
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  if (row.is_link) return proxyExternalImage(row.object_key as string, (row.ext as string) || "jpg", Boolean(request.isHead), { "Cache-Control": privateNoStoreCacheControl }, undefined, () => linkThumbFallback(id, row, privateNoStoreCacheControl));
  const backend = row.storage_slug;
  return streamStoredObject("media", row.object_key, backend, contentType(row.ext), privateNoStoreCacheControl, request);
}

export async function serveAdminOriginalLink(id: string, userAgent: string): Promise<Response> {
  const row = await imageLookupById(id);
  const original = String(row?.original ?? "");
  if (!row || !/^https:\/\//i.test(original)) throw new ApiError(404, "not_found", "Original link not found");
  const displayUrl = await displayUrlForOriginalComparison(row);
  if (!hasDistinctOriginalUrl(original, displayUrl)) throw new ApiError(404, "not_found", "Original link not found");
  if (await cachedOriginalSupportsDirectAccess(original, userAgent)) {
    return new Response(null, {
      status: 302,
      headers: { Location: original, "Cache-Control": privateNoStoreCacheControl, "Referrer-Policy": "no-referrer" }
    });
  }
  return proxyExternalImage(original, externalImageExt(original), false, { "Cache-Control": privateNoStoreCacheControl });
}
