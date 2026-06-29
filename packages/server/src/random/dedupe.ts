// Short-term no-repeat for the public random API. Keyed by viewer (client IP) and
// filter signature, a capped Redis list remembers the most recently served image
// ids for a short window; the picker excludes them so consecutive calls don't
// repeat. Best-effort throughout: when Redis is down — or the candidate pool is
// smaller than the history — repeats are allowed rather than failing the request.
import { createHash } from "node:crypto";
import { appConfig } from "@imageshow/shared";
import { pingRedis, redis } from "../core/redis.js";

const RECENT_PREFIX = "imageshow:random_recent:";

function shortHash(value: string) {
  return createHash("sha1").update(value).digest("base64url").slice(0, 16);
}

function recentKey(clientId: string, signature: string) {
  return `${RECENT_PREFIX}${shortHash(clientId)}:${shortHash(signature)}`;
}

// The selectors that decide which images are eligible — requests sharing them
// share one recent-history stream. `m` (proxy/redirect) is excluded since it
// doesn't change which image is picked. Expects the already theme/tag-resolved URL
// so aliases and display names collapse to the same signature as their slugs.
export function filterSignature(url: URL): string {
  const params = url.searchParams;
  const multi = (key: string) => [...new Set(params.getAll(key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean))].sort();
  return JSON.stringify({
    d: params.get("d")?.toLowerCase() ?? "",
    b: params.get("b")?.toLowerCase() ?? "",
    t: multi("t"),
    tag: multi("tag"),
    a: multi("a")
  });
}

export async function recentlyServedIds(clientId: string, signature: string): Promise<Set<string>> {
  if (!clientId) return new Set();
  try {
    await pingRedis();
    const ids = await redis.lrange(recentKey(clientId, signature), 0, appConfig.randomDedupe.historySize - 1);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

export async function rememberServedId(clientId: string, signature: string, id: string): Promise<void> {
  if (!clientId || !id) return;
  try {
    await pingRedis();
    const key = recentKey(clientId, signature);
    await redis.pipeline()
      .lpush(key, id)
      .ltrim(key, 0, appConfig.randomDedupe.historySize - 1)
      .expire(key, appConfig.randomDedupe.ttlSeconds)
      .exec();
  } catch {
    // A missed record only risks one near-term repeat; PostgreSQL/Redis pool unaffected.
  }
}
