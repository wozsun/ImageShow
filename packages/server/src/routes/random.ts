// Public random-image API: GET /random (weighted pick returned as a proxied
// body or a 302 to the object's public URL) and GET /img-count (pool stats).
// The candidate pool is read from the Redis folder map.
import type { Context, Hono } from "hono";
import { appConfig, categoryKey, indexKey } from "@imageshow/shared";
import { getFolderMap, getRandomObject, getRandomPoolSnapshot, rebuildFolderMap, type FolderMap, type RandomObjectIndexItem } from "../core/redis.js";
import { contentType } from "../images/processing.js";
import { publicImageUrls, readObject } from "../storage/storage.js";
import { getRuntimeConfig } from "../config/env.js";
import { pool } from "../core/db.js";
import { routeError } from "../core/http.js";

type PickedImage = RandomObjectIndexItem & { method: "proxy" | "redirect" };

const randomAllowedQuery = new Set(["d", "b", "t", "m"]);
const randomSingleValueQuery = new Set(["d", "b", "m"]);
const randomDevices = ["pc", "mb"] as const;
const randomRequestDevices = new Set(["pc", "mb", "r"]);
const randomBrightness = ["dark", "light"] as const;
type RandomBrightness = (typeof randomBrightness)[number];
const randomBrightnessSet = new Set(randomBrightness);
const randomMethods = new Set(["proxy", "redirect"]);

export function registerRandomRoutes(app: Hono) {
  app.all("/random", handleRandomImage);
  app.all("/img-count", handleRandomImageCount);
}

export async function handleRandomImage(c: Context) {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") return routeError({ status: 405, message: "Method Not Allowed" });
  const url = new URL(c.req.url);
  const picked = await pickRandom(url, c.req.header("user-agent") ?? "");
  if (picked instanceof Response) return picked;
  if (!picked) return routeError({ status: 404, message: "Not Found: No available images" });
  const imageInfo = `${picked.device}-${picked.brightness}-${picked.theme}-${String(picked.category_index).padStart(appConfig.categoryIndexDigits, "0")}`;
  if (picked.method === "proxy") {
    const headers = {
      "Content-Type": contentType(picked.ext),
      "Cache-Control": "no-store",
      "X-Image-Info": imageInfo
    };
    // HEAD mirrors GET's headers but carries no payload, so skip the object read:
    // for local that avoids opening the file, for S3 it avoids a full GET whose
    // body we would only discard.
    if (c.req.method === "HEAD") return new Response(null, { headers });
    return new Response(await readObject("objects", picked.object_key, picked.storage_backend) as unknown as BodyInit, { headers });
  }
  const { object_url: location } = await publicImageUrls(picked.object_key, picked.storage_backend);
  return new Response(null, { status: 302, headers: { Location: location, "Cache-Control": "no-store" } });
}

async function handleRandomImageCount(c: Context) {
  if (c.req.method !== "GET") return routeError({ status: 405, message: "Method Not Allowed" });
  if (new URL(c.req.url).search) return routeError({ status: 403, message: "Forbidden: Query parameters are not allowed on this route" });
  return c.json(buildRandomImageCountData(await getFolderMap()));
}

function inferDevice(ua: string) {
  if (!ua) return "r";
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return "mb";
  if (/Windows|Macintosh|Linux x86_64|X11/i.test(ua)) return "pc";
  return "r";
}

function validateRandomQuery(query: URLSearchParams) {
  for (const key of query.keys()) {
    if (!randomAllowedQuery.has(key)) {
      return routeError(
        { status: 400, message: "Bad Request: Invalid query parameters" },
        { invalidQuery: [key], allowedQuery: [...randomAllowedQuery] }
      );
    }
  }
  for (const key of query.keys()) {
    if (randomSingleValueQuery.has(key) && query.getAll(key).length > 1) {
      return routeError(
        { status: 400, message: "Bad Request: Duplicate query parameter" },
        { field: key, hint: "This parameter only accepts a single value" }
      );
    }
  }
  return null;
}

