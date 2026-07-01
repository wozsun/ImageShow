import { pool } from "../core/db.js";
import { ApiError } from "../core/http.js";
import { makeThumb } from "./processing.js";
import { linkThumbnailKey, thumbnailObjectKey } from "../storage/image-paths.js";
import { contentType, exists, publicObjectUrl, readObject } from "../storage/storage.js";
import { getImageLookupByObjectKey, getImageLookupByThumbKey, setImageLookup } from "../core/redis.js";

const immutableCache = "public, max-age=31536000, immutable";

// Streams a stored thumbnail's bytes with the given cache policy. Used wherever a caller has
// already established there's no public URL to redirect to — directly, never by re-entering
// serveThumb, so a perpetually missing lookup cache (Redis down) can't drive it into unbounded
// self-recursion.
async function streamThumb(key: string, backend: string, cacheControl = immutableCache) {
  return new Response(await readObject("thumbs", key, backend) as unknown as BodyInit, {
    headers: { "Content-Type": "image/webp", "Cache-Control": cacheControl }
  });
}

// Regenerates a stored (non-link) thumbnail from its still-present original when the thumb is
// missing (e.g. after a category move re-keyed the object), then streams it. Returns null when no
// thumbnail can be produced — neither a thumb nor a source object exists — so the caller picks the
// fallback (serve the original, or 404). Shared by serveThumb (cached + DB-miss paths) and the
// authenticated serveAdminThumb.
async function streamThumbEnsuring(objectKey: string, thumbKey: string, backend: string, cacheControl = immutableCache): Promise<Response | null> {
  if (!(await exists("thumbs", thumbKey, backend)) && await exists("objects", objectKey, backend)) {
    await makeThumb(objectKey, backend).catch(() => undefined);
  }
  if (await exists("thumbs", thumbKey, backend)) return streamThumb(thumbKey, backend, cacheControl);
  return null;
}

// Only reached on the static object host (or same-origin in dev without one), so
// objects are served inline; S3-with-public-URL images 302 to their public URL.
export async function serveObject(key: string) {
  // Resolve the image's backend first (lookup cache → DB → default) so reads and
  // public-URL redirects target the storage this specific image lives in.
  const cached = await getImageLookupByObjectKey(key);
  let ext = cached?.ext ?? "";
  let slug = cached?.slug;
  if (!ext || !slug) {
    const row = (await pool.query("SELECT object_key, ext, storage_slug, status FROM metadata WHERE object_key=$1 LIMIT 1", [key])).rows[0];
    // A deleted image's original stays in objects/ until purge, but the public host must not
    // serve it (recycle-bin access is admin-only — see serveAdminObject). 404 before caching so
    // the ready-only lookup cache is never poisoned with a deleted entry.
    if (row && row.status !== "ready") throw new ApiError(404, "not_found", "Object not found");
    ext = ext || row?.ext || key.split(".").pop() || "";
    slug = slug ?? row?.storage_slug;
    if (row) await setImageLookup({ object_key: key, thumb_key: thumbnailObjectKey(key), ext, slug: row.storage_slug });
  }
  const resolved = slug ?? "local";
  const publicUrl = await publicObjectUrl("objects", key, resolved);
  if (publicUrl) return immutableRedirect(publicUrl);
  if (!(await exists("objects", key, resolved))) throw new ApiError(404, "not_found", "Object not found");
  return new Response(await readObject("objects", key, resolved) as unknown as BodyInit, { headers: { "Content-Type": contentType(ext), "Cache-Control": immutableCache } });
}

