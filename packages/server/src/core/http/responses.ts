import type { Context } from "hono";
import type {
  ApiErrorResponse,
  ApiSuccessResponse
} from "@imageshow/shared/browser";
import { ApiError } from "../api-error.ts";
import { logger } from "../logger.ts";
import {
  noStoreCacheControl,
  privateRevalidationCacheControl,
  responseContentLengthValue
} from "./headers.ts";
import {
  contentResponse,
  createContentRepresentation
} from "./content-response.ts";

export function apiSuccess(): { ok: true };
export function apiSuccess<T extends Record<string, unknown>>(
  fields: T
): ApiSuccessResponse<T>;
export function apiSuccess(fields: Record<string, unknown> = {}) {
  return { ok: true as const, ...fields };
}

export function cacheableApiSuccess<T extends Record<string, unknown>>(
  context: Context,
  fields: T,
  cacheControl: string
) {
  return cacheableContentResponse(
    context,
    JSON.stringify(apiSuccess(fields)),
    {
      cacheControl,
      contentType: "application/json; charset=UTF-8"
    }
  );
}

export function privateCacheableApiSuccess<T extends Record<string, unknown>>(
  context: Context,
  fields: T
) {
  return cacheableApiSuccess(
    context,
    fields,
    privateRevalidationCacheControl
  );
}

export function cacheableContentResponse(
  context: Context,
  body: string,
  options: {
    cacheControl: string;
    contentType: string;
    headers?: Readonly<Record<string, string>>;
  }
) {
  const response = contentResponse(
    createContentRepresentation(body),
    {
      ...options,
      ifNoneMatch: context.req.header("if-none-match")
    }
  );
  return context.newResponse(response.body, response);
}

export function handleApiError(context: Context, error: unknown) {
  context.header("Cache-Control", noStoreCacheControl);
  if (error instanceof ApiError) {
    const retryAfterSeconds = Number(
      (error as ApiError & { retryAfterSeconds?: unknown }).retryAfterSeconds
    );
    if (Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
      context.header("Retry-After", String(retryAfterSeconds));
    }
    const totalSize = responseContentLengthValue(
      (error.details as { total_size?: unknown })?.total_size
    );
    if (error.status === 416 && totalSize !== undefined) {
      context.header(
        "Content-Range",
        `bytes */${totalSize}`
      );
    }
    const payload = {
      ok: false,
      code: error.code,
      error: error.message,
      details: error.details
    } satisfies ApiErrorResponse;
    return context.json(payload, error.status as never);
  }
  const unhandled = error as { name?: string };
  if (unhandled?.name === "redis_unavailable") {
    const payload = {
      ok: false,
      code: "redis_unavailable",
      error: "Redis unavailable",
      details: {}
    } satisfies ApiErrorResponse;
    return context.json(payload, 503);
  }

  logger.error(
    `unhandled ${context.req.method} ${new URL(context.req.url).pathname}`,
    error
  );
  const payload = {
    ok: false,
    code: "internal_error",
    error: "Internal server error",
    details: {}
  } satisfies ApiErrorResponse;
  return context.json(payload, 500);
}

function codeForStatus(status: number): string {
  switch (status) {
    case 400: return "bad_request";
    case 403: return "forbidden";
    case 404: return "not_found";
    case 405: return "method_not_allowed";
    case 429: return "too_many_requests";
    case 503: return "service_unavailable";
    default: return status >= 500 ? "internal_error" : "request_error";
  }
}

export function apiErrorResponse(
  error: { status: number; message: string; code?: string },
  details: Record<string, unknown> = {}
) {
  const payload: ApiErrorResponse = {
    ok: false,
    code: error.code ?? codeForStatus(error.status),
    error: error.message,
    ...(Object.keys(details).length ? { details } : {})
  };
  return new Response(JSON.stringify(payload), {
    status: error.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": noStoreCacheControl
    }
  });
}
