import type { Context, Hono } from "hono";
import type { RandomImageJsonResponseDto } from "@imageshow/shared/browser";
import { resolveReadableObject } from "../storage/object-access.ts";
import { contentType } from "../storage/object-keys.ts";
import { publicImageUrls } from "../storage/public-urls.ts";
import { apiErrorResponse, apiSuccess } from "../core/http/responses.ts";
import { requestClientIp } from "../core/http/request-security.ts";
import {
  noStoreCacheControl,
  responseContentLengthValue,
  safeResponseHeaderValue
} from "../core/http/headers.ts";
import { presentRandomJsonItems } from "../random/json-presentation.ts";
import { selectRandomImages } from "../random/selection.ts";
import { webReadableFromNode } from "../storage/stream-buffer.ts";

export function registerRandomRoutes(app: Hono) {
  app.all("/random", handleRandomImage);
}

export async function handleRandomImage(c: Context) {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return apiErrorResponse({ status: 405, message: "Method Not Allowed" });
  return respondRandom(c, new URL(c.req.url));
}

async function respondRandom(c: Context, url: URL) {
  const selection = await selectRandomImages(
    url,
    c.req.header("user-agent") ?? "",
    requestClientIp(c),
    c.req.raw.signal
  );
  if (selection instanceof Response) return selection;
  if (selection.method === "json") {
    const items = await presentRandomJsonItems(
      selection.items,
      c.req.raw.signal
    );
    const fields = {
      count: items.length,
      items
    } satisfies RandomImageJsonResponseDto;
    const body = JSON.stringify(apiSuccess(fields));
    const headers = new Headers({
      "Cache-Control": noStoreCacheControl,
      "Content-Type": "application/json; charset=utf-8"
    });
    const contentLength = responseContentLengthValue(Buffer.byteLength(body));
    if (contentLength !== undefined) headers.set("Content-Length", contentLength);
    return new Response(c.req.method === "HEAD" ? null : body, { headers });
  }

  const picked = selection.items[0];
  if (!picked) return apiErrorResponse({ status: 404, message: "Not Found: No available images" });
  const imageInfo = `${picked.device}-${picked.brightness}-${picked.theme}-${picked.id}`;
  const baseHeaders = {
    "Cache-Control": noStoreCacheControl,
    "X-Image-Info": safeResponseHeaderValue("X-Image-Info", imageInfo)
  };
  if (selection.method === "proxy") {
    const opened = await (
      await resolveReadableObject("media", picked.object_key, picked.storage_slug)
    ).open();
    // 每次请求都会重新抽图，后续 Range 请求不保证命中同一对象，因此不声明字节范围能力。
    const headers = new Headers({ ...baseHeaders, "Content-Type": contentType(picked.ext) });
    const contentLength = responseContentLengthValue(opened.size);
    if (contentLength !== undefined) {
      headers.set("Content-Length", contentLength);
    }
    if (c.req.method === "HEAD") opened.body.destroy();
    return new Response(c.req.method === "HEAD" ? null : webReadableFromNode(opened.body), { headers });
  }

  const { object_url: location } = await publicImageUrls(
    picked.object_key,
    picked.storage_slug
  );
  return new Response(null, {
    status: 302,
    headers: {
      ...baseHeaders,
      Location: safeResponseHeaderValue("Location", location),
      "Referrer-Policy": "no-referrer"
    }
  });
}
