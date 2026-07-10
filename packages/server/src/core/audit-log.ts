import type { Context, Next } from "hono";
import { ApiError, clientIp, errorMessage } from "./http.ts";
import { logger } from "./logger.ts";

function adminSession(c: Context) {
  return c.get("session") as { username?: string; role?: string } | undefined;
}

function mutationMethod(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
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
  if (!mutationMethod(method)) {
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
    ip: clientIp(c)
  };

  try {
    await next();
    const status = c.res.status || 200;
    const entry = { ...base, status, duration_ms: Date.now() - started };
    if (status >= 400) logger.warn("admin action failed", { ...entry, ...(await responseErrorDetails(c)) });
    else logger.info("admin action", entry);
  } catch (error) {
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
