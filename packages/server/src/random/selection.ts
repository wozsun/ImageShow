import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { safeResponseHeaderValue } from "../core/http/headers.ts";
import { resolveAuthorTermMap } from "../authors/query.ts";
import { resolveTagTermMap } from "../tags/query.ts";
import { resolveThemeTermMap } from "../themes/query.ts";
import { getRandomPoolSnapshot } from "./cache-read.ts";
import { randomPoolRetry } from "./cache-policy.ts";
import {
  recentlyServedIds,
  rememberServedId
} from "./dedupe.ts";
import {
  pickFromRedisPool,
  resolveCandidateAxes,
  type PickedImage
} from "./picker.ts";
import {
  normalizeRandomQuery,
  parseRandomQuery,
  type RandomSelectorGroup
} from "./query.ts";
import { pickTargetedImage } from "./targeted-selection.ts";

export async function selectRandomImage(
  url: URL,
  userAgent = "",
  clientId = "",
  signal?: AbortSignal
): Promise<PickedImage | Response | null> {
  signal?.throwIfAborted();
  const parsed = parseRandomQuery(
    url,
    getRuntimeConfig().site.random_default_method
  );
  if (parsed instanceof Response) return parsed;
  if (parsed.ids.length) {
    return pickTargetedImage(parsed.ids, parsed.method, signal);
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

  let picked: PickedImage | Response | null;
  try {
    const [recent, snapshot] = await Promise.all([
      recentlyServedIds(clientId, query.signature),
      getRandomPoolSnapshot(signal)
    ]);
    signal?.throwIfAborted();
    picked = await pickFromRedisPool(
      query,
      axes,
      recent,
      snapshot,
      signal
    );
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const retry = randomPoolRetry(error);
    if (!retry) throw error;
    const response = apiErrorResponse({
      status: retry.status,
      message: retry.status === 429
        ? "Too Many Requests: Random pool cold start is rate limited"
        : "Service Unavailable: Random pool is temporarily unavailable"
    });
    response.headers.set(
      "Retry-After",
      safeResponseHeaderValue("Retry-After", String(retry.retryAfterSeconds))
    );
    return response;
  }
  if (picked && !(picked instanceof Response)) {
    await rememberServedId(clientId, query.signature, picked.id);
  }
  return picked;
}

async function resolveSelectorMap(
  selectors: RandomSelectorGroup,
  resolve: (terms: string[]) => Promise<Map<string, string>>
): Promise<Map<string, string>> {
  const terms = [...selectors.include, ...selectors.exclude];
  return terms.length ? resolve(terms) : new Map();
}
