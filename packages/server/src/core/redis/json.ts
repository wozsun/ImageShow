import { appConfig } from "@imageshow/shared";
import { redis } from "./client.ts";
import {
  getRedisOperationalState,
  requireOperationalRedis,
  runRequiredRedisCommand
} from "../runtime-availability.ts";

type RedisJsonLookup<T> =
  | { status: "hit"; value: T }
  | { status: "miss" }
  | { status: "unavailable" };

function publicRedisIsUnavailable() {
  return !getRedisOperationalState().available;
}

async function getRedisJsonLookup<T>(
  key: string
): Promise<RedisJsonLookup<T>> {
  if (publicRedisIsUnavailable()) return { status: "unavailable" };
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

/** Redis JSON read for request paths where Redis is a hard dependency. */
export async function getRequiredRedisJson<T>(key: string): Promise<T | null> {
  await requireOperationalRedis();
  const raw = await runRequiredRedisCommand(() => redis.get(key));
  if (!raw) return null;
  try {
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
  if (publicRedisIsUnavailable()) return false;
  try {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
    return true;
  } catch {
    return false;
  }
}

/** Redis JSON write paired with a required request-path cache miss. */
export async function setRequiredRedisJson(
  key: string,
  value: unknown,
  ttlSeconds = appConfig.derivedCacheTtlSeconds
) {
  const serialized = JSON.stringify(value);
  await requireOperationalRedis();
  await runRequiredRedisCommand(() => (
    redis.set(key, serialized, "EX", ttlSeconds)
  ));
  return true;
}

export async function deleteRedisKeys(...keys: string[]) {
  if (!keys.length) return false;
  if (publicRedisIsUnavailable()) return false;
  try {
    await redis.unlink(...keys);
    return true;
  } catch {
    return false;
  }
}

export async function deleteRequiredRedisKeys(...keys: string[]) {
  if (!keys.length) return false;
  await requireOperationalRedis();
  await runRequiredRedisCommand(() => redis.unlink(...keys));
  return true;
}
