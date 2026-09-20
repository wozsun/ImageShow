import type { Context, Next } from "hono";
import { routePath } from "hono/route";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ApiError } from "../api-error.ts";
import { appendVaryHeader } from "./headers.ts";
import { isTrustedReferer } from "../../config/trusted-origins.ts";

export function requestLogContext(context: Context) {
  let requestId = context.get("logRequestId") as string | undefined;
  if (!requestId) {
    requestId = randomUUID();
    context.set("logRequestId", requestId);
    context.header("X-Request-ID", requestId);
  }
  return {
    request_id: requestId,
    method: context.req.method,
    route: routePath(context, -1) || "unknown",
    ip: requestClientIp(context)
  };
}

function requestProtocol(context: Context) {
  const forwarded = context.req.header("x-forwarded-proto")
    ?.trim()
    .toLowerCase();
  if (forwarded === "http" || forwarded === "https") return forwarded;
  return new URL(context.req.url).protocol.replace(":", "");
}

function sameOrigin(context: Context) {
  const origin = context.req.header("origin");
  if (!origin) return true;
  const host = context.req.header("host")?.trim().toLowerCase();
  const protocol = requestProtocol(context);
  try {
    const parsed = new URL(origin);
    return parsed.host === host && parsed.protocol === `${protocol}:`;
  } catch {
    return false;
  }
}

export function requestIsSecure(context: Context) {
  return requestProtocol(context) === "https";
}

export function requestHasTrustedReferer(context: Context) {
  const host = context.req.header("host") ?? new URL(context.req.url).host;
  const origin = new URL(`${requestProtocol(context)}://${host}`).origin;
  return isTrustedReferer(context.req.header("referer"), origin);
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
  const exactIp = (value: string | undefined) => {
    const candidate = value?.trim() ?? "";
    return isIP(candidate) ? candidate : "";
  };
  const realIp = exactIp(context.req.header("x-real-ip"));
  if (realIp) return realIp;
  const forwardedValue = context.req.header("x-forwarded-for");
  const forwarded = forwardedValue?.includes(",")
    ? ""
    : exactIp(forwardedValue);
  return forwarded || "unknown";
}
