import { hash } from "node:crypto";
import type { RandomImageSize, RandomMethod } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { resolveAuthorTermMap } from "../vocab/authors/query.ts";
import { resolveTagTermMap } from "../vocab/tags/query.ts";
import { resolveThemeTermMap } from "../vocab/themes/query.ts";
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
  type RandomSelectorGroup
} from "./query.ts";
import {
  resolveCandidateAxes,
  type SelectedReadyImage
} from "./selection-model.ts";
import { pickTargetedImages } from "./targeted-selection.ts";
import { sampleReadyImagesFromPostgres } from "./postgres-selection.ts";
import type { PublicDatabaseReadAccess } from "../core/database/public-fallback.ts";

export type RandomImageSelection = {
  mode: RandomMethod;
  size: RandomImageSize;
  items: SelectedReadyImage[];
};

export async function selectRandomImages(
  url: URL,
  userAgent: string,
  clientId: string,
  signal: AbortSignal,
  database: PublicDatabaseReadAccess
): Promise<RandomImageSelection | Response> {
  signal.throwIfAborted();
  const { random_method, random_size } = getRuntimeConfig().site;
  const parsed = parseRandomQuery(
    url,
    random_method,
    random_size
  );
  if (parsed instanceof Response) return parsed;

  const [themeMap, tagMap, authorMap] = await Promise.all([
    resolveSelectorMap(parsed.theme, (terms) => (
      resolveThemeTermMap(terms, database)
    )),
    resolveTagTermMap(parsed.tag?.anyOf.flat() ?? [], database),
    resolveSelectorMap(parsed.author, (terms) => (
      resolveAuthorTermMap(terms, database)
    ))
  ]);
  signal.throwIfAborted();
  const query = normalizeRandomQuery(parsed, {
    theme: themeMap,
    tag: tagMap,
    author: authorMap
  });
  if (query instanceof Response) return query;
  const targeted = query.ids.length > 0;
  const axes = resolveCandidateAxes(
    query.device,
    query.brightness,
    userAgent
  );
  const plan = createImageFilterPlan({
    devices: axes.deviceCandidates,
    brightnesses: axes.brightnessCandidates,
    theme: query.theme,
    tag: query.tag,
    author: query.author
  });
  const seededStart =
    query.seed === null || targeted
      ? undefined
      : Number.parseInt(
          hash("sha256", JSON.stringify(["random", query.seed, plan.signature]), "hex").slice(
            0,
            12
          ),
          16
        );
  const recent =
    query.seed === null
      ? await recentlyServedIds(clientId, query.signature)
      : new Set<string>();
  signal.throwIfAborted();
  let items: SelectedReadyImage[];
  if (targeted) {
    const picked = await pickTargetedImages(
      {
        ids: query.ids,
        plan,
        limit: query.limit,
        seed: query.seed,
        recent
      },
      signal,
      database
    );
    if (picked instanceof Response) return picked;
    items = picked;
  } else {
    const cached = await sampleReadyImages(
      plan,
      query.limit,
      recent,
      signal,
      seededStart
    );
    items = cached.cached
      ? cached.value
      : await sampleReadyImagesFromPostgres(
          plan,
          query.limit,
          recent,
          database.reader,
          signal,
          seededStart
        );
  }
  if (!items.length) {
    const hasFilters = Boolean(
      axes.device !== "auto" ||
      axes.brightness ||
      hasSelectors(query.theme) ||
      query.tag !== null ||
      hasSelectors(query.author)
    );
    return apiErrorResponse(
      {
        status: 404,
        message: hasFilters
          ? "Not Found: No available images for the selected filters"
          : "Not Found: No available images"
      },
      ignoredSelectorDetails(query.ignored)
    );
  }
  if (query.seed === null) {
    await rememberServedIds(
      clientId,
      query.signature,
      items.map((item) => item.id)
    );
  }
  return { mode: query.mode, size: query.size, items };
}

async function resolveSelectorMap(
  selectors: RandomSelectorGroup,
  resolve: (terms: string[]) => Promise<Map<string, string>>
): Promise<Map<string, string>> {
  const terms = [...selectors.include, ...selectors.exclude];
  return terms.length ? resolve(terms) : new Map();
}
