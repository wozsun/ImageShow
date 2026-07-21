import type { Context, Hono } from "hono";
import { getRandomCategoryCounts } from "../random/random-cache.ts";
import { contentType, publicImageUrls, resolveReadableObject } from "../storage/storage.ts";
import { clientIp, noStoreCacheControl, publicMetadataCacheControl, routeError } from "../core/http.ts";
import { pickRandom } from "../random/service.ts";
import { buildRandomImageCountData } from "../random/query.ts";
import { webReadableFromNode } from "../storage/stream-buffer.ts";

export function registerRandomRoutes(app: Hono) {
  app.all("/random", handleRandomImage);
  app.all("/img-count", handleRandomImageCount);
}

export async function handleRandomImage(c: Context) {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return routeError({ status: 405, message: "Method Not Allowed" });
  return respondRandom(c, new URL(c.req.url));
}

export async function handleThemeHostRandom(c: Context, theme: string) {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return routeError({ status: 405, message: "Method Not Allowed" });
  const url = new URL(c.req.url);
  url.searchParams.delete("t");
  url.searchParams.set("t", theme);
  return respondRandom(c, url);
}

async function respondRandom(c: Context, url: URL) {
  const picked = await pickRandom(url, c.req.header("user-agent") ?? "", clientIp(c));
  if (picked instanceof Response) return picked;
  if (!picked) return routeError({ status: 404, message: "Not Found: No available images" });
  const imageInfo = `${picked.device}-${picked.brightness}-${picked.theme}-${picked.id}`;
  const baseHeaders = { "Cache-Control": noStoreCacheControl, "X-Image-Info": imageInfo };
  if (picked.method === "proxy") {
    const opened = await (
      await resolveReadableObject("media", picked.object_key, picked.storage_slug)
    ).open();
    // 每次请求都会重新抽图，后续 Range 请求不保证命中同一对象，因此不声明字节范围能力。
    const headers = new Headers({ ...baseHeaders, "Content-Type": contentType(picked.ext) });
    if (opened.size !== undefined) headers.set("Content-Length", String(opened.size));
    if (c.req.method === "HEAD") opened.body.destroy();
    return new Response(c.req.method === "HEAD" ? null : webReadableFromNode(opened.body), { headers });
  }

  const { object_url: location } = await publicImageUrls(
    picked.object_key,
    picked.storage_slug
  );
  return new Response(null, { status: 302, headers: { ...baseHeaders, Location: location, "Referrer-Policy": "no-referrer" } });
}

async function handleRandomImageCount(c: Context) {
  if (c.req.method !== "GET") return routeError({ status: 405, message: "Method Not Allowed" });
  if (new URL(c.req.url).search) return routeError({ status: 403, message: "Forbidden: Query parameters are not allowed on this route" });
  c.header("Cache-Control", publicMetadataCacheControl);
  return c.json(buildRandomImageCountData(await getRandomCategoryCounts()));
}
