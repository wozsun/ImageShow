import {
  imageCardDensities,
  type AdminPreferences
} from "@imageshow/shared";
import { redis } from "../core/redis-client.ts";

const adminPreferenceKeyPrefix = "imageshow:admin_preferences:";
const validImageCardDensities = new Set<string>(imageCardDensities);

function adminPreferenceRedisKey(username: string) {
  return `${adminPreferenceKeyPrefix}${username}`;
}

function redisUnavailable(cause: unknown) {
  const error = new Error("Redis unavailable", { cause });
  error.name = "redis_unavailable";
  return error;
}

/**
 * 只解析当前版本认识的值。Redis 中的未知字段或旧值不会透传给前端，
 * 便于以后增加、改名或废弃界面偏好而不破坏 API 合同。
 */
function parseAdminPreferences(values: Record<string, string>): AdminPreferences {
  const preferences: AdminPreferences = {};
  if (validImageCardDensities.has(values.image_card_density)) {
    preferences.image_card_density = values.image_card_density as AdminPreferences["image_card_density"];
  }
  return preferences;
}

export async function readAdminPreferences(username: string): Promise<AdminPreferences> {
  try {
    return parseAdminPreferences(await redis.hgetall(adminPreferenceRedisKey(username)));
  } catch (cause) {
    throw redisUnavailable(cause);
  }
}

export async function updateAdminPreferences(
  username: string,
  preferences: AdminPreferences
) {
  const fields: string[] = [];
  for (const [key, value] of Object.entries(preferences)) {
    if (typeof value === "string") fields.push(key, value);
  }

  try {
    if (fields.length) await redis.hset(adminPreferenceRedisKey(username), ...fields);
  } catch (cause) {
    throw redisUnavailable(cause);
  }
}

export async function deleteAdminPreferences(username: string) {
  try {
    await redis.unlink(adminPreferenceRedisKey(username));
  } catch (cause) {
    throw redisUnavailable(cause);
  }
}
