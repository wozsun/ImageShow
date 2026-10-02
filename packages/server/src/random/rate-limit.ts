import { hash } from "node:crypto";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { reserveRedisWindows } from "../core/redis/window-limit.ts";

/**
 * Requests up to the break-even size spend one unit per image from the image
 * budget; larger or unreadable sizes spend one batch request. At the boundary
 * both windows allow the same request count, so the cost has no step.
 */
export async function reserveRandomRequest(ip: string, imageCount: number | null) {
  const limits = getRuntimeConfig().security;
  const breakEvenCount = Math.max(
    1,
    Math.floor(limits.random_max_requests / limits.random_limit_max_requests)
  );
  const imageCost = imageCount !== null && imageCount <= breakEvenCount
    ? imageCount
    : null;
  const bucket = imageCost === null ? "limit" : "single";
  const source = hash("sha256", ip, "base64url");
  const [reservation] = await reserveRedisWindows([
    {
      key: `imageshow:random_rate:${bucket}:${source}`,
      capacity: imageCost === null
        ? limits.random_limit_max_requests
        : limits.random_max_requests,
      windowSeconds: limits.random_window_seconds,
      cost: imageCost ?? 1
    }
  ]);
  return reservation;
}
