import { createHash } from "node:crypto";
import { appConfig } from "@imageshow/shared";
import { redis } from "../core/redis-client.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";
import { publicReadUsesFallbackAdmission } from "../core/public-pg-fallback.ts";
import { getRedisOperationalState } from "../core/runtime-availability.ts";

const RECENT_PREFIX = "imageshow:random_recent:";

function shortHash(value: string) {
  return createHash("sha1").update(value).digest("base64url").slice(0, 16);
}

function recentKey(clientId: string, signature: string) {
  return `${RECENT_PREFIX}${shortHash(clientId)}:${shortHash(signature)}`;
}

function publicRedisIsUnavailable() {
  return publicReadUsesFallbackAdmission()
    && !getRedisOperationalState().available;
}

export async function recentlyServedIds(clientId: string, signature: string): Promise<Set<string>> {
  if (!clientId || publicRedisIsUnavailable()) return new Set();
  try {
    const ids = await redis.call(
      "ARLASTITEMS",
      recentKey(clientId, signature),
      String(appConfig.randomDedupe.historySize),
      "REV"
    );
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
      throw new Error("Redis ARLASTITEMS returned an invalid result");
    }
    return new Set(ids as string[]);
  } catch {
    return new Set();
  }
}

export async function rememberServedIds(
  clientId: string,
  signature: string,
  ids: string[]
): Promise<void> {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  if (!clientId || !uniqueIds.length || publicRedisIsUnavailable()) return;
  try {
    const key = recentKey(clientId, signature);
    const pipeline = redis.multi()
      .call(
        "ARRING",
        key,
        String(appConfig.randomDedupe.historySize),
        ...uniqueIds
      )
      .expire(key, appConfig.randomDedupe.ttlSeconds);
    await execRedisPipeline(pipeline);
  } catch {
    // 记录失败只影响短期去重，不影响图片池。
  }
}
