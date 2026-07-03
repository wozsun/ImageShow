import type { Context, Next } from "hono";
import { clientIp, errorMessage } from "./http.js";
import { logger } from "./logger.js";

function adminSession(c: Context) {
  return c.get("session") as { username?: string; role?: string } | undefined;
}

function mutationMethod(method: string) {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
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
    if (status >= 400) logger.warn("admin action failed", entry);
    else logger.info("admin action", entry);
  } catch (error) {
    logger.warn("admin action failed", {
      ...base,
      status: error && typeof error === "object" && "status" in error ? (error as { status?: unknown }).status : undefined,
      duration_ms: Date.now() - started,
      error: errorMessage(error)
    });
    throw error;
  }
}
