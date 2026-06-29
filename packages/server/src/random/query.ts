// Request parsing/validation for the random API plus the count aggregation that
// powers /img-count. Pure functions over URLSearchParams and the Redis folder map.
import type { FolderMap } from "../core/redis.js";
import { routeError } from "../core/http.js";
import { splitSelectors } from "../core/selectors.js";

export const randomDevices = ["pc", "mb"] as const;
export const randomBrightness = ["dark", "light"] as const;
export type RandomBrightness = (typeof randomBrightness)[number];

// Accepted request selectors. "r" is the random/unknown device sentinel.
export const randomRequestDevices = new Set(["pc", "mb", "r"]);
export const randomMethods = new Set(["proxy", "redirect"]);
const randomAllowedQuery = new Set(["d", "b", "t", "tag", "a", "m"]);
const randomSingleValueQuery = new Set(["d", "b", "m"]);
const randomBrightnessSet = new Set(randomBrightness);

export function isRandomBrightness(value: string): value is RandomBrightness {
  return randomBrightnessSet.has(value as RandomBrightness);
}

export function validateRandomQuery(query: URLSearchParams) {
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

export function validThemesFromMap(map: FolderMap) {
  return Array.from(new Set(randomDevices.flatMap((device) =>
    Object.values(map[device] ?? {}).flatMap((brightnesses) => Object.keys(brightnesses ?? {}))
  ))).sort();
}

// Rejects a selector set that mixes include and exclude terms, as a routeError tagged
// with `noun` (theme / tag / author); returns null when there's no mix.
function mixedSelectorsError(noun: string, include: string[], exclude: string[]) {
  if (!include.length || !exclude.length) return null;
  return routeError(
    { status: 400, message: `Bad Request: Cannot mix include and exclude ${noun} selectors` },
    { include, exclude, hint: `Use either include ${noun}s or exclude ${noun}s, not both` }
  );
}

export function parseThemeSelectors(query: URLSearchParams, validThemes: string[]) {
  const themeSet = new Set(validThemes);
  const { include, exclude } = splitSelectors(query.getAll("t"));
  const mixed = mixedSelectorsError("theme", include, exclude);
  if (mixed) return mixed;
  const invalidTheme = [...include, ...exclude].find((theme) => !themeSet.has(theme));
  if (invalidTheme) return routeError({ status: 400, message: "Bad Request: Invalid theme" }, { field: "t", value: invalidTheme });
  if (include.length) return include;
  if (exclude.length) {
    const excluded = new Set(exclude);
    return validThemes.filter((theme) => !excluded.has(theme));
  }
  return validThemes;
}

// Tag selectors for the random API: comma-separated, each optionally `!`-prefixed to
// exclude. Include is OR (image carries any selected tag). Terms are expected pre-resolved
// to slugs (the service resolves display names). Mixing include and exclude is rejected.
export function parseTagSelectors(query: URLSearchParams) {
  const { include, exclude } = splitSelectors(query.getAll("tag"));
  return mixedSelectorsError("tag", include, exclude) ?? { include, exclude };
}

// Author selectors for the random API: comma-separated, each optionally `!`-prefixed to
// exclude. An image has one author, so include is IN (any selected author). Terms are
// expected pre-resolved to slugs. Mixing include and exclude is rejected.
export function parseAuthorSelectors(query: URLSearchParams) {
  const { include, exclude } = splitSelectors(query.getAll("a"));
  return mixedSelectorsError("author", include, exclude) ?? { include, exclude };
}

export function buildRandomImageCountData(folderMap: FolderMap) {
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
