import { appConfig } from "@imageshow/shared";
import { redis } from "./redis-client.ts";

export type RedisJsonLookup<T> =
  | { status: "hit"; value: T }
  | { status: "miss" }
  | { status: "unavailable" };

export async function getRedisJsonLookup<T>(
  key: string
): Promise<RedisJsonLookup<T>> {
  let raw: string | null;
  try {
    raw = await redis.get(key);
  } catch {
    return { status: "unavailable" };
  }
  if (!raw) return { status: "miss" };
  try {
    return { status: "hit", value: JSON.parse(raw) as T };
  } catch {
    return { status: "miss" };
  }
}

export async function getRedisJson<T>(key: string): Promise<T | null> {
  const result = await getRedisJsonLookup<T>(key);
  return result.status === "hit" ? result.value : null;
}

export async function setRedisJson(
  key: string,
  value: unknown,
  ttlSeconds = appConfig.derivedCacheTtlSeconds
) {
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

export async function deleteRedisKeys(...keys: string[]) {
  if (!keys.length) return false;
  try {
    await redis.unlink(...keys);
    return true;
  } catch {
    return false;
  }
}
