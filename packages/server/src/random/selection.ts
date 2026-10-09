import { hash } from "node:crypto";
import { randomFallbackDimensions, type RandomFallbackDimension, type RandomImageSize, type RandomMethod } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { getAuthorSlugs } from "../vocab/authors/query.ts";
import { getTagSlugs } from "../vocab/tags/query.ts";
import { getThemeSlugs } from "../vocab/themes/query.ts";
import { createImageFilterPlan } from "../images/filter-plan.ts";
import { sampleReadyImages } from "../images/ready-cache/query.ts";
import {
  recentlyServedIds,
  rememberServedIds
} from "./dedupe.ts";
import {
  hasSelectors,
  ignoredSelectorDetails,
  normalizeRandomQuery,
  parseRandomQuery,
  type ParsedRandomQuery
} from "./query.ts";
import {
  resolveCandidateAxes,
  type SelectedReadyImage
} from "./selection-model.ts";
import { readImageGroupSlugs } from "../images/groups/slug-cache.ts";
import { sampleReadyImagesFromPostgres } from "./postgres-selection.ts";
import type { PublicDatabaseReadAccess } from "../core/database/public-fallback.ts";

export type RandomImageSelection = {
  mode: RandomMethod;
  size: RandomImageSize;
  items: SelectedReadyImage[];
  fallback: RandomFallbackDimension[];
};

export async function selectRandomImages(
  url: URL,
  userAgent: string,
  clientId: string,
  signal: AbortSignal,
  database: PublicDatabaseReadAccess
): Promise<RandomImageSelection | Response> {
  signal.throwIfAborted();
  const { random_method, random_size, random_fallback_order } = getRuntimeConfig().site;
  const parsed = parseRandomQuery(
    url,
    random_method,
    random_size,
    random_fallback_order
  );
  if (parsed instanceof Response) return parsed;

  const [theme, tag, author, groups] = await Promise.all([
    hasSelectors(parsed.theme) ? getThemeSlugs(database) : new Set<string>(),
    parsed.tag ? getTagSlugs(database) : new Set<string>(),
    hasSelectors(parsed.author) ? getAuthorSlugs(database) : new Set<string>(),
    parsed.groups.length ? readImageGroupSlugs(database) : new Set<string>()
  ]);
  signal.throwIfAborted();
  const slugs = { theme, tag, author, groups };
  const original = normalizeRandomQuery(parsed, slugs);
  let recent: Set<string> | undefined;
  const relaxed: RandomFallbackDimension[] = [];
  let current = parsed;
  const pending = [...parsed.fallback];

  while (true) {
    signal.throwIfAborted();
    const query = normalizeRandomQuery(current, slugs);
    let items: SelectedReadyImage[] = [];
    if (!query.unmatchable) {
      recent ??= parsed.seed === null
        ? await recentlyServedIds(clientId, original.signature)
        : new Set<string>();
      const axes = resolveCandidateAxes(query.device, query.brightness, userAgent);
      const plan = createImageFilterPlan({
        devices: axes.deviceCandidates,
        brightnesses: axes.brightnessCandidates,
        theme: query.theme,
        tag: query.tag,
        author: query.author,
        ...(query.scoped ? { range: { groups: query.groups, ids: query.ids } } : {})
      });
      // The seed depends on the effective plan and the set of relaxed dimensions,
      // not the order in which they were relaxed or the requested limit.
      const relaxedSet = randomFallbackDimensions.filter((dimension) => relaxed.includes(dimension));
      const seed = query.seed !== null && relaxedSet.length
        ? JSON.stringify([query.seed, relaxedSet])
        : query.seed;
      const seededStart = seed === null ? undefined : Number.parseInt(
        hash("sha256", JSON.stringify(["random", seed, plan.signature]), "hex").slice(0, 12),
        16
      );
      const cached = await sampleReadyImages(plan, query.limit, recent, signal, seededStart);
      items = cached.cached ? cached.value : await sampleReadyImagesFromPostgres(
        plan, query.limit, recent, database.reader, signal, seededStart
      );
    }
    if (items.length) {
      if (parsed.seed === null) {
        await rememberServedIds(clientId, original.signature, items.map((item) => item.id));
      }
      return { mode: parsed.mode, size: parsed.size, items, fallback: relaxed };
    }

    let next: ParsedRandomQuery | null = null;
    while (pending.length && next === null) {
      const dimension = pending.shift()!;
      next = relaxRandomDimension(current, dimension, userAgent);
      if (next) relaxed.push(dimension);
    }
    if (!next) break;
    current = next;
  }

  const axes = resolveCandidateAxes(parsed.device, parsed.brightness, userAgent);
  const hasFilters = axes.device !== "auto" || axes.brightness ||
    hasSelectors(parsed.theme) || parsed.tag !== null || hasSelectors(parsed.author);
  return apiErrorResponse(
    {
      status: 404,
      message: hasFilters
        ? "Not Found: No available images for the selected filters"
        : "Not Found: No available images"
    },
    ignoredSelectorDetails(original.ignored)
  );
}

/** Returns null when this dimension places no positive restriction on the request. */
function relaxRandomDimension(
  query: ParsedRandomQuery,
  dimension: RandomFallbackDimension,
  userAgent: string
): ParsedRandomQuery | null {
  switch (dimension) {
    case "device":
      return resolveCandidateAxes(query.device, query.brightness, userAgent).deviceCandidates.length === 1
        ? { ...query, device: "all" }
        : null;
    case "brightness":
      return query.brightness ? { ...query, brightness: null } : null;
    case "tag":
      return query.tag ? { ...query, tag: null } : null;
    case "author":
    case "theme":
      // Keep the original exclusions: normalization may have folded them into
      // the include set, but relaxing includes must never remove exclusions.
      return query[dimension].include.length
        ? { ...query, [dimension]: { include: [], exclude: query[dimension].exclude } }
        : null;
  }
}