export async function serveThumb(key: string): Promise<Response> {
  const cached = await getImageLookupByThumbKey(key);
  if (cached) {
    const backend = cached.slug ?? "local";
    const publicUrl = await publicObjectUrl("thumbs", key, backend);
    if (publicUrl) return immutableRedirect(publicUrl);
    // cached.thumb_key === key (the thumbs lookup is keyed by thumb_key).
    const streamed = await streamThumbEnsuring(cached.object_key, key, backend);
    if (streamed) return streamed;
    // No thumbnail available; fall back to the original bytes (404 if it's gone too).
    if (!(await exists("objects", cached.object_key, backend))) throw new ApiError(404, "not_found", "Object not found");
    return new Response(await readObject("objects", cached.object_key, backend) as unknown as BodyInit, { headers: { "Content-Type": contentType(cached.ext), "Cache-Control": immutableCache } });
  }
  const row = (await pool.query("SELECT object_key, ext, storage_slug, status FROM metadata WHERE object_key=$1 OR regexp_replace(object_key, '\\.[^/.]+$', '.webp')=$1 LIMIT 1", [key])).rows[0];
  // A deleted image keeps its thumbnail until purge; the public host must not serve it (admin-only
  // via serveAdminThumb). 404 before caching/regenerating so the ready-only cache stays clean.
  if (row && row.status !== "ready") throw new ApiError(404, "not_found", "Thumbnail not found");
  const objectKey = row?.object_key ?? key;
  const thumbKey = thumbnailObjectKey(objectKey);
  const ext = row?.ext ?? "";
  const backend = row?.storage_slug ?? "local";
  if (row) await setImageLookup({ object_key: objectKey, thumb_key: thumbKey, ext, slug: backend });
  const publicUrl = await publicObjectUrl("thumbs", thumbKey, backend);
  if (publicUrl) return immutableRedirect(publicUrl);
  if (!(await exists("objects", objectKey, backend))) throw new ApiError(404, "not_found", "Object not found");
  const streamed = await streamThumbEnsuring(objectKey, thumbKey, backend);
  if (streamed) return streamed;
  // Thumbnail couldn't be produced; fall back to the original bytes (needs a known ext).
  if (!ext) throw new ApiError(404, "not_found", "Thumbnail not found");
  return new Response(await readObject("objects", objectKey, backend) as unknown as BodyInit, { headers: { "Content-Type": contentType(ext), "Cache-Control": immutableCache } });
}

function immutableRedirect(location: string) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": immutableCache } });
}

// --- link.<domain> handlers: stored thumbnail (/thumbs) + proxied original (/media) ---

