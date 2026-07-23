import type { Context, Next } from "hono";
import { ApiError } from "../api-error.ts";
import { appendVaryHeader } from "./headers.ts";

function sameOrigin(context: Context) {
  const origin = context.req.header("origin");
  if (!origin) return true;
  const host = context.req.header("x-forwarded-host")
    || context.req.header("host");
  const protocol = context.req.header("x-forwarded-proto")
    || new URL(context.req.url).protocol.replace(":", "");
  try {
    const parsed = new URL(origin);
    return parsed.host === host && parsed.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

export function assertSameOrigin(context: Context) {
  if (!sameOrigin(context)) {
    throw new ApiError(403, "origin_forbidden", "Origin forbidden");
  }
}

export function blockCrossSiteFetch(context: Context, next: Next) {
  appendVaryHeader(context, "Sec-Fetch-Site");
  const site = context.req.header("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") {
    throw new ApiError(
      403,
      "cross_origin_forbidden",
      "Cross-origin request forbidden"
    );
  }
  return next();
}

export function requestClientIp(context: Context): string {
  const realIp = context.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = context.req.header("x-forwarded-for")
    ?.split(",")[0]
    ?.trim();
  return forwarded || "unknown";
}
