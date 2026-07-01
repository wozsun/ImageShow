// HTTP helpers: typed API errors, Redis-backed session auth, CSRF and
// same-origin checks, and login rate limiting (per IP+username plus a short
// global backstop against distributed attacks).
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { getRuntimeConfig } from "../config/env.js";
import { pool } from "./db.js";
import { redis } from "./redis.js";
import { logger } from "./logger.js";

// Login rate-limit thresholds/windows are file-only runtime config (config.json security.*,
// defaults in appConfig.runtimeDefaults.security); only the Redis key for the global backstop is fixed here.
const loginGlobalKey = "imageshow:login_fail_global";

// Security headers applied to every response. object-src/base-uri/frame-ancestors are safe
// everywhere and are what make the CSP actually mitigate XSS / clickjacking; the HTML document
// tightens script-src further (see spaDocumentHeaders) — that can't be global because the
// bundled docs site (VitePress) ships inline scripts a strict script-src would block.
export const securityHeaders: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy": "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
};

// Headers for the SPA's own HTML document. Its markup carries no inline scripts (Vite emits
// external /assets/*.js), so script-src 'self' locks scripting to same-origin without breaking
// the app. Trusted Types ships Report-Only for now: the app has no innerHTML sinks, so DOM-sink
// violations get reported (not blocked) until the policy can be flipped to enforce safely.
export const spaDocumentHeaders: Record<string, string> = {
  ...securityHeaders,
  "Content-Security-Policy": "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  "Content-Security-Policy-Report-Only": "require-trusted-types-for 'script'"
};

// Cache-Control values shared by the SPA and docs responses: HTML is always revalidated;
// hashed immutable assets are cached for a year.
export const noCacheControl = "no-cache";
export const immutableCacheControl = "public, max-age=31536000, immutable";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: unknown = {}
  ) {
    super(message);
  }
}

export function ok(data: Record<string, unknown> = {}) {
  return { ok: true, ...data };
}

// Pulls a human-readable message out of an unknown thrown value (Error or otherwise),
// for logging or recording in a result/failure entry.
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function fail(c: Context, error: unknown) {
  if (error instanceof ApiError) {
    return c.json({ ok: false, code: error.code, error: error.message, details: error.details }, error.status as never);
  }
  const anyError = error as { name?: string; message?: string };
  if (anyError?.name === "redis_unavailable") {
    return c.json({ ok: false, code: "redis_unavailable", error: "Redis unavailable", details: {} }, 503);
  }
  // Genuine unexpected failures only — ApiError (4xx) and redis_unavailable returned above are
  // expected and stay out of the log.
  logger.error(`unhandled ${c.req.method} ${new URL(c.req.url).pathname}`, error);
  return c.json({ ok: false, code: "internal_error", error: "Internal server error", details: {} }, 500);
}

// Default machine-readable code for a status, used when a route doesn't supply one.
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

// Builds a direct Response for the middleware/random paths that can't throw an
// ApiError. Emits the same { ok:false, code, error, details } envelope as fail(),
// so every JSON error the API returns has one consistent shape.
export function routeError(error: { status: number; message: string; code?: string }, details: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = { ok: false, code: error.code ?? codeForStatus(error.status), error: error.message };
  if (Object.keys(details).length) payload.details = details;
  return new Response(JSON.stringify(payload), {
    status: error.status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export function isSecure(c: Context) {
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

// Fetch Metadata cross-origin gate for the SPA's own read endpoints. Browsers send Sec-Fetch-Site
// and page scripts can't forge it (a forbidden header), so blocking "cross-site" / "same-site"
// refuses another origin fetching or embedding our JSON, while "same-origin", "none" (direct nav)
// and an absent header (old / non-browser clients) still pass — nothing legitimate breaks. It's a
// cross-origin guard, not an anti-scrape wall: omitting the header still gets through (see robots.txt).
export function blockCrossSiteFetch(c: Context, next: Next) {
  const site = c.req.header("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") {
    throw new ApiError(403, "cross_origin_forbidden", "Cross-origin request forbidden");
  }
  return next();
}

export async function login(c: Context, username: string, password: string) {
  if (!sameOrigin(c)) throw new ApiError(403, "origin_forbidden", "Origin forbidden");
  await reserveLoginAttempt(c, username);
  const result = await pool.query("SELECT username, password_hash, role FROM admin_account WHERE username = $1", [username]);
  const user = result.rows[0];
  if (!user || !(await argon2.verify(user.password_hash, password))) {
    throw new ApiError(401, "invalid_credentials", "Invalid credentials");
  }
  await clearLoginFailures(c, username);
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
  return { username, csrf_token: csrf, role: user.role as "super" | "image" };
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

// Gate for super-admin-only routes (user management, settings writes). Runs after
// requireAuth, which puts the session — including its role — on the context.
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

// Best-effort client IP from the proxy headers (nginx sets X-Forwarded-For /
// X-Real-IP); "unknown" when absent. Used for per-client login rate limiting and
// the random API's short-term no-repeat history.
export function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || c.req.header("x-real-ip") || "unknown";
}

function loginRateLimitKey(c: Context, username: string) {
  const normalizedUser = username.trim().toLowerCase().slice(0, 80) || "empty";
  return `imageshow:login_fail:${clientIp(c)}:${normalizedUser}`;
}

async function reserveLoginAttempt(c: Context, username: string) {
  const limits = getRuntimeConfig().security;
  const key = loginRateLimitKey(c, username);
  const counts = (await redis.eval(
    `local function bump(name, ttl)
       local total = redis.call('INCR', name)
       local remaining = redis.call('TTL', name)
       if total == 1 or remaining < 0 then redis.call('EXPIRE', name, ttl) end
       return total
     end
     return { bump(KEYS[1], ARGV[1]), bump(KEYS[2], ARGV[2]) }`,
    2,
    key,
    loginGlobalKey,
    limits.login_failure_window_seconds,
    limits.login_global_window_seconds
  )) as [number, number];
  if (Number(counts[0]) > limits.login_max_failures || Number(counts[1]) > limits.login_global_max_attempts) {
    throw new ApiError(429, "too_many_login_attempts", "Too many login attempts. Try again later.");
  }
}

async function clearLoginFailures(c: Context, username: string) {
  await redis.del(loginRateLimitKey(c, username));
}
