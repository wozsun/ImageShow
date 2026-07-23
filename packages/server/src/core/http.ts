import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { pool } from "./db.ts";
import { redis } from "./redis-client.ts";
import { logger } from "./logger.ts";
import { verifyPassword } from "./password.ts";
import { ApiError } from "./api-error.ts";
import { loginRateLimiter } from "./login-rate-limit.ts";

export const cspReportPath = "/api/security/csp-report";
const cspReportGroup = "imageshow-csp";
const trustedTypePolicyNames = [
  "imageshow-altcha-worker",
  "svelte-trusted-html",
  "decodeHTMLEntitiesPolicy",
  "AGPolicy"
].join(" ");

export const securityHeaders: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
};

export const spaDocumentHeaders: Record<string, string> = {
  ...securityHeaders,
  "Content-Security-Policy": "script-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "Content-Security-Policy-Report-Only": `require-trusted-types-for 'script'; trusted-types ${trustedTypePolicyNames}; report-to ${cspReportGroup}`,
  "Reporting-Endpoints": `${cspReportGroup}="${cspReportPath}"`
};

export const noStoreCacheControl = "no-store";
export const privateNoStoreCacheControl = "private, no-store";
export const immutableCacheControl = "public, max-age=31536000, immutable";
export const publicDocumentCacheControl = "public, max-age=0, s-maxage=60, stale-while-revalidate=300, stale-if-error=600";
export const publicDocsCacheControl = "public, max-age=0, s-maxage=600, stale-while-revalidate=3600, stale-if-error=86400";
export const publicStaticCacheControl = "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800, stale-if-error=604800";
export const publicProxyImageCacheControl = "public, max-age=86400, s-maxage=31536000, stale-while-revalidate=604800, stale-if-error=2592000";
export const publicProxyFallbackThumbCacheControl = "public, max-age=604800, s-maxage=604800";
export const publicRedirectCacheControl = "public, max-age=300, s-maxage=3600, stale-while-revalidate=3600, stale-if-error=86400";
const publicApiCacheControl = "public, max-age=0, s-maxage=30, stale-while-revalidate=30, stale-if-error=30";
export const publicListCacheControl = publicApiCacheControl;
export const publicMetadataCacheControl = publicApiCacheControl;
export const publicConfigCacheControl = publicApiCacheControl;
export const robotsCacheControl = "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400, stale-if-error=86400";

export function ok(data: Record<string, unknown> = {}) {
  return { ok: true, ...data };
}

export function fail(c: Context, error: unknown) {
  c.header("Cache-Control", noStoreCacheControl);
  if (error instanceof ApiError) {
    if (error.status === 416 && typeof (error.details as { total_size?: unknown })?.total_size === "number") {
      c.header("Content-Range", `bytes */${(error.details as { total_size: number }).total_size}`);
    }
    return c.json({ ok: false, code: error.code, error: error.message, details: error.details }, error.status as never);
  }
  const anyError = error as { name?: string; message?: string };
  if (anyError?.name === "redis_unavailable") {
    return c.json({ ok: false, code: "redis_unavailable", error: "Redis unavailable", details: {} }, 503);
  }

  logger.error(`unhandled ${c.req.method} ${new URL(c.req.url).pathname}`, error);
  return c.json({ ok: false, code: "internal_error", error: "Internal server error", details: {} }, 500);
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

export function routeError(error: { status: number; message: string; code?: string }, details: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = { ok: false, code: error.code ?? codeForStatus(error.status), error: error.message };
  if (Object.keys(details).length) payload.details = details;
  return new Response(JSON.stringify(payload), {
    status: error.status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": noStoreCacheControl }
  });
}

function isSecure(c: Context) {
  return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

function sameOrigin(c: Context) {
  const origin = c.req.header("origin");
  if (!origin) return true;
  const host = c.req.header("x-forwarded-host") || c.req.header("host");
  const proto = c.req.header("x-forwarded-proto") || new URL(c.req.url).protocol.replace(":", "");
  try {
    const parsed = new URL(origin);
    return parsed.host === host && parsed.protocol === `${proto}:`;
  } catch {
    return false;
  }
}

export function assertSameOrigin(c: Context) {
  if (!sameOrigin(c)) throw new ApiError(403, "origin_forbidden", "Origin forbidden");
}

export function blockCrossSiteFetch(c: Context, next: Next) {
  appendVaryHeader(c, "Sec-Fetch-Site");
  const site = c.req.header("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") {
    throw new ApiError(403, "cross_origin_forbidden", "Cross-origin request forbidden");
  }
  return next();
}

export function appendVaryHeader(c: Context, ...names: string[]) {
  const existing = c.res.headers.get("Vary")
    ?.split(",")
    .map((name) => name.trim())
    .filter(Boolean) ?? [];
  const normalized = new Map(existing.map((name) => [name.toLowerCase(), name]));
  for (const name of names) normalized.set(name.toLowerCase(), name);
  c.header("Vary", [...normalized.values()].join(", "));
}

export async function login(
  c: Context,
  username: string,
  password: string
) {
  assertSameOrigin(c);
  const ip = clientIp(c);
  await loginRateLimiter.reserve(ip, username);
  const result = await pool.query("SELECT username, password_hash, role FROM admin_account WHERE username = $1", [username]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(user.password_hash, password))) {
    throw new ApiError(401, "invalid_credentials", "用户名或密码错误");
  }
  await loginRateLimiter.clear(ip, username);
  const sessionId = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const sessionTtl = getRuntimeConfig().security.session_ttl_seconds;
  await redis.set(`imageshow:session:${sessionId}`, JSON.stringify({ username, csrf, role: user.role }), "EX", sessionTtl);
  setCookie(c, "imageshow_session", sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecure(c),
    path: "/",
    maxAge: sessionTtl
  });
  return { csrf_token: csrf };
}

export async function getSession(c: Context) {
  const id = getCookie(c, "imageshow_session");
  if (!id) return null;
  const raw = await redis.get(`imageshow:session:${id}`);
  if (!raw) return null;
  return { id, ...(JSON.parse(raw) as { username: string; csrf: string; role: "super" | "image" }) };
}

export async function requireAuth(c: Context, next: Next) {
  const session = await getSession(c);
  if (!session) throw new ApiError(401, "unauthorized", "Unauthorized");
  c.set("session", session);
  await next();
}

export async function requireCsrf(c: Context, next: Next) {
  const session = c.get("session") as { csrf: string } | undefined;
  if (!session || c.req.header("x-csrf-token") !== session.csrf) {
    throw new ApiError(403, "csrf_invalid", "CSRF token invalid");
  }
  await next();
}

export async function requireSuper(c: Context, next: Next) {
  const session = c.get("session") as { role?: string } | undefined;
  if (session?.role !== "super") throw new ApiError(403, "forbidden", "Super admin only");
  await next();
}

export async function logout(c: Context) {
  const session = await getSession(c);
  if (session) await redis.del(`imageshow:session:${session.id}`);
  deleteCookie(c, "imageshow_session", { path: "/" });
}

export function clientIp(c: Context): string {
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}
