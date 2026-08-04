import type { RandomMethod } from "@imageshow/shared/browser";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { resolveAuthorTermMap } from "../authors/query.ts";
import { resolveTagTermMap } from "../tags/query.ts";
import { resolveThemeTermMap } from "../themes/query.ts";
import { createReadyImageFilterPlan } from "../images/ready-cache/filters.ts";
import { sampleReadyImages } from "../images/ready-cache/query.ts";
import {
  recentlyServedIds,
  rememberServedIds
} from "./dedupe.ts";
import {
  normalizeRandomQuery,
  parseRandomQuery,
  type RandomSelectorGroup
} from "./query.ts";
import {
  resolveCandidateAxes,
  type SelectedReadyImage
} from "./selection-model.ts";
import { pickTargetedImages } from "./targeted-selection.ts";

export type RandomImageSelection = {
  method: RandomMethod;
  items: SelectedReadyImage[];
};

function hasSelectors(group: RandomSelectorGroup) {
  return group.include.length > 0 || group.exclude.length > 0;
}

export async function selectRandomImages(
  url: URL,
  userAgent = "",
  clientId = "",
  signal?: AbortSignal
): Promise<RandomImageSelection | Response> {
  signal?.throwIfAborted();
  const parsed = parseRandomQuery(
    url,
    getRuntimeConfig().site.random_default_method
  );
  if (parsed instanceof Response) return parsed;
  if (parsed.ids.length) {
    const items = await pickTargetedImages(
      parsed.ids,
      parsed.resultLimit,
      signal
    );
    return items instanceof Response
      ? items
      : { method: parsed.method, items };
  }

  const [themeMap, tagMap, authorMap] = await Promise.all([
    resolveSelectorMap(parsed.theme, resolveThemeTermMap),
    resolveSelectorMap(parsed.tag, resolveTagTermMap),
    resolveSelectorMap(parsed.author, resolveAuthorTermMap)
  ]);
  signal?.throwIfAborted();
  const query = normalizeRandomQuery(parsed, {
    theme: themeMap,
    tag: tagMap,
    author: authorMap
  });
  if (query instanceof Response) return query;
  const axes = resolveCandidateAxes(
    query.requestedDevice,
    query.requestedBrightness,
    userAgent
  );
  const plan = createReadyImageFilterPlan({
    devices: axes.deviceCandidates,
    brightnesses: axes.brightnessCandidates,
    theme: query.theme,
    tag: query.tag,
    author: query.author
  });
  const recent = await recentlyServedIds(clientId, query.signature);
  signal?.throwIfAborted();
  const cached = await sampleReadyImages(
    plan,
    query.resultLimit,
    recent
  );
  if (!cached.cached) {
    const response = apiErrorResponse({
      status: 503,
      code: "random_cache_unavailable",
      message: "Random image cache is rebuilding"
    });
    response.headers.set("Retry-After", "1");
    return response;
  }
  const items = cached.value;
  if (!items.length) {
    const hasFilters = Boolean(
      axes.requestedDevice
      || axes.requestedBrightness
      || hasSelectors(query.theme)
      || hasSelectors(query.tag)
      || hasSelectors(query.author)
    );
    return apiErrorResponse({
      status: 404,
      message: hasFilters
        ? "Not Found: No available images for the selected filters"
        : "Not Found: No available images"
    });
  }
  await rememberServedIds(
    clientId,
    query.signature,
    items.map((item) => item.id)
  );
  return { method: query.method, items };
}

async function resolveSelectorMap(
  selectors: RandomSelectorGroup,
  resolve: (terms: string[]) => Promise<Map<string, string>>
): Promise<Map<string, string>> {
  const terms = [...selectors.include, ...selectors.exclude];
  return terms.length ? resolve(terms) : new Map();
}
