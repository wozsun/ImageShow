import { getRuntimeConfig } from "../config/env.js";
import { routeError } from "../core/http.js";
import { isRandomBrightness, randomMethods, randomRequestDevices, validateRandomQuery } from "./query.js";
import { pickFromRedisPool, resolveCandidateAxes, type PickedImage } from "./picker.js";
import { filterSignature, recentlyServedIds, rememberServedId } from "./dedupe.js";
import { resolveThemeTermMap } from "../themes/query.js";
import { resolveTagTermMap } from "../tags/query.js";
import { resolveAuthorTermMap } from "../authors/query.js";

export type { PickedImage } from "./picker.js";

export async function pickRandom(url: URL, userAgent = "", clientId = ""): Promise<PickedImage | Response | null> {
  const queryError = validateRandomQuery(url.searchParams);
  if (queryError) return queryError;

  const explicitMethod = url.searchParams.get("m")?.toLowerCase() || null;
  if (explicitMethod && !randomMethods.has(explicitMethod)) return routeError({ status: 400, message: "Bad Request: Invalid method" }, { field: "m" });
  const method = (explicitMethod ?? getRuntimeConfig().site.random_default_method) as "proxy" | "redirect";
  const requestedBrightness = url.searchParams.get("b")?.toLowerCase() || null;
  if (requestedBrightness && !isRandomBrightness(requestedBrightness)) {
    return routeError({ status: 400, message: "Bad Request: Invalid brightness" }, { field: "b" });
  }
  const requestedDevice = url.searchParams.get("d")?.toLowerCase() || null;
  if (requestedDevice && !randomRequestDevices.has(requestedDevice)) {
    return routeError({ status: 400, message: "Bad Request: Invalid device" }, { field: "d" });
  }

  let resolvedUrl = await withResolvedSelectors(url, "t", resolveThemeTermMap);
  resolvedUrl = await withResolvedSelectors(resolvedUrl, "tag", resolveTagTermMap);
  resolvedUrl = await withResolvedSelectors(resolvedUrl, "a", resolveAuthorTermMap);
  const axes = resolveCandidateAxes(requestedDevice, requestedBrightness, userAgent);

  const signature = filterSignature(resolvedUrl);
  const recent = await recentlyServedIds(clientId, signature);

  let picked: PickedImage | Response | null;
  try {
    picked = await pickFromRedisPool(resolvedUrl, method, axes, recent);
  } catch (error) {
    if ((error as Error).name !== "redis_unavailable") throw error;
    return routeError({ status: 503, message: "Service Unavailable: Random pool is unavailable" });
  }
  if (picked && !(picked instanceof Response)) {
    await rememberServedId(clientId, signature, picked.id);
  }
  return picked;
}

async function withResolvedSelectors(url: URL, key: string, resolve: (terms: string[]) => Promise<Map<string, string>>): Promise<URL> {
  const raw = url.searchParams.getAll(key);
  if (!raw.length) return url;
  try {
    const terms = raw.flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
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
