import { pool } from "../core/db.js";
import { ApiError, immutableCacheControl, noStoreCacheControl, privateNoStoreCacheControl, publicProxyFallbackThumbCacheControl, publicProxyImageCacheControl } from "../core/http.js";
import { makeThumb } from "./processing.js";
import { linkThumbnailKey, thumbnailObjectKey } from "../storage/image-paths.js";
import { contentType, exists, publicObjectUrl, readObject } from "../storage/storage.js";
import { getImageLookupByObjectKey, getImageLookupByThumbKey, setImageLookup } from "./image-cache.js";
import { linkBaseUrl } from "../themes/host.js";
import { displayUrlForOriginalComparison, hasDistinctOriginalUrl } from "./original-link.js";

const proxyTimeoutMs = 12_000;
const proxyUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

type ProxyFallback = () => Response | Promise<Response>;

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
    return redirectFallback();
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), proxyTimeoutMs);
  try {
    // 外链代理带源站同源 Referer 绕过简单防盗链；取流失败时走调用方 fallback，默认退回 302。
    const upstream = await fetch(externalUrl, {
      headers: { Referer: origin, "User-Agent": proxyUserAgent, Accept: "image/*,*/*" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!upstream.ok || !upstream.body) return redirectFallback();

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
  } catch {
    return redirectFallback();
  } finally {
    clearTimeout(timeout);
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), proxyTimeoutMs);
  try {
    // 用 Range 只探测第一个字节，确认“无 Referer 直连是否可达”，避免为了探测下载整张原图。
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": userAgent || proxyUserAgent, Accept: "image/*,*/*", Range: "bytes=0-0" },
      redirect: "follow",
      signal: controller.signal
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function streamThumb(key: string, backend: string, cacheControl = immutableCacheControl) {
  return new Response(await readObject("thumbs", key, backend) as unknown as BodyInit, {
    headers: { "Content-Type": "image/webp", "Cache-Control": cacheControl }
  });
}

async function streamThumbEnsuring(objectKey: string, thumbKey: string, backend: string, cacheControl = immutableCacheControl): Promise<Response | null> {
  // 缩略图缺失但原图仍在时即时补建，修复历史数据或迁移中断造成的缩略图空洞。
  if (!(await exists("thumbs", thumbKey, backend)) && await exists("media", objectKey, backend)) {
    await makeThumb(objectKey, backend).catch(() => undefined);
  }
  if (await exists("thumbs", thumbKey, backend)) return streamThumb(thumbKey, backend, cacheControl);
  return null;
}

async function linkThumbFallback(id: string, row: { storage_slug?: string; device: string; brightness: string; theme: string }, cacheControl: string) {
  const backend = row.storage_slug ?? "local";
  const key = linkThumbnailKey(row.device, row.brightness, row.theme, id);
  if (!(await exists("link", key, backend))) throw new ApiError(404, "not_found", "Link thumbnail not found");
  return new Response(await readObject("link", key, backend) as unknown as BodyInit, {
    headers: { "Content-Type": "image/webp", "Cache-Control": cacheControl }
  });
}

export async function serveObject(key: string) {
  const cached = await getImageLookupByObjectKey(key);
  let ext = cached?.ext ?? "";
  let slug = cached?.slug;
  if (!ext || !slug) {
    // Redis lookup 是加速层；缺失时回到 PostgreSQL 查元数据，并顺手回填 object/thumb 双向索引。
    const row = (await pool.query("SELECT object_key, ext, storage_slug, status FROM metadata WHERE object_key=$1 LIMIT 1", [key])).rows[0];

    if (row && row.status !== "ready") throw new ApiError(404, "not_found", "Object not found");
    ext = ext || row?.ext || key.split(".").pop() || "";
    slug = slug ?? row?.storage_slug;
    if (row) await setImageLookup({ object_key: key, thumb_key: thumbnailObjectKey(key), ext, slug: row.storage_slug });
  }
  const resolved = slug ?? "local";
  const publicUrl = await publicObjectUrl("media", key, resolved);
  if (publicUrl) return immutableRedirect(publicUrl);
  if (!(await exists("media", key, resolved))) throw new ApiError(404, "not_found", "Object not found");
  return new Response(await readObject("media", key, resolved) as unknown as BodyInit, { headers: { "Content-Type": contentType(ext), "Cache-Control": immutableCacheControl } });
}

export async function serveThumb(key: string): Promise<Response> {
  const cached = await getImageLookupByThumbKey(key);
  if (cached) {
    const backend = cached.slug ?? "local";
    const publicUrl = await publicObjectUrl("thumbs", key, backend);
    if (publicUrl) return immutableRedirect(publicUrl);

    const streamed = await streamThumbEnsuring(cached.object_key, key, backend);
    if (streamed) return streamed;

    if (!(await exists("media", cached.object_key, backend))) throw new ApiError(404, "not_found", "Object not found");
    return new Response(await readObject("media", cached.object_key, backend) as unknown as BodyInit, { headers: { "Content-Type": contentType(cached.ext), "Cache-Control": immutableCacheControl } });
  }
  const row = (await pool.query("SELECT object_key, ext, storage_slug, status FROM metadata WHERE object_key=$1 OR regexp_replace(object_key, '\\.[^/.]+$', '.webp')=$1 LIMIT 1", [key])).rows[0];

  if (row && row.status !== "ready") throw new ApiError(404, "not_found", "Thumbnail not found");
  const objectKey = row?.object_key ?? key;
  const thumbKey = thumbnailObjectKey(objectKey);
  const ext = row?.ext ?? "";
  const backend = row?.storage_slug ?? "local";
  if (row) await setImageLookup({ object_key: objectKey, thumb_key: thumbKey, ext, slug: backend });
  const publicUrl = await publicObjectUrl("thumbs", thumbKey, backend);
  if (publicUrl) return immutableRedirect(publicUrl);
  if (!(await exists("media", objectKey, backend))) throw new ApiError(404, "not_found", "Object not found");
  const streamed = await streamThumbEnsuring(objectKey, thumbKey, backend);
  if (streamed) return streamed;

  if (!ext) throw new ApiError(404, "not_found", "Thumbnail not found");
  return new Response(await readObject("media", objectKey, backend) as unknown as BodyInit, { headers: { "Content-Type": contentType(ext), "Cache-Control": immutableCacheControl } });
}

function immutableRedirect(location: string) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": immutableCacheControl } });
}

export async function serveLinkThumb(key: string): Promise<Response> {
  const id = (key.split("/").pop() ?? key).replace(/\.[^/.]+$/, "");
  const row = (await pool.query("SELECT storage_slug, status FROM metadata WHERE id=$1 AND is_link=true LIMIT 1", [id])).rows[0];
  if (row && row.status !== "ready") throw new ApiError(404, "not_found", "Thumbnail not found");
  if (await exists("link", key, "local")) {
    return new Response(await readObject("link", key, "local") as unknown as BodyInit, { headers: { "Content-Type": "image/webp", "Cache-Control": immutableCacheControl } });
  }
  const backend = row?.storage_slug ?? "local";
  const publicUrl = await publicObjectUrl("link", key, backend);
  if (publicUrl) return immutableRedirect(publicUrl);
  if (await exists("link", key, backend)) {
    return new Response(await readObject("link", key, backend) as unknown as BodyInit, { headers: { "Content-Type": "image/webp", "Cache-Control": immutableCacheControl } });
  }
  throw new ApiError(404, "not_found", "Thumbnail not found");
}

export async function serveLinkMedia(key: string): Promise<Response> {
  const id = key.replace(/\.[^/.]+$/, "");
  const row = (await pool.query(
    "SELECT object_key, ext, status, storage_slug, device, brightness, theme FROM metadata WHERE id=$1 AND is_link=true LIMIT 1",
    [id]
  )).rows[0];

  if (!row || row.status !== "ready") throw new ApiError(404, "not_found", "Link image not found");

  return proxyExternalImage(
    row.object_key as string,
    (row.ext as string) || "jpg",
    false,
    { "Cache-Control": noStoreCacheControl },
    publicProxyImageCacheControl,
    () => linkThumbFallback(id, row, publicProxyFallbackThumbCacheControl)
  );
}

export async function redirectOriginalLink(id: string, userAgent: string) {
  const row = (await pool.query(
    "SELECT original, object_key, storage_slug, status, is_link FROM metadata WHERE id=$1 LIMIT 1",
    [id]
  )).rows[0];
  const original = String(row?.original ?? "");
  if (!row || row.status !== "ready") {
    throw new ApiError(404, "not_found", "Original link not found");
  }

  if (!/^https?:\/\//i.test(original)) throw new ApiError(404, "not_found", "Original link not found");
  const displayUrl = await displayUrlForOriginalComparison(row);
  if (!hasDistinctOriginalUrl(original, displayUrl)) throw new ApiError(404, "not_found", "Original link not found");

  const direct = await originalSupportsDirectAccess(original, userAgent);
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

export async function serveOriginalLinkProxy(id: string) {
  const row = (await pool.query(
    "SELECT original, object_key, storage_slug, status, is_link FROM metadata WHERE id=$1 LIMIT 1",
    [id]
  )).rows[0];
  const original = String(row?.original ?? "");
  if (!row || row.status !== "ready") {
    throw new ApiError(404, "not_found", "Original link not found");
  }

  if (!/^https?:\/\//i.test(original)) throw new ApiError(404, "not_found", "Original link not found");
  const displayUrl = await displayUrlForOriginalComparison(row);
  if (!hasDistinctOriginalUrl(original, displayUrl)) throw new ApiError(404, "not_found", "Original link not found");

  return proxyExternalImage(
    original,
    externalImageExt(original),
    false,
    { "Cache-Control": noStoreCacheControl },
    publicProxyImageCacheControl
  );
}

export async function serveAdminThumb(id: string): Promise<Response> {
  const row = (await pool.query(
    "SELECT object_key, storage_slug, is_link, device, brightness, theme FROM metadata WHERE id=$1 LIMIT 1",
    [id]
  )).rows[0];
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  const backend = row.storage_slug ?? "local";
  if (row.is_link) {
    const linkKey = linkThumbnailKey(row.device, row.brightness, row.theme, id);
    if (!(await exists("link", linkKey, backend))) throw new ApiError(404, "not_found", "Thumbnail not found");
    return new Response(await readObject("link", linkKey, backend) as unknown as BodyInit, { headers: { "Content-Type": "image/webp", "Cache-Control": privateNoStoreCacheControl } });
  }
  const thumbKey = thumbnailObjectKey(row.object_key);
  const streamed = await streamThumbEnsuring(row.object_key, thumbKey, backend, privateNoStoreCacheControl);
  if (streamed) return streamed;
  throw new ApiError(404, "not_found", "Thumbnail not found");
}

export async function serveAdminObject(id: string): Promise<Response> {
  const row = (await pool.query("SELECT object_key, ext, storage_slug, is_link, device, brightness, theme FROM metadata WHERE id=$1 LIMIT 1", [id])).rows[0];
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  if (row.is_link) return proxyExternalImage(row.object_key as string, (row.ext as string) || "jpg", false, { "Cache-Control": privateNoStoreCacheControl }, undefined, () => linkThumbFallback(id, row, privateNoStoreCacheControl));
  const backend = row.storage_slug ?? "local";
  if (!(await exists("media", row.object_key, backend))) throw new ApiError(404, "not_found", "Object not found");
  return new Response(await readObject("media", row.object_key, backend) as unknown as BodyInit, { headers: { "Content-Type": contentType(row.ext), "Cache-Control": privateNoStoreCacheControl } });
}

export async function serveAdminOriginalLink(id: string, userAgent: string): Promise<Response> {
  const row = (await pool.query("SELECT original, object_key, storage_slug, is_link FROM metadata WHERE id=$1 LIMIT 1", [id])).rows[0];
  const original = String(row?.original ?? "");
  if (!row || !/^https?:\/\//i.test(original)) throw new ApiError(404, "not_found", "Original link not found");
  const displayUrl = await displayUrlForOriginalComparison(row);
  if (!hasDistinctOriginalUrl(original, displayUrl)) throw new ApiError(404, "not_found", "Original link not found");
  if (await originalSupportsDirectAccess(original, userAgent)) {
    return new Response(null, {
      status: 302,
      headers: { Location: original, "Cache-Control": privateNoStoreCacheControl, "Referrer-Policy": "no-referrer" }
    });
  }
  return proxyExternalImage(original, externalImageExt(original), false, { "Cache-Control": privateNoStoreCacheControl });
}
