import { appConfig } from "@imageshow/shared";
import {
  buildRandomFilterSet,
  getRandomPoolSnapshot,
  randomAxisSetKey,
  randomCategorySetKey,
  sampleRandomPoolItems,
  type RandomPoolItem,
  type RandomPoolSnapshot
} from "./random-cache.ts";
import { routeError } from "../core/http.ts";
import { isRandomBrightness, parseAuthorSelectors, parseTagSelectors, parseThemeSelectors, randomBrightnesses, randomDevices } from "./query.ts";

export type PickedImage = RandomPoolItem & { method: "proxy" | "redirect" };

function inferDevice(ua: string) {
  if (!ua) return "r";
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return "mb";
  if (/Windows|Macintosh|Linux x86_64|X11/i.test(ua)) return "pc";
  return "r";
}

export function resolveCandidateAxes(requestedDevice: string | null, requestedBrightness: string | null, userAgent: string) {
  const device = requestedDevice || inferDevice(userAgent);
  const deviceCandidates = device === "r" ? [...randomDevices] : [device as "pc" | "mb"];
  const brightnessCandidates = requestedBrightness && isRandomBrightness(requestedBrightness) ? [requestedBrightness] : [...randomBrightnesses];
  return { deviceCandidates, brightnessCandidates, requestedDevice, requestedBrightness };
}

export type CandidateAxes = ReturnType<typeof resolveCandidateAxes>;

function hasSelector(query: URLSearchParams, key: string) {
  return query.getAll(key).some((value) => value.split(",").some((part) => part.trim()));
}

function noCandidatesError(url: URL, axes: CandidateAxes) {
  const hasFilters = Boolean(
    axes.requestedDevice ||
    axes.requestedBrightness ||
    hasSelector(url.searchParams, "t") ||
    hasSelector(url.searchParams, "tag") ||
    hasSelector(url.searchParams, "a")
  );
  return routeError({ status: 404, message: hasFilters ? "Not Found: No available images for the selected filters" : "Not Found: No available images" });
}

function weightedPick<T extends { count: number }>(candidates: T[]): T | null {
  const total = candidates.reduce((sum, candidate) => sum + candidate.count, 0);
  if (!Number.isFinite(total) || total <= 0) return null;
  let ticket = Math.random() * total;
  for (const candidate of candidates) {
    ticket -= candidate.count;
    if (ticket < 0) return candidate;
  }
  return candidates.at(-1) ?? null;
}

function axisCandidates(snapshot: RandomPoolSnapshot, axes: CandidateAxes) {
  const candidates: Array<{ key: string; count: number }> = [];
  for (const device of axes.deviceCandidates) {
    const deviceMap = snapshot.categoryCounts[device] ?? {};
    for (const brightness of axes.brightnessCandidates) {
      const count = Object.values(deviceMap[brightness] ?? {}).reduce((sum, value) => {
        const n = Number(value);
        return Number.isFinite(n) && n > 0 ? sum + n : sum;
      }, 0);
      if (count > 0) candidates.push({ key: randomAxisSetKey(snapshot.generation, device, brightness), count });
    }
  }
  return candidates;
}

function categoryCandidates(snapshot: RandomPoolSnapshot, axes: CandidateAxes, themes: string[]) {
  const candidates: Array<{ key: string; count: number }> = [];
  for (const device of axes.deviceCandidates) {
    const deviceMap = snapshot.categoryCounts[device] ?? {};
    for (const brightness of axes.brightnessCandidates) {
      const themeMap = deviceMap[brightness] ?? {};
      for (const theme of themes) {
        const count = Number(themeMap[theme] ?? 0);
        if (Number.isFinite(count) && count > 0) {
          candidates.push({ key: randomCategorySetKey(snapshot.generation, device, brightness, theme), count });
        }
      }
    }
  }
  return candidates;
}

async function pickFromSet(generation: string, setKey: string, method: "proxy" | "redirect", recent: Set<string>) {
  const batchSize = Math.max(8, Math.min(64, appConfig.randomDedupe.historySize + 1));
  let fallback: RandomPoolItem | null = null;
  for (let attempt = 0; attempt < appConfig.randomDedupe.maxAttempts; attempt += 1) {
    const items = await sampleRandomPoolItems(setKey, batchSize, generation);
    if (!items.length) return fallback ? { ...fallback, method } : null;
    for (const item of items) {
      if (!fallback) fallback = item;
      if (!recent.has(item.id)) return { ...item, method };
    }
  }
  return fallback ? { ...fallback, method } : null;
}

export async function pickFromRedisPool(url: URL, method: "proxy" | "redirect", axes: CandidateAxes, recent: Set<string> = new Set(), prefetchedSnapshot?: RandomPoolSnapshot): Promise<PickedImage | Response | null> {
  const snapshot = prefetchedSnapshot ?? await getRandomPoolSnapshot();
  const themeCandidates = parseThemeSelectors(url.searchParams, snapshot.themes);
  if (themeCandidates instanceof Response) return themeCandidates;

  const tags = parseTagSelectors(url.searchParams);
  if (tags instanceof Response) return tags;
  const authors = parseAuthorSelectors(url.searchParams);
  if (authors instanceof Response) return authors;

  const hasThemeFilter = hasSelector(url.searchParams, "t");
  const hasTagOrAuthorFilter = tags.include.length > 0 || tags.exclude.length > 0 || authors.include.length > 0 || authors.exclude.length > 0;
  const baseCandidates = hasThemeFilter
    ? categoryCandidates(snapshot, axes, themeCandidates)
    : axisCandidates(snapshot, axes);
  if (!baseCandidates.length) return noCandidatesError(url, axes);

  if (!hasTagOrAuthorFilter) {
    const selected = weightedPick(baseCandidates);
    if (!selected) return noCandidatesError(url, axes);
    return await pickFromSet(snapshot.generation, selected.key, method, recent) ?? noCandidatesError(url, axes);
  }

  const filter = await buildRandomFilterSet({
    generation: snapshot.generation,
    signature: `${url.searchParams.toString()}|${baseCandidates.map((candidate) => candidate.key).join("|")}`,
    baseSetKeys: baseCandidates.map((candidate) => candidate.key),
    tagInclude: tags.include,
    tagExclude: tags.exclude,
    authorInclude: authors.include,
    authorExclude: authors.exclude
  });
  if (filter.count <= 0) return noCandidatesError(url, axes);
  return await pickFromSet(snapshot.generation, filter.key, method, recent) ?? noCandidatesError(url, axes);
}
