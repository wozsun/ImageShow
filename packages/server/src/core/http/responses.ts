import type { Context } from "hono";
import { ApiError } from "../api-error.ts";
import { logger } from "../logger.ts";
import { noStoreCacheControl } from "./headers.ts";

export function apiSuccess(fields: Record<string, unknown> = {}) {
  return { ok: true, ...fields };
}

export function handleApiError(context: Context, error: unknown) {
  context.header("Cache-Control", noStoreCacheControl);
  if (error instanceof ApiError) {
    if (
      error.status === 416
      && typeof (error.details as { total_size?: unknown })?.total_size === "number"
    ) {
      context.header(
        "Content-Range",
        `bytes */${(error.details as { total_size: number }).total_size}`
      );
    }
    return context.json(
      {
        ok: false,
        code: error.code,
        error: error.message,
        details: error.details
      },
      error.status as never
    );
  }
  const unhandled = error as { name?: string };
  if (unhandled?.name === "redis_unavailable") {
    return context.json(
      {
        ok: false,
        code: "redis_unavailable",
        error: "Redis unavailable",
        details: {}
      },
      503
    );
  }

  logger.error(
    `unhandled ${context.req.method} ${new URL(context.req.url).pathname}`,
    error
  );
  return context.json(
    {
      ok: false,
      code: "internal_error",
      error: "Internal server error",
      details: {}
    },
    500
  );
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
  const payload: Record<string, unknown> = {
    ok: false,
    code: error.code ?? codeForStatus(error.status),
    error: error.message
  };
  if (Object.keys(details).length) payload.details = details;
  return new Response(JSON.stringify(payload), {
    status: error.status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": noStoreCacheControl
    }
  });
}
