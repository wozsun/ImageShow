import type { Redis } from "ioredis";
import { redis } from "../../core/redis-client.ts";
import { READY_IMAGE_LAST_UPDATED_KEY } from "./keys.ts";

export function readyImageCacheLastUpdatedValue(value: string) {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new Error("Ready-image cache last-updated timestamp is invalid");
  }
  return value;
}

export async function readReadyImageCacheLastUpdated(
  client: Redis = redis
) {
  const value = await client.get(READY_IMAGE_LAST_UPDATED_KEY);
  return value === null ? null : readyImageCacheLastUpdatedValue(value);
}

export async function markReadyImageCacheLastUpdated(
  client: Redis = redis,
  value = new Date().toISOString()
) {
  const timestamp = readyImageCacheLastUpdatedValue(value);
  await client.set(READY_IMAGE_LAST_UPDATED_KEY, timestamp);
  return timestamp;
}
