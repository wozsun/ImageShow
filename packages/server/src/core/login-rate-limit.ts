import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "./api-error.ts";
import { redis } from "./redis-client.ts";
import { reserveRedisWindows } from "./redis-window-limit.ts";

const loginFailureKeyPrefix = "imageshow:login_fail";
const globalKey = `${loginFailureKeyPrefix}:global`;

function identityKey(ip: string, username: string) {
  const normalizedUser = username.trim().toLowerCase().slice(0, 80) || "empty";
  return `${loginFailureKeyPrefix}:${ip}:${normalizedUser}`;
}

export const loginRateLimiter = {
  async reserve(ip: string, username: string) {
    const limits = getRuntimeConfig().security;
    const [identity, global] = await reserveRedisWindows([
      {
        key: identityKey(ip, username),
        capacity: limits.login_max_failures,
        windowSeconds: limits.login_failure_window_seconds
      },
      {
        key: globalKey,
        capacity: limits.login_global_max_attempts,
        windowSeconds: limits.login_global_window_seconds
      }
    ]);
    if (
      !identity?.allowed
      || !global?.allowed
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