// Server-side fetch budget + identity for proxying a link image's external original. A real
// browser UA plus the image host's own origin as Referer passes the hotlink checks that block
// foreign-Referer requests (e.g. Sina/Weibo); the timeout keeps a slow host from hanging us.
const linkProxyTimeoutMs = 12_000;
const linkProxyUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// Proxies an external image URL through this server: the browser loads it from our own origin
// while the server does the cross-origin fetch presenting the image host's own origin as the
// Referer (which the browser itself can't forge) to slip past hotlink protection. HEAD answers
// from the declared ext without an upstream call; any non-OK / failed / slow fetch degrades to a
// 302 to the URL. Shared by the random API's proxy mode and the link.<domain>/media route.
export async function proxyExternalImage(externalUrl: string, ext: string, isHead: boolean, baseHeaders: Record<string, string> = {}): Promise<Response> {
  const redirectFallback = () => new Response(null, {
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
  const timeout = setTimeout(() => controller.abort(), linkProxyTimeoutMs);
  try {
    const upstream = await fetch(externalUrl, {
      headers: { Referer: origin, "User-Agent": linkProxyUserAgent, Accept: "image/*,*/*" },
      redirect: "follow",
      signal: controller.signal
    });
    if (!upstream.ok || !upstream.body) return redirectFallback();
    return new Response(upstream.body, {
      headers: { ...baseHeaders, "Content-Type": upstream.headers.get("content-type") || contentType(ext) }
    });
  } catch {
    return redirectFallback();
  } finally {
    clearTimeout(timeout);
  }
}

// Serves a link image's stored thumbnail from the "link" prefix. The URL key is the
// foldered name <device>-<brightness>/<theme>/<id>.webp; the id (last path segment) resolves
// the row (for the status gate) and the backend. Then serves local-first (most link thumbnails
// are local), else the image's actual backend (S3 public URL → 302, otherwise stream the bytes).
export async function serveLinkThumb(key: string): Promise<Response> {
  // Resolve the row up front (not just on the non-local fast path) so a deleted link image's
  // thumbnail — which survives in link/ until purge — is refused on the public host even when
  // it sits locally. Recycle-bin access is admin-only (serveAdminThumb).
  const id = (key.split("/").pop() ?? key).replace(/\.[^/.]+$/, "");
  const row = (await pool.query("SELECT storage_slug, status FROM metadata WHERE id=$1 AND is_link=true LIMIT 1", [id])).rows[0];
  if (row && row.status !== "ready") throw new ApiError(404, "not_found", "Thumbnail not found");
  if (await exists("link", key, "local")) {
    return new Response(await readObject("link", key, "local") as unknown as BodyInit, { headers: { "Content-Type": "image/webp", "Cache-Control": immutableCache } });
  }
  const backend = row?.storage_slug ?? "local";
  const publicUrl = await publicObjectUrl("link", key, backend);
  if (publicUrl) return immutableRedirect(publicUrl);
  if (await exists("link", key, backend)) {
    return new Response(await readObject("link", key, backend) as unknown as BodyInit, { headers: { "Content-Type": "image/webp", "Cache-Control": immutableCache } });
  }
  throw new ApiError(404, "not_found", "Thumbnail not found");
}

// Serves a link image's original by proxying its external URL. The URL key is <id>.<ext>;
// the id resolves the stored external URL, which proxyExternalImage then streams back. No-store
// (the bytes are someone else's CDN), so this never caches a foreign original.
export async function serveLinkMedia(key: string): Promise<Response> {
  const id = key.replace(/\.[^/.]+$/, "");
  const row = (await pool.query("SELECT object_key, ext, status FROM metadata WHERE id=$1 AND is_link=true LIMIT 1", [id])).rows[0];
  // Missing or recycle-bin (deleted) link images are not served publicly; the admin proxies a
  // deleted link's original through serveAdminObject instead.
  if (!row || row.status !== "ready") throw new ApiError(404, "not_found", "Link image not found");
  return proxyExternalImage(row.object_key as string, (row.ext as string) || "jpg", false, { "Cache-Control": "no-store" });
}

// --- Authenticated admin byte serving (main host, behind requireAuth) ---

// Streams an image's thumbnail / original through the server by id, regardless of status, so the
// recycle-bin (deleted) admin view can show images that the public static/link hosts now refuse.
// Always streams the bytes (never a public-URL 302) and marks them private/no-store, so a deleted
// image's URL is never handed to a cache or an unauthenticated client.
const privateCache = "private, no-store";

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
    return new Response(await readObject("link", linkKey, backend) as unknown as BodyInit, { headers: { "Content-Type": "image/webp", "Cache-Control": privateCache } });
  }
  const thumbKey = thumbnailObjectKey(row.object_key);
  // Regenerate a missing thumbnail from the still-present original (e.g. after a move) and stream
  // it privately; 404 if this trash entry has neither a thumbnail nor a source object to rebuild.
  const streamed = await streamThumbEnsuring(row.object_key, thumbKey, backend, privateCache);
  if (streamed) return streamed;
  throw new ApiError(404, "not_found", "Thumbnail not found");
}

export async function serveAdminObject(id: string): Promise<Response> {
  const row = (await pool.query("SELECT object_key, ext, storage_slug, is_link FROM metadata WHERE id=$1 LIMIT 1", [id])).rows[0];
  if (!row) throw new ApiError(404, "not_found", "Image not found");
  // A link image's "original" is an external URL — proxy it (beating hotlink protection), like the
  // public link.<domain>/media route, but private/no-store since this is the admin view.
  if (row.is_link) return proxyExternalImage(row.object_key as string, (row.ext as string) || "jpg", false, { "Cache-Control": privateCache });
  const backend = row.storage_slug ?? "local";
  if (!(await exists("objects", row.object_key, backend))) throw new ApiError(404, "not_found", "Object not found");
  return new Response(await readObject("objects", row.object_key, backend) as unknown as BodyInit, { headers: { "Content-Type": contentType(row.ext), "Cache-Control": privateCache } });
}
