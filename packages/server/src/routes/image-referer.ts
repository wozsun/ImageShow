import type { Context, Next } from "hono";
import { ApiError } from "../core/api-error.ts";
import { appendVaryHeader } from "../core/http/headers.ts";
import { requestHasTrustedReferer } from "../core/http/request-security.ts";

export function assertAllowedImageReferer(context: Context) {
  appendVaryHeader(context, "Referer");
  const referer = context.req.header("referer");
  if (referer?.trim() && !requestHasTrustedReferer(context)) {
    throw new ApiError(403, "image_referer_forbidden", "Image referer forbidden");
  }
}

export function requireImageReferer(context: Context, next: Next) {
  assertAllowedImageReferer(context);
  return next();
}
