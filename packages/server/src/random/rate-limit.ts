import { hash } from "node:crypto";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { reserveRedisWindows } from "../core/redis/window-limit.ts";

export async function reserveRandomRequest(ip: string, hasLimit: boolean) {
  const limits = getRuntimeConfig().security;
  const bucket = hasLimit ? "limit" : "single";
  const source = hash("sha256", ip, "base64url");
  const [reservation] = await reserveRedisWindows([{
    key: `imageshow:random_rate:${bucket}:${source}`,
    capacity: hasLimit
      ? limits.random_limit_max_requests
      : limits.random_max_requests,
    windowSeconds: limits.random_window_seconds
  }]);
  if (!reservation) throw new Error("Random rate-limit reservation is missing");
  return reservation;
}
