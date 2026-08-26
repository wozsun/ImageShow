import { getRedisJson, setRedisJson } from "../core/redis/json.ts";

export const ORIGINAL_DIRECT_CACHE_PREFIX = "imageshow:original_direct:";
const ORIGINAL_DIRECT_CACHE_TTL_SECONDS = 60 * 60;

type OriginalDirectCacheValue = { direct: boolean };

export async function getOriginalDirectCache(key: string) {
  const value = await getRedisJson<Partial<OriginalDirectCacheValue>>(
    `${ORIGINAL_DIRECT_CACHE_PREFIX}${key}`
  );
  return typeof value?.direct === "boolean" ? { direct: value.direct } : null;
}

export function setOriginalDirectCache(key: string, direct: boolean) {
  return setRedisJson(
    `${ORIGINAL_DIRECT_CACHE_PREFIX}${key}`,
    { direct },
    ORIGINAL_DIRECT_CACHE_TTL_SECONDS
  );
}
