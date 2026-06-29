// Candidate selection for the random API: resolve the device/brightness/theme
// axes from the request, then weight-pick an image from the Redis folder map,
// with a direct PostgreSQL pick as the fallback path.
import { appConfig, categoryKey, indexKey } from "@imageshow/shared";
import { getRandomObject, getRandomPoolSnapshot, rebuildFolderMap, type RandomObjectIndexItem } from "../core/redis.js";
import { pool } from "../core/db.js";
import { routeError } from "../core/http.js";
import { isRandomBrightness, parseAuthorSelectors, parseTagSelectors, parseThemeSelectors, randomBrightness, randomDevices, validThemesFromMap } from "./query.js";

export type PickedImage = RandomObjectIndexItem & { method: "proxy" | "redirect" };

function inferDevice(ua: string) {
  if (!ua) return "r";
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return "mb";
  if (/Windows|Macintosh|Linux x86_64|X11/i.test(ua)) return "pc";
  return "r";
}

export function resolveCandidateAxes(requestedDevice: string | null, requestedBrightness: string | null, userAgent: string) {
  const device = requestedDevice || inferDevice(userAgent);
  const deviceCandidates = device === "r" ? [...randomDevices] : [device as "pc" | "mb"];
  const brightnessCandidates = requestedBrightness && isRandomBrightness(requestedBrightness) ? [requestedBrightness] : [...randomBrightness];
  return { deviceCandidates, brightnessCandidates, requestedDevice, requestedBrightness };
}

export type CandidateAxes = ReturnType<typeof resolveCandidateAxes>;

function noCandidatesError(url: URL, axes: CandidateAxes) {
  const hasFilters = Boolean(axes.requestedDevice || axes.requestedBrightness || url.searchParams.getAll("t").length || url.searchParams.getAll("tag").length || url.searchParams.getAll("a").length);
  return routeError({ status: 404, message: hasFilters ? "Not Found: No available images for the selected filters" : "Not Found: No available images" });
}

export async function pickFromRedisPool(url: URL, method: "proxy" | "redirect", axes: CandidateAxes, recent: Set<string> = new Set()): Promise<PickedImage | Response | null> {
  const snapshot = await getRandomPoolSnapshot();
  let folderMap = snapshot.folderMap;
  let themes = snapshot.themes;
  let rebuilds = 0;
  // A recently-served candidate is skipped, but kept as a fallback so a pool
  // smaller than the dedupe history still returns something instead of 404.
  let fallback: RandomObjectIndexItem | null = null;
  for (let attempt = 0; attempt < appConfig.randomDedupe.maxAttempts; attempt += 1) {
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
    const item = await weightedPick(candidates);
    if (!item) {
      // A stale index pointed at a removed image: rebuild from PostgreSQL and retry,
      // bounded by the miss-retry budget so a persistently empty slot can't loop.
      if (rebuilds >= appConfig.randomMissRetries) break;
      rebuilds += 1;
      folderMap = await rebuildFolderMap();
      themes = validThemesFromMap(folderMap);
      continue;
    }
    if (recent.has(item.id)) { fallback = item; continue; }
    return { ...item, method };
  }
  return fallback ? { ...fallback, method } : null;
}

// One weighted draw: a category's chance is proportional to its image count, then
// a uniform index within it. Returns null when the chosen index is a stale slot.
async function weightedPick(candidates: Array<{ category: string; count: number }>): Promise<RandomObjectIndexItem | null> {
  const total = candidates.reduce((sum, choice) => sum + choice.count, 0);
  let ticket = Math.random() * total;
  const selected = candidates.find((item) => {
    ticket -= item.count;
    return ticket < 0;
  }) ?? candidates[candidates.length - 1];
  const idx = 1 + Math.floor(Math.random() * selected.count);
  return getRandomObject(indexKey(selected.category, idx));
}

export async function pickFromDatabase(url: URL, method: "proxy" | "redirect", axes: CandidateAxes, recent: Set<string> = new Set()): Promise<PickedImage | Response | null> {
  const themes = (await pool.query(
    "SELECT DISTINCT theme FROM metadata WHERE status='ready' ORDER BY theme"
  )).rows.map((row) => row.theme as string);
  const themeCandidates = parseThemeSelectors(url.searchParams, themes);
  if (themeCandidates instanceof Response) return themeCandidates;
  if (!themeCandidates.length) return noCandidatesError(url, axes);
  const tags = parseTagSelectors(url.searchParams);
  if (tags instanceof Response) return tags;
  const authors = parseAuthorSelectors(url.searchParams);
  if (authors instanceof Response) return authors;
  const conditions = ["status='ready'", "device = ANY($1::text[])", "brightness = ANY($2::text[])", "theme = ANY($3::text[])"];
  const params: unknown[] = [axes.deviceCandidates, axes.brightnessCandidates, themeCandidates];
  // Include is OR (any selected tag); exclude removes images carrying any of them.
  if (tags.include.length) { params.push(tags.include); conditions.push(`id IN (SELECT image_id FROM image_tag WHERE tag_slug = ANY($${params.length}::text[]))`); }
  if (tags.exclude.length) { params.push(tags.exclude); conditions.push(`id NOT IN (SELECT image_id FROM image_tag WHERE tag_slug = ANY($${params.length}::text[]))`); }
  // One author per image: include is IN the selected set, exclude removes them (keeping
  // no-author (NULL) images, which aren't by any excluded author).
  if (authors.include.length) { params.push(authors.include); conditions.push(`author = ANY($${params.length}::text[])`); }
  if (authors.exclude.length) { params.push(authors.exclude); conditions.push(`(author IS NULL OR author <> ALL($${params.length}::text[]))`); }
  const recentIds = [...recent];
  // First pass excludes recently-served images for short-term no-repeat; if that
  // empties the pool (history covers everything), a second pass without the
  // exclusion still serves rather than 404s.
  for (const excludeRecent of recentIds.length ? [true, false] : [false]) {
    const passConditions = [...conditions];
    const passParams = [...params];
    if (excludeRecent) { passParams.push(recentIds); passConditions.push(`id <> ALL($${passParams.length}::uuid[])`); }
    const where = passConditions.join(" AND ");
    // Avoid a full `ORDER BY random()` sort of the whole match set: count the matches, then
    // index-scan to a uniform random offset ordered by the PK. (A row deleted between the two
    // queries can rarely leave the offset past the end → empty result → next pass / 404; that's
    // acceptable on this Redis-down fallback path.)
    const total = Number((await pool.query(`SELECT count(*)::int AS n FROM metadata WHERE ${where}`, passParams)).rows[0].n);
    if (!total) continue;
    const row = (await pool.query(
      `SELECT id, object_key, ext, index_key, device, brightness, theme, category_index, storage_slug, is_link
       FROM metadata
       WHERE ${where}
       ORDER BY id
       OFFSET $${passParams.length + 1}
       LIMIT 1`,
      [...passParams, Math.floor(Math.random() * total)]
    )).rows[0];
    if (row) {
      return {
        id: row.id,
        object_key: row.object_key,
        ext: row.ext,
        index_key: row.index_key,
        device: row.device,
        brightness: row.brightness,
        theme: row.theme,
        category_index: Number(row.category_index),
        storage_slug: row.storage_slug,
        is_link: row.is_link,
        method
      };
    }
  }
  return noCandidatesError(url, axes);
}
