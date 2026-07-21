import type { Redis } from "ioredis";
import type { RuntimeConfig } from "@imageshow/shared";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "./api-error.ts";
import { redis } from "./redis-client.ts";
import { volatileKeyNamespace } from "./runtime-key-namespace.ts";

type LoginSecurityLimits = RuntimeConfig["security"];

type LoginRateLimiterOptions = {
  redisClient: Pick<Redis, "eval" | "del">;
  namespace: string;
  getLimits: () => LoginSecurityLimits;
};

export type LoginRateLimiter = {
  reserve(ip: string, username: string): Promise<void>;
  clear(ip: string, username: string): Promise<void>;
};

function normalizeNamespace(value: string) {
  const namespace = value.trim().replace(/:+$/g, "");
  if (!namespace || namespace.length > 160) {
    throw new Error("Login rate-limit namespace must contain 1-160 characters");
  }
  return namespace;
}

/** @internal Exported for isolated rate-limiter verification. */
export function createLoginRateLimiter({
  redisClient,
  namespace: namespaceInput,
  getLimits
}: LoginRateLimiterOptions): LoginRateLimiter {
  const namespace = normalizeNamespace(namespaceInput);
  const globalKey = `${namespace}:login_fail_global`;
  const identityKey = (ip: string, username: string) => {
    const normalizedUser = username.trim().toLowerCase().slice(0, 80) || "empty";
    return `${namespace}:login_fail:${ip}:${normalizedUser}`;
  };

  return {
    async reserve(ip, username) {
      const limits = getLimits();
      const counts = (await redisClient.eval(
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

    async clear(ip, username) {
      await redisClient.del(identityKey(ip, username));
    }
  };
}

export const loginRateLimiter = createLoginRateLimiter({
  redisClient: redis,
  namespace: volatileKeyNamespace,
  getLimits: () => getRuntimeConfig().security
});