function validThemesFromMap(map: FolderMap) {
  return Array.from(new Set(randomDevices.flatMap((device) =>
    Object.values(map[device] ?? {}).flatMap((brightnesses) => Object.keys(brightnesses ?? {}))
  ))).sort();
}

function parseThemeSelectors(query: URLSearchParams, validThemes: string[]) {
  const themeSet = new Set(validThemes);
  const values = Array.from(new Set(query
    .getAll("t")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)));
  const include: string[] = [];
  const exclude: string[] = [];
  for (const value of values) {
    if (value.startsWith("!")) {
      const theme = value.slice(1);
      if (theme) exclude.push(theme);
    } else {
      include.push(value);
    }
  }
  if (include.length && exclude.length) {
    return routeError(
      { status: 400, message: "Bad Request: Cannot mix include and exclude theme selectors" },
      { include, exclude, hint: "Use either include themes or exclude themes, not both" }
    );
  }
  const invalidTheme = [...include, ...exclude].find((theme) => !themeSet.has(theme));
  if (invalidTheme) return routeError({ status: 400, message: "Bad Request: Invalid theme" }, { field: "t", value: invalidTheme });
  if (include.length) return include;
  if (exclude.length) {
    const excluded = new Set(exclude);
    return validThemes.filter((theme) => !excluded.has(theme));
  }
  return validThemes;
}

function buildRandomImageCountData(folderMap: FolderMap) {
  const groupTotals: Record<string, number> = {};
  const themeDetails: Record<string, Record<string, number>> = {};
  let totalImages = 0;
  for (const device of Object.keys(folderMap).sort()) {
    const deviceEntry = folderMap[device];
    if (!deviceEntry || typeof deviceEntry !== "object") continue;
    for (const brightness of Object.keys(deviceEntry).sort()) {
      const brightnessEntry = deviceEntry[brightness];
      if (!brightnessEntry || typeof brightnessEntry !== "object") continue;
      const groupKey = `${device}-${brightness}`;
      let groupTotal = 0;
      for (const theme of Object.keys(brightnessEntry).sort()) {
        const count = Number(brightnessEntry[theme] ?? 0);
        if (!Number.isFinite(count) || count <= 0) continue;
        groupTotal += count;
        totalImages += count;
        themeDetails[theme] ??= { total: 0 };
        themeDetails[theme].total += count;
        themeDetails[theme][groupKey] = count;
      }
      groupTotals[groupKey] = groupTotal;
    }
  }
  return { totalImages, groupTotals, themeDetails };
}

async function pickRandom(url: URL, userAgent = ""): Promise<PickedImage | Response | null> {
  const queryError = validateRandomQuery(url.searchParams);
  if (queryError) return queryError;
  const method = (url.searchParams.get("m")?.toLowerCase() || getRuntimeConfig().random.default_method) as "proxy" | "redirect";
  if (!randomMethods.has(method)) return routeError({ status: 400, message: "Bad Request: Invalid method" }, { field: "m" });
  const requestedBrightness = url.searchParams.get("b")?.toLowerCase() || null;
  if (requestedBrightness && !isRandomBrightness(requestedBrightness)) {
    return routeError({ status: 400, message: "Bad Request: Invalid brightness" }, { field: "b" });
  }
  const requestedDevice = url.searchParams.get("d")?.toLowerCase() || null;
  if (requestedDevice && !randomRequestDevices.has(requestedDevice)) {
    return routeError({ status: 400, message: "Bad Request: Invalid device" }, { field: "d" });
  }

  const axes = resolveCandidateAxes(requestedDevice, requestedBrightness, userAgent);
  try {
    return await pickFromRedisPool(url, method, axes);
  } catch (error) {
    // Redis being down must not take the public random API offline: fall back to a
    // direct (low-frequency) random pick from PostgreSQL honoring the same filters.
    if ((error as Error).name !== "redis_unavailable") throw error;
    return pickFromDatabase(url, method, axes);
  }
}

