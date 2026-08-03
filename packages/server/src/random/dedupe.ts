import { createHash } from "node:crypto";
import { appConfig } from "@imageshow/shared";
import { redis } from "../core/redis-client.ts";
import { execRedisPipeline } from "../core/redis-pipeline.ts";

const RECENT_PREFIX = "imageshow:random_recent:";

function shortHash(value: string) {
  return createHash("sha1").update(value).digest("base64url").slice(0, 16);
}

function recentKey(clientId: string, signature: string) {
  return `${RECENT_PREFIX}${shortHash(clientId)}:${shortHash(signature)}`;
}

export async function recentlyServedIds(clientId: string, signature: string): Promise<Set<string>> {
  if (!clientId) return new Set();
  try {
    const ids = await redis.lrange(recentKey(clientId, signature), 0, appConfig.randomDedupe.historySize - 1);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

export async function rememberServedId(clientId: string, signature: string, id: string): Promise<void> {
  if (!clientId || !id) return;
  try {
    const key = recentKey(clientId, signature);
    const pipeline = redis.pipeline()
      .lpush(key, id)
      .ltrim(key, 0, appConfig.randomDedupe.historySize - 1)
      .expire(key, appConfig.randomDedupe.ttlSeconds);
    await execRedisPipeline(pipeline);
  } catch {
    // 记录失败只影响短期去重，不影响图片池。
  }
}
