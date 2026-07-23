import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "./api-error.ts";
import { redis } from "./redis-client.ts";

const loginFailureKeyPrefix = "imageshow:login_fail";
const globalKey = `${loginFailureKeyPrefix}:global`;

function identityKey(ip: string, username: string) {
  const normalizedUser = username.trim().toLowerCase().slice(0, 80) || "empty";
  return `${loginFailureKeyPrefix}:${ip}:${normalizedUser}`;
}

export const loginRateLimiter = {
  async reserve(ip: string, username: string) {
    const limits = getRuntimeConfig().security;
    const counts = (await redis.eval(
      `local function bump(name, ttl)
         local total = redis.call('INCR', name)
         local remaining = redis.call('TTL', name)
         if total == 1 or remaining < 0 then redis.call('EXPIRE', name, ttl) end
         return total
       end
       return { bump(KEYS[1], ARGV[1]), bump(KEYS[2], ARGV[2]) }`,
      2,
      identityKey(ip, username),
      globalKey,
      limits.login_failure_window_seconds,
      limits.login_global_window_seconds
    )) as [number, number];
    if (
      Number(counts[0]) > limits.login_max_failures
      || Number(counts[1]) > limits.login_global_max_attempts
    ) {
      throw new ApiError(
        429,
        "too_many_login_attempts",
        "登录尝试过于频繁，请稍后再试"
      );
    }
  },

  async clear(ip: string, username: string) {
    await redis.del(identityKey(ip, username));
  }
};
