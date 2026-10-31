import type { Context, Hono, Next } from "hono";
import {
  analyticsDirectHost,
  analyticsHostPattern,
  analyticsOtherHost,
  randomApiOptionOther,
  randomApiOptionUsed,
  randomImageSizes,
  randomMethods,
  type RandomApiStatusClass,
  type RandomImageJsonResponseDto
} from "@imageshow/shared/browser";
import { countRandomApiCall, type RandomApiOption } from "../analytics/random-api-counts.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { withPublicDatabaseRead } from "../core/database/public-fallback.ts";
import {
  noStoreCacheControl,
  responseContentLengthValue,
  safeRedirectLocation
} from "../core/http/headers.ts";
import { requestClientIp, requestHasTrustedReferer, requestIsSecure } from "../core/http/request-security.ts";
import { ApiError } from "../core/api-error.ts";
import { reserveRandomRequest } from "../random/rate-limit.ts";
import { apiErrorResponse, apiSuccess } from "../core/http/responses.ts";
import { presentRandomJsonItems } from "../random/json-presentation.ts";
import {
  randomBrightnesses,
  randomRequestDeviceValues,
  requestedRandomImageCount
} from "../random/query.ts";
import { selectRandomImages } from "../random/selection.ts";
import { resolveReadableObject } from "../storage/objects/access.ts";
import { imageObjectKey } from "../storage/objects/image-paths.ts";
import { publicImageUrlForConfig } from "../storage/objects/public-urls.ts";
import { getStorageBackend } from "../storage/backends/registry.ts";
import { webReadableFromNode } from "../storage/objects/stream-buffer.ts";

export function registerRandomRoutes(app: Hono) {
  app.all("/random", countRandomRequest, handleRandomImage);
}

function randomStatusClass(status: number): RandomApiStatusClass {
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return status >= 400 ? "client_error" : "success";
}

// Referers are client-controlled; a host statistics cannot key merges into "*".
function refererHost(value: string | undefined) {
  if (!value) return analyticsDirectHost;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    return analyticsOtherHost;
  }
  return analyticsHostPattern.test(host) ? host : analyticsOtherHost;
}

// Parameters with a short list of valid values keep the value (anything else
// counts as other); selectors, ids and seeds only count as used.
const enumeratedOptions: Record<string, readonly string[]> = {
  size: randomImageSizes,
  device: randomRequestDeviceValues,
  brightness: [...randomBrightnesses, "all"]
};
const presenceOptions = ["seed", "fallback", "theme", "tag", "author", "id", "group"];

function limitBucket(value: string) {
  const limit = /^\d{1,6}$/u.test(value) ? Number(value) : 0;
  if (limit < 1) return randomApiOptionOther;
  if (limit === 1) return "1";
  if (limit <= 10) return "2-10";
  return limit <= 50 ? "11-50" : "51+";
}

function randomOptions(query: URLSearchParams): RandomApiOption[] {
  const given = (option: string) => query.getAll(option).find((value) => value.trim())?.trim();
  const options: RandomApiOption[] = [];
  for (const [option, values] of Object.entries(enumeratedOptions)) {
    const value = given(option)?.toLowerCase();
    if (value) options.push({ option, value: values.includes(value) ? value : randomApiOptionOther });
  }
  const limit = given("limit");
  if (limit) options.push({ option: "limit", value: limitBucket(limit) });
  for (const option of presenceOptions) {
    if (given(option)) options.push({ option, value: randomApiOptionUsed });
  }
  return options;
}

const randomImageCountKey = "randomImageCount";

