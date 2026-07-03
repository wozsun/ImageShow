import type { Context, Hono } from "hono";
import { appConfig } from "@imageshow/shared";
import { getFolderMap } from "../core/redis.js";
import { proxyExternalImage } from "../images/serving.js";
import { contentType, publicImageUrls, readObject } from "../storage/storage.js";
import { clientIp, routeError } from "../core/http.js";
import { pickRandom } from "../random/service.js";
import { buildRandomImageCountData } from "../random/query.js";

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
  const imageInfo = `${picked.device}-${picked.brightness}-${picked.theme}-${String(picked.category_index).padStart(appConfig.categoryIndexDigits, "0")}`;
  const baseHeaders = { "Cache-Control": "no-store", "X-Image-Info": imageInfo };
  if (picked.method === "proxy") {

    if (picked.is_link) return proxyExternalImage(picked.object_key, picked.ext, c.req.method === "HEAD", baseHeaders);
    const headers = { ...baseHeaders, "Content-Type": contentType(picked.ext) };
    if (c.req.method === "HEAD") return new Response(null, { headers });
    return new Response(await readObject("objects", picked.object_key, picked.storage_slug) as unknown as BodyInit, { headers });
  }

  const { object_url: location } = await publicImageUrls(
    picked.object_key,
    picked.storage_slug,
    picked.is_link,
    picked.is_link ? { id: picked.id, device: picked.device, brightness: picked.brightness, theme: picked.theme, ext: picked.ext } : undefined
  );
  return new Response(null, { status: 302, headers: { ...baseHeaders, Location: location, "Referrer-Policy": "no-referrer" } });
}

async function handleRandomImageCount(c: Context) {
  if (c.req.method !== "GET") return routeError({ status: 405, message: "Method Not Allowed" });
  if (new URL(c.req.url).search) return routeError({ status: 403, message: "Forbidden: Query parameters are not allowed on this route" });
  return c.json(buildRandomImageCountData(await getFolderMap()));
}
