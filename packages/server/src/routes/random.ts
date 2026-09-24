import { storageObjectKey } from "@imageshow/shared/browser";
import type { Context, Hono } from "hono";
import type { RandomImageJsonResponseDto } from "@imageshow/shared/browser";
import { withPublicDatabaseRead } from "../core/database/public-fallback.ts";
import {
  noStoreCacheControl,
  responseContentLengthValue,
  safeResponseHeaderValue,
  safeRedirectLocation
} from "../core/http/headers.ts";
import { requestClientIp, requestHasTrustedReferer } from "../core/http/request-security.ts";
import { ApiError } from "../core/api-error.ts";
import { reserveRandomRequest } from "../random/rate-limit.ts";
import { apiErrorResponse, apiSuccess } from "../core/http/responses.ts";
import { presentRandomJsonItems } from "../random/json-presentation.ts";
import { selectRandomImages } from "../random/selection.ts";
import { resolveReadableObject } from "../storage/objects/access.ts";
import { contentType } from "../storage/objects/keys.ts";
import {
  assertCanonicalImageObjectKey,
  thumbnailObjectKey
} from "../storage/objects/image-paths.ts";
import { publicImageUrlsForConfig } from "../storage/objects/public-urls.ts";
import { getStorageBackend } from "../storage/backends/registry.ts";
import { webReadableFromNode } from "../storage/objects/stream-buffer.ts";

export function registerRandomRoutes(app: Hono) {
  app.all("/random", handleRandomImage);
}

async function handleRandomImage(c: Context) {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return apiErrorResponse({ status: 405, message: "Method Not Allowed" });
  }
  const url = new URL(c.req.url);
  c.req.raw.signal.throwIfAborted();
  if (!requestHasTrustedReferer(c)) {
    const reservation = await reserveRandomRequest(
      requestClientIp(c),
      url.searchParams.has("limit")
    );
    if (!reservation.allowed) {
      c.header("Retry-After", String(reservation.retryAfterSeconds));
      throw new ApiError(429, "random_rate_limited", "随机图请求过于频繁，请稍后再试");
    }
  }
  return respondRandom(c, url);
}

async function respondRandom(c: Context, url: URL) {
  const signal = c.req.raw.signal;
  const selection = await withPublicDatabaseRead(signal, (database, databaseSignal) =>
    selectRandomImages(
      url,
      c.req.header("user-agent") ?? "",
      requestClientIp(c),
      databaseSignal,
      database
    )
  );
  if (selection instanceof Response) return selection;
  if (selection.mode === "json") {
    const items = await presentRandomJsonItems(selection.items, { signal, size: selection.size });
    const body = JSON.stringify(
      apiSuccess({
        count: items.length,
        items
      } satisfies RandomImageJsonResponseDto)
    );
    const headers = new Headers({
      "Cache-Control": noStoreCacheControl,
      "Content-Type": "application/json; charset=utf-8"
    });
    const contentLength = responseContentLengthValue(Buffer.byteLength(body));
    if (contentLength !== undefined) {
      headers.set("Content-Length", contentLength);
    }
    return new Response(c.req.method === "HEAD" ? null : body, { headers });
  }

  const picked = selection.items[0];
  if (!picked) {
    return apiErrorResponse({
      status: 404,
      message: "Not Found: No available images"
    });
  }
  const imageInfo = `${picked.device}-${picked.brightness}-${picked.theme ?? ""}-${picked.id}`;
  const baseHeaders = {
    "Cache-Control": noStoreCacheControl,
    "X-Image-Info": safeResponseHeaderValue("X-Image-Info", imageInfo)
  };
  const thumbnail = selection.size === "thumb";
  if (selection.mode === "proxy") {
    const key = thumbnail ? thumbnailObjectKey(picked.id) : storageObjectKey(picked.id, picked.ext);
    assertCanonicalImageObjectKey(key);
    const opened = await (
      await resolveReadableObject(thumbnail ? "thumbs" : "full", key, picked.storage_slug, {
        signal
      })
    ).open(undefined, {
      signal
    });
    // 候选集合变化时固定 seed 也可能换图，后续 Range 请求不保证命中同一对象。
    const headers = new Headers({
      ...baseHeaders,
      "Content-Type": contentType(thumbnail ? "webp" : picked.ext)
    });
    const contentLength = responseContentLengthValue(opened.size);
    if (contentLength !== undefined) {
      headers.set("Content-Length", contentLength);
    }
    if (c.req.method === "HEAD") opened.body.destroy();
    return new Response(c.req.method === "HEAD" ? null : webReadableFromNode(opened.body), {
      headers
    });
  }

  const config = await getStorageBackend(picked.storage_slug, { signal });
  const urls = publicImageUrlsForConfig(picked, config);
  const location = thumbnail ? urls.thumb_url : urls.object_url;
  return new Response(null, {
    status: 302,
    headers: {
      ...baseHeaders,
      Location: safeRedirectLocation(location),
      "Referrer-Policy": "no-referrer"
    }
  });
}
