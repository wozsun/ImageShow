// Orchestrates a single random pick: validate the request, resolve candidate
// axes, then pick from the Redis pool — falling back to PostgreSQL if Redis is
// unavailable so the public API stays up.
import { getRuntimeConfig } from "../config/env.js";
import { routeError } from "../core/http.js";
import { isRandomBrightness, randomMethods, randomRequestDevices, validateRandomQuery } from "./query.js";
import { pickFromDatabase, pickFromRedisPool, resolveCandidateAxes, type PickedImage } from "./picker.js";
import { filterSignature, recentlyServedIds, rememberServedId } from "./dedupe.js";
import { resolveThemeTermMap } from "../themes/query.js";
import { resolveTagTermMap } from "../tags/query.js";
import { resolveAuthorTermMap } from "../authors/query.js";

export type { PickedImage } from "./picker.js";

export async function pickRandom(url: URL, userAgent = "", clientId = ""): Promise<PickedImage | Response | null> {
  const queryError = validateRandomQuery(url.searchParams);
  if (queryError) return queryError;
  // An explicit m= wins for every image; without it every image (stored or link) follows the
  // site-level default. Link images need no special default: their redirect target is
  // link.<domain>/media, which proxies the original server-side (see publicImageUrls /
  // serveLinkMedia), so even redirect mode beats hotlink protection.
  const explicitMethod = url.searchParams.get("m")?.toLowerCase() || null;
  if (explicitMethod && !randomMethods.has(explicitMethod)) return routeError({ status: 400, message: "Bad Request: Invalid method" }, { field: "m" });
  const method = (explicitMethod ?? getRuntimeConfig().random.default_method) as "proxy" | "redirect";
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
  // Short-term no-repeat: exclude this viewer's recently-served images (per filter)
  // from the pick, then record whatever we serve. Best-effort — an empty set (Redis
  // down or first visit) just means no exclusion.
  const signature = filterSignature(resolvedUrl);
  const recent = await recentlyServedIds(clientId, signature);
  // Tags and authors aren't part of the category-keyed Redis pool, so either filter is
  // served by a direct PostgreSQL pick (which can match the image_tag join / author column).
  const hasTagFilter = resolvedUrl.searchParams.getAll("tag").some((value) => value.split(",").some((part) => part.trim()));
  const hasAuthorFilter = resolvedUrl.searchParams.getAll("a").some((value) => value.split(",").some((part) => part.trim()));
  let picked: PickedImage | Response | null;
  if (hasTagFilter || hasAuthorFilter) {
    picked = await pickFromDatabase(resolvedUrl, method, axes, recent);
  } else {
    try {
      picked = await pickFromRedisPool(resolvedUrl, method, axes, recent);
    } catch (error) {
      if ((error as Error).name !== "redis_unavailable") throw error;
      picked = await pickFromDatabase(resolvedUrl, method, axes, recent);
    }
  }
  if (picked && !(picked instanceof Response)) {
    await rememberServedId(clientId, signature, picked.id);
  }
  return picked;
}

// Rewrites a multi-value selector param (t / tag / a) to canonical slugs — resolving
// aliases / display names via `resolve` while preserving each term's `!` exclude prefix
// — so the picker, which matches against slug-keyed pools / columns, treats an alias the
// same as its slug. Best-effort: on a resolution error the original terms are kept as-is.
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