/** Anonymous per-hour counts of GET / HEAD calls. */
async function countRandomRequest(c: Context, next: Next) {
  const startedAt = performance.now();
  await next();
  const durationMs = Math.round(performance.now() - startedAt);
  const method = c.req.method;
  if ((method !== "GET" && method !== "HEAD") || !getRuntimeConfig().analytics.enabled) return;
  const query = new URL(c.req.url).searchParams;
  const requestedMode = query.get("mode")?.trim().toLowerCase();
  const mode = randomMethods.find((value) => value === requestedMode)
    ?? getRuntimeConfig().site.random_method;
  const statusClass = randomStatusClass(c.res.status);
  countRandomApiCall({
    at: Date.now(),
    mode,
    method,
    statusClass,
    trusted: requestHasTrustedReferer(c),
    referrerHost: refererHost(c.req.header("referer")),
    images: statusClass === "success" ? c.get(randomImageCountKey) ?? 0 : 0,
    durationMs,
    options: randomOptions(query)
  });
}

async function handleRandomImage(c: Context) {
  if (c.req.method === "OPTIONS") {
    await c.req.raw.body?.cancel().catch(() => undefined);
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": noStoreCacheControl,
        "Access-Control-Allow-Methods": "GET, HEAD",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    return apiErrorResponse({ status: 405, message: "Method Not Allowed" });
  }
  const url = new URL(c.req.url);
  c.req.raw.signal.throwIfAborted();
  // Keep the same quantity cap through rate reservation and image selection.
  const maxItems = getRuntimeConfig().site.random_max_items;
  if (!requestHasTrustedReferer(c)) {
    const reservation = await reserveRandomRequest(
      requestClientIp(c),
      requestedRandomImageCount(url.searchParams, maxItems)
    );
    if (!reservation.allowed) {
      c.header("Retry-After", String(reservation.retryAfterSeconds));
      throw new ApiError(429, "random_rate_limited", "随机图请求过于频繁，请稍后再试");
    }
  }
  return respondRandom(c, url, maxItems);
}

async function respondRandom(c: Context, url: URL, maxItems: number) {
  const signal = c.req.raw.signal;
  const selection = await withPublicDatabaseRead(signal, (database, databaseSignal) =>
    selectRandomImages(
      url,
      c.req.header("user-agent") ?? "",
      requestClientIp(c),
      databaseSignal,
      database,
      maxItems
    )
  );
  if (selection instanceof Response) return selection;
  if (selection.mode === "json") {
    const items = await presentRandomJsonItems(
      selection.items,
      { signal, size: selection.size, origin: `${requestIsSecure(c) ? "https" : "http"}://${url.host}` }
    );
    const body = JSON.stringify(
      apiSuccess({
        count: items.length,
        fallback: selection.fallback,
        items
      } satisfies RandomImageJsonResponseDto)
    );
    c.set(randomImageCountKey, items.length);
    const headers = new Headers({
      "Cache-Control": noStoreCacheControl,
      "Content-Type": "application/json; charset=utf-8"
    });
    headers.set("Content-Length", String(Buffer.byteLength(body)));
    return new Response(c.req.method === "HEAD" ? null : body, { headers });
  }

  const picked = selection.items[0];
  if (!picked) {
    return apiErrorResponse({
      status: 404,
      message: "Not Found: No available images"
    });
  }
  c.set(randomImageCountKey, 1);
  const baseHeaders = {
    "Cache-Control": noStoreCacheControl
  };
  const variant = selection.size;
  if (selection.mode === "proxy") {
    const key = imageObjectKey(picked.id);
    const opened = await (
      await resolveReadableObject(variant, key, picked.storage_slug, {
        mode: "public",
        signal
      })
    ).open(undefined, {
      signal
    });
    // 候选集合变化时固定 seed 也可能换图，后续 Range 请求不保证命中同一对象。
    const headers = new Headers({
      ...baseHeaders,
      "Content-Type": "image/webp"
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

  const config = await getStorageBackend(picked.storage_slug, { mode: "public", signal });
  const location = publicImageUrlForConfig(picked, config, variant);
  return new Response(null, {
    status: 302,
    headers: {
      ...baseHeaders,
      Location: safeRedirectLocation(location),
      "Referrer-Policy": "no-referrer"
    }
  });
}
