import type { Hono } from "hono";
import { pool } from "../core/db.js";
import { ApiError, ok } from "../core/http.js";
import { cacheImageLookups, publicImages, publicImagesCacheKey, type ImageRecord, type PublicImage } from "../images/presenter.js";
import { decodeImageCursor, encodeImageCursor } from "../images/cursor.js";
import { getGalleryOptions, getImageLookupByObjectKey, getImageLookupByThumbKey, getPublicImagesCache, setImageLookup, setPublicImagesCache } from "../core/redis.js";
import { listQuery, parse } from "../core/validation.js";
import { contentType, makeThumb } from "../images/processing.js";
import { thumbnailObjectKey } from "../storage/image-paths.js";
import { exists, publicObjectUrl, readObject } from "../storage/storage.js";
import { getRuntimeConfig } from "../config/env.js";
import type { StorageBackend } from "../config/settings.js";

const immutableCache = "public, max-age=31536000, immutable";

export function registerPublicRoutes(app: Hono) {
  app.get("/api/images", async (c) => {
    const q = parse(listQuery, Object.fromEntries(new URL(c.req.url).searchParams));
    const limit = q.limit ?? getRuntimeConfig().gallery.default_limit;
    const cacheKey = publicImagesCacheKey({ ...q, limit });
    const cached = await getPublicImagesCache<{ items: PublicImage[]; limit: number; has_next: boolean; next_cursor: string | null; total: null }>(cacheKey);
    if (cached) return c.json(ok(cached));
    const params: unknown[] = [q.status];
    const where = ["status = $1", "device <> 'none'", "brightness <> 'none'"];
    if (q.d) { params.push(q.d); where.push(`device = $${params.length}`); }
    if (q.b) { params.push(q.b); where.push(`brightness = $${params.length}`); }
    if (q.t) {
      const selectors = [...new Set(q.t.split(",").map((value) => value.trim()).filter(Boolean))];
      const exclude = selectors.length > 0 && selectors.every((value) => value.startsWith("!"));
      const include = selectors.length > 0 && selectors.every((value) => !value.startsWith("!"));
      if (!exclude && !include) throw new ApiError(400, "validation_error", "Cannot mix include and exclude theme selectors");
      params.push(selectors.map((value) => value.replace(/^!/, "")));
      where.push(exclude ? `NOT (theme = ANY($${params.length}::text[]))` : `theme = ANY($${params.length}::text[])`);
    }
    // Keyset pagination over (created_at, id): stable under inserts and avoids the
    // growing OFFSET scan when users deep-scroll the gallery.
    if (q.cursor) {
      const cursor = decodeImageCursor(q.cursor);
      params.push(cursor.createdAt, cursor.id);
      where.push(`(created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
    }
    params.push(limit + 1);
    const result = await pool.query(
      `SELECT *, created_at::text AS cursor_created_at FROM metadata WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params
    );
    const visibleRows = result.rows.slice(0, limit) as Array<ImageRecord & { id: string; cursor_created_at: string }>;
    const hasNext = result.rows.length > limit;
    const last = visibleRows.at(-1);
    const items = await publicImages(visibleRows);
    await cacheImageLookups(items);
    const payload = { items, limit, has_next: hasNext, next_cursor: hasNext && last ? encodeImageCursor(last) : null, total: null };
    await setPublicImagesCache(cacheKey, payload);
    return c.json(ok(payload));
  });

  app.get("/api/site-config", async (c) => {
    const runtime = getRuntimeConfig();
    // Only the fields the frontend needs; static_base_url and the reserved
    // subdomain labels stay server-side.
    const { name, domain, icon_url, root_redirect } = runtime.site;
    return c.json(ok({
      site: { name, domain, icon_url, root_redirect },
      home: runtime.home,
      upload: { max_file_size_mb: runtime.upload.max_file_size_mb, max_long_edge: runtime.upload.max_long_edge },
      image_detail: runtime.image_detail
    }));
  });

  app.get("/api/gallery-options", async (c) => {
    return c.json(ok(await getGalleryOptions()));
  });

  app.get("/media/*", async (c) => serveObject(c.req.path.replace(/^\/media\//, "")));
  app.get("/thumbs/*", async (c) => serveThumb(c.req.path.replace(/^\/thumbs\//, "")));
}

// Only reached on the static object host (or same-origin in dev without one), so
// objects are served inline; S3-with-public-URL images 302 to their public URL.
async function serveObject(key: string) {
  // Resolve the image's backend first (lookup cache → DB → default) so reads and
  // public-URL redirects target the storage this specific image lives in.
  const cached = await getImageLookupByObjectKey(key);
  let ext = cached?.ext ?? "";
  let backend = cached?.backend;
  if (!ext || !backend) {
    const row = (await pool.query("SELECT object_key, ext, storage_backend FROM metadata WHERE object_key=$1 LIMIT 1", [key])).rows[0];
    ext = ext || row?.ext || key.split(".").pop() || "";
    backend = backend ?? row?.storage_backend;
    if (row) await setImageLookup({ object_key: key, thumb_key: thumbnailObjectKey(key), ext, backend: row.storage_backend });
  }
  const resolved: StorageBackend = backend ?? "local";
  const publicUrl = await publicObjectUrl("objects", key, resolved);
  if (publicUrl) return immutableRedirect(publicUrl);
  if (!(await exists("objects", key, resolved))) throw new ApiError(404, "not_found", "Object not found");
  return new Response(await readObject("objects", key, resolved) as unknown as BodyInit, { headers: { "Content-Type": contentType(ext), "Cache-Control": immutableCache } });
}

async function serveThumb(key: string): Promise<Response> {
  const cached = await getImageLookupByThumbKey(key);
  if (cached) {
    const backend: StorageBackend = cached.backend ?? "local";
    const publicUrl = await publicObjectUrl("thumbs", key, backend);
    if (publicUrl) return immutableRedirect(publicUrl);
    if (await exists("thumbs", key, backend)) {
      return new Response(await readObject("thumbs", key, backend) as unknown as BodyInit, { headers: { "Content-Type": "image/webp", "Cache-Control": immutableCache } });
    }
    if (!(await exists("objects", cached.object_key, backend))) throw new ApiError(404, "not_found", "Object not found");
    await makeThumb(cached.object_key, backend).catch(() => undefined);
    if (await exists("thumbs", cached.thumb_key, backend)) return serveThumb(cached.thumb_key);
    return new Response(await readObject("objects", cached.object_key, backend) as unknown as BodyInit, { headers: { "Content-Type": contentType(cached.ext), "Cache-Control": immutableCache } });
  }
  const row = (await pool.query("SELECT object_key, ext, storage_backend FROM metadata WHERE object_key=$1 OR regexp_replace(object_key, '\\.[^/.]+$', '.webp')=$1 LIMIT 1", [key])).rows[0];
  const objectKey = row?.object_key ?? key;
  const thumbKey = thumbnailObjectKey(objectKey);
  const ext = row?.ext ?? "";
  const backend: StorageBackend = row?.storage_backend ?? "local";
  if (row) await setImageLookup({ object_key: objectKey, thumb_key: thumbKey, ext, backend });
  const publicUrl = await publicObjectUrl("thumbs", thumbKey, backend);
  if (publicUrl) return immutableRedirect(publicUrl);
  if (!(await exists("objects", objectKey, backend))) throw new ApiError(404, "not_found", "Object not found");
  if (!(await exists("thumbs", thumbKey, backend))) await makeThumb(objectKey, backend).catch(() => undefined);
  if (await exists("thumbs", thumbKey, backend)) return serveThumb(thumbKey);
  if (!ext) throw new ApiError(404, "not_found", "Thumbnail not found");
  return new Response(await readObject("objects", objectKey, backend) as unknown as BodyInit, { headers: { "Content-Type": contentType(ext), "Cache-Control": immutableCache } });
}

function immutableRedirect(location: string) {
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": immutableCache } });
}
