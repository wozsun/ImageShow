import type { Context, Next } from "hono";
import { ApiError, errorMessage } from "./api-error.ts";
import { requestClientIp } from "./http/request-security.ts";
import { logger } from "./logger.ts";

function adminSession(c: Context) {
  return c.get("session") as { username?: string; role?: string } | undefined;
}

function mutationMethod(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

const adminReadRequestContextKey = "adminReadRequest";

export function markAdminReadRequest(context: Context) {
  context.set(adminReadRequestContextKey, true);
}

function isMarkedAdminReadRequest(context: Context) {
  return context.get(adminReadRequestContextKey) === true;
}

function requestBodyRejected(error: unknown) {
  return error instanceof ApiError
    && requestBodyRejectionCode(error.code);
}

function requestBodyRejectionCode(code: unknown) {
  return code === "invalid_json" || code === "validation_error";
}

async function responseErrorDetails(c: Context) {
  const contentType = c.res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return {};
  try {
    const body = await c.res.clone().json() as unknown;
    if (!body || typeof body !== "object") return {};
    const { code, error } = body as { code?: unknown; error?: unknown };
    return {
      ...(typeof code === "string" ? { code } : {}),
      ...(typeof error === "string" ? { error } : {})
    };
  } catch {
    return {};
  }
}

export async function auditAdminMutation(c: Context, next: Next) {
  const method = c.req.method.toUpperCase();
  if (!mutationMethod(method) || isMarkedAdminReadRequest(c)) {
    await next();
    return;
  }

  const started = Date.now();
  const path = new URL(c.req.url).pathname;
  const session = adminSession(c);
  const base = {
    actor: session?.username ?? "unknown",
    role: session?.role ?? "unknown",
    method,
    path,
    ip: requestClientIp(c)
  };

  try {
    await next();
    const status = c.res.status || 200;
    const entry = { ...base, status, duration_ms: Date.now() - started };
    if (status >= 400) {
      const errorDetails = await responseErrorDetails(c);
      // Hono may convert a downstream exception through the application-level
      // error handler before this middleware resumes. Apply the same
      // pre-write rejection rule to that response path as to the catch path.
      if (requestBodyRejectionCode(errorDetails.code)) return;
      logger.warn("admin action failed", { ...entry, ...errorDetails });
    } else {
      logger.info("admin action", entry);
    }
  } catch (error) {
    // A request rejected before its write model is accepted is not an admin
    // mutation attempt. Keep malformed/unknown payloads free of audit writes.
    if (requestBodyRejected(error)) throw error;
    logger.warn("admin action failed", {
      ...base,
      status: error && typeof error === "object" && "status" in error ? (error as { status?: unknown }).status : undefined,
      duration_ms: Date.now() - started,
      ...(error instanceof ApiError ? { code: error.code } : {}),
      error: errorMessage(error)
    });
    throw error;
  }
}
