import { appConfig } from "@imageshow/shared";
import type { RandomMethod } from "@imageshow/shared/browser";
import {
  buildRandomFilterSet,
  getRandomPoolSnapshot,
  sampleRandomPoolItems
} from "./cache-read.ts";
import {
  randomAxisSetKey,
  randomCategorySetKey
} from "./cache-keys.ts";
import {
  type RandomPoolItem,
  type RandomPoolSnapshot
} from "./cache-model.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import {
  isRandomBrightness,
  randomBrightnesses,
  randomDevices,
  randomThemeCandidates,
  type NormalizedRandomQuery,
  type RandomSelectorGroup
} from "./query.ts";

export type PickedImage = RandomPoolItem & { method: RandomMethod };

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

function hasSelector(selectors: RandomSelectorGroup) {
  return selectors.include.length > 0 || selectors.exclude.length > 0;
}

function noCandidatesError(query: NormalizedRandomQuery, axes: CandidateAxes) {
  const hasFilters = Boolean(
    axes.requestedDevice ||
    axes.requestedBrightness ||
    hasSelector(query.theme) ||
    hasSelector(query.tag) ||
    hasSelector(query.author)
  );
  return apiErrorResponse({ status: 404, message: hasFilters ? "Not Found: No available images for the selected filters" : "Not Found: No available images" });
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

async function pickFromSet(
  generation: string,
  setKey: string,
  method: RandomMethod,
  recent: Set<string>
) {
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

export async function pickFromRedisPool(
  query: NormalizedRandomQuery,
  axes: CandidateAxes,
  recent: Set<string> = new Set(),
  prefetchedSnapshot?: RandomPoolSnapshot,
  signal?: AbortSignal
): Promise<PickedImage | Response | null> {
  signal?.throwIfAborted();
  const snapshot = prefetchedSnapshot ?? await getRandomPoolSnapshot(signal);
  const themeCandidates = randomThemeCandidates(query.theme, snapshot.themes);
  if (themeCandidates instanceof Response) return themeCandidates;

  const hasThemeFilter = hasSelector(query.theme);
  const hasTagOrAuthorFilter = hasSelector(query.tag) || hasSelector(query.author);
  const baseCandidates = hasThemeFilter
    ? categoryCandidates(snapshot, axes, themeCandidates)
    : axisCandidates(snapshot, axes);
  if (!baseCandidates.length) return noCandidatesError(query, axes);

  if (!hasTagOrAuthorFilter) {
    const selected = weightedPick(baseCandidates);
    if (!selected) return noCandidatesError(query, axes);
    return await pickFromSet(snapshot.generation, selected.key, query.method, recent)
      ?? noCandidatesError(query, axes);
  }

  const filter = await buildRandomFilterSet({
    generation: snapshot.generation,
    signature: `${query.signature}|${baseCandidates
      .map((candidate) => candidate.key)
      .sort()
      .join("|")}`,
    baseSetKeys: baseCandidates.map((candidate) => candidate.key),
    tagInclude: query.tag.include,
    tagExclude: query.tag.exclude,
    authorInclude: query.author.include,
    authorExclude: query.author.exclude
  }, signal);
  if (filter.count <= 0) return noCandidatesError(query, axes);
  return await pickFromSet(snapshot.generation, filter.key, query.method, recent)
    ?? noCandidatesError(query, axes);
}
