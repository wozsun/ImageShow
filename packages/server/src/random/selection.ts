import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { apiErrorResponse } from "../core/http/responses.ts";
import { resolveAuthorTermMap } from "../authors/query.ts";
import { resolveTagTermMap } from "../tags/query.ts";
import { resolveThemeTermMap } from "../themes/query.ts";
import { getRandomPoolSnapshot } from "./cache-read.ts";
import { randomPoolRetryAfterSeconds } from "./cache-policy.ts";
import {
  filterSignature,
  recentlyServedIds,
  rememberServedId
} from "./dedupe.ts";
import {
  pickFromRedisPool,
  resolveCandidateAxes,
  type PickedImage
} from "./picker.ts";
import {
  isRandomBrightness,
  randomMethods,
  randomRequestDevices,
  validateRandomQuery
} from "./query.ts";

export async function selectRandomImage(
  url: URL,
  userAgent = "",
  clientId = ""
): Promise<PickedImage | Response | null> {
  const queryError = validateRandomQuery(url.searchParams);
  if (queryError) return queryError;

  const explicitMethod = url.searchParams.get("m")?.toLowerCase() || null;
  if (explicitMethod && !randomMethods.has(explicitMethod)) {
    return apiErrorResponse(
      { status: 400, message: "Bad Request: Invalid method" },
      { field: "m" }
    );
  }
  const method = (
    explicitMethod ?? getRuntimeConfig().site.random_default_method
  ) as "proxy" | "redirect";
  const requestedBrightness = url.searchParams.get("b")?.toLowerCase() || null;
  if (requestedBrightness && !isRandomBrightness(requestedBrightness)) {
    return apiErrorResponse({ status: 400, message: "Bad Request: Invalid brightness" }, { field: "b" });
  }
  const requestedDevice = url.searchParams.get("d")?.toLowerCase() || null;
  if (requestedDevice && !randomRequestDevices.has(requestedDevice)) {
    return apiErrorResponse({ status: 400, message: "Bad Request: Invalid device" }, { field: "d" });
  }

  const [themeUrl, tagUrl, authorUrl] = await Promise.all([
    withResolvedSelectors(url, "t", resolveThemeTermMap),
    withResolvedSelectors(url, "tag", resolveTagTermMap),
    withResolvedSelectors(url, "a", resolveAuthorTermMap)
  ]);
  const resolvedUrl = new URL(url);
  for (const [key, source] of [
    ["t", themeUrl],
    ["tag", tagUrl],
    ["a", authorUrl]
  ] as const) {
    resolvedUrl.searchParams.delete(key);
    for (const value of source.searchParams.getAll(key)) {
      resolvedUrl.searchParams.append(key, value);
    }
  }
  const axes = resolveCandidateAxes(requestedDevice, requestedBrightness, userAgent);

  const signature = filterSignature(resolvedUrl);

  let picked: PickedImage | Response | null;
  try {
    const [recent, snapshot] = await Promise.all([
      recentlyServedIds(clientId, signature),
      getRandomPoolSnapshot()
    ]);
    picked = await pickFromRedisPool(resolvedUrl, method, axes, recent, snapshot);
  } catch (error) {
    const retryAfterSeconds = randomPoolRetryAfterSeconds(error);
    if (retryAfterSeconds === undefined) throw error;
    const response = apiErrorResponse({
      status: 503,
      message: "Service Unavailable: Random pool is temporarily unavailable"
    });
    response.headers.set("Retry-After", String(retryAfterSeconds));
    return response;
  }
  if (picked && !(picked instanceof Response)) {
    await rememberServedId(clientId, signature, picked.id);
  }
  return picked;
}

async function withResolvedSelectors(
  url: URL,
  key: string,
  resolve: (terms: string[]) => Promise<Map<string, string>>
): Promise<URL> {
  const raw = url.searchParams.getAll(key);
  if (!raw.length) return url;
  try {
    const terms = raw
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    const map = await resolve(terms.map((term) => term.replace(/^!/, "")));
    const next = new URL(url.toString());
    next.searchParams.delete(key);
    for (const term of terms) {
      const exclude = term.startsWith("!");
      const bare = (exclude ? term.slice(1) : term).toLowerCase();
      const slug = map.get(bare) ?? bare;
      next.searchParams.append(key, exclude ? `!${slug}` : slug);
    }
    return next;
  } catch {
    return url;
  }
}