function resolveCandidateAxes(requestedDevice: string | null, requestedBrightness: string | null, userAgent: string) {
  const device = requestedDevice || inferDevice(userAgent);
  const deviceCandidates = device === "r" ? [...randomDevices] : [device as "pc" | "mb"];
  const brightnessCandidates = requestedBrightness && isRandomBrightness(requestedBrightness) ? [requestedBrightness] : [...randomBrightness];
  return { deviceCandidates, brightnessCandidates, requestedDevice, requestedBrightness };
}

type CandidateAxes = ReturnType<typeof resolveCandidateAxes>;

function noCandidatesError(url: URL, axes: CandidateAxes) {
  const hasFilters = Boolean(axes.requestedDevice || axes.requestedBrightness || url.searchParams.getAll("t").length);
  return routeError({ status: 404, message: hasFilters ? "Not Found: No available images for the selected filters" : "Not Found: No available images" });
}

async function pickFromRedisPool(url: URL, method: "proxy" | "redirect", axes: CandidateAxes): Promise<PickedImage | Response | null> {
  const snapshot = await getRandomPoolSnapshot();
  let folderMap = snapshot.folderMap;
  let themes = snapshot.themes;
  for (let attempt = 0; attempt <= appConfig.randomMissRetries; attempt += 1) {
    const themeCandidates = parseThemeSelectors(url.searchParams, themes);
    if (themeCandidates instanceof Response) return themeCandidates;
    const candidates: Array<{ category: string; count: number }> = [];
    for (const candidateDevice of axes.deviceCandidates) {
      const deviceMap = folderMap[candidateDevice] ?? {};
      for (const brightness of axes.brightnessCandidates) {
        for (const theme of themeCandidates) {
          const count = Number(deviceMap[brightness]?.[theme] ?? 0);
          if (Number.isFinite(count) && count > 0) candidates.push({ category: categoryKey(candidateDevice, brightness, theme), count });
        }
      }
    }
    if (!candidates.length) return noCandidatesError(url, axes);
    // Weighted pick: a category's chance is proportional to its image count.
    const total = candidates.reduce((sum, choice) => sum + choice.count, 0);
    let ticket = Math.random() * total;
    const selected = candidates.find((item) => {
      ticket -= item.count;
      return ticket < 0;
    }) ?? candidates[candidates.length - 1];
    const idx = 1 + Math.floor(Math.random() * selected.count);
    const item = await getRandomObject(indexKey(selected.category, idx));
    if (item) return { ...item, method };
    folderMap = await rebuildFolderMap();
    themes = validThemesFromMap(folderMap);
  }
  return null;
}

async function pickFromDatabase(url: URL, method: "proxy" | "redirect", axes: CandidateAxes): Promise<PickedImage | Response | null> {
  const themes = (await pool.query(
    "SELECT DISTINCT theme FROM metadata WHERE status='ready' AND device IN ('pc','mb') AND brightness IN ('dark','light') ORDER BY theme"
  )).rows.map((row) => row.theme as string);
  const themeCandidates = parseThemeSelectors(url.searchParams, themes);
  if (themeCandidates instanceof Response) return themeCandidates;
  if (!themeCandidates.length) return noCandidatesError(url, axes);
  const row = (await pool.query(
    `SELECT id, object_key, ext, index_key, device, brightness, theme, category_index, storage_backend
     FROM metadata
     WHERE status='ready' AND device = ANY($1::text[]) AND brightness = ANY($2::text[]) AND theme = ANY($3::text[])
     ORDER BY random()
     LIMIT 1`,
    [axes.deviceCandidates, axes.brightnessCandidates, themeCandidates]
  )).rows[0];
  if (!row) return noCandidatesError(url, axes);
  return {
    id: row.id,
    object_key: row.object_key,
    ext: row.ext,
    index_key: row.index_key,
    device: row.device,
    brightness: row.brightness,
    theme: row.theme,
    category_index: Number(row.category_index),
    storage_backend: row.storage_backend,
    method
  };
}

function isRandomBrightness(value: string): value is RandomBrightness {
  return randomBrightnessSet.has(value as RandomBrightness);
}
