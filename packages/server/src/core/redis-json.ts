import { appConfig } from "@imageshow/shared";
import { redis } from "./redis-client.ts";

export async function getRedisJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
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
