// HTTP helpers: typed API errors, Redis-backed session auth, CSRF and
// same-origin checks, and login rate limiting (per IP+username plus a short
// global backstop against distributed attacks).
import type { Context, Next } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import argon2 from "argon2";
import { appConfig } from "@imageshow/shared";
import { pool } from "./db.js";
import { redis } from "./redis.js";

const loginRateLimitWindowSeconds = 15 * 60;
const loginRateLimitMaxFailures = 10;
// A coarse short-window backstop that caps total login attempts across every
// client IP, so a distributed brute force cannot bypass the per-IP limiter.
const loginGlobalWindowSeconds = 60;
const loginGlobalMaxAttempts = 30;
const loginGlobalKey = "imageshow:login_fail_global";

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

export function fail(c: Context, error: unknown) {
  if (error instanceof ApiError) {
    return c.json({ ok: false, code: error.code, error: error.message, details: error.details }, error.status as never);
  }
  const anyError = error as { name?: string; message?: string };
  if (anyError?.name === "redis_unavailable") {
    return c.json({ ok: false, code: "redis_unavailable", error: "Redis unavailable", details: {} }, 503);
  }
  console.error(error);
  return c.json({ ok: false, code: "internal_error", error: "Internal server error", details: {} }, 500);
}

export function routeError(error: { status: number; message: string }, details: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = { status: error.status, message: error.message };
  if (Object.keys(details).length) payload.details = details;
  return new Response(JSON.stringify(payload, null, 2), {
    status: error.status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

export function isSecure(c: Context) {
  return c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
}

export function sameOrigin(c: Context) {
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

export async function login(c: Context, username: string, password: string) {
  if (!sameOrigin(c)) throw new ApiError(403, "origin_forbidden", "Origin forbidden");
  await reserveLoginAttempt(c, username);
  const result = await pool.query("SELECT username, password_hash FROM admin_account WHERE username = $1", [username]);
  const user = result.rows[0];
  if (!user || !(await argon2.verify(user.password_hash, password))) {
    throw new ApiError(401, "invalid_credentials", "Invalid credentials");
  }
  await clearLoginFailures(c, username);
  const sessionId = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  await redis.set(`imageshow:session:${sessionId}`, JSON.stringify({ username, csrf }), "EX", appConfig.sessionTtlSeconds);
  setCookie(c, "imageshow_session", sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isSecure(c),
    path: "/",
    maxAge: appConfig.sessionTtlSeconds
  });
  return { username, csrf_token: csrf };
}

export async function getSession(c: Context) {
  const id = getCookie(c, "imageshow_session");
  if (!id) return null;
  const raw = await redis.get(`imageshow:session:${id}`);
  if (!raw) return null;
  return { id, ...(JSON.parse(raw) as { username: string; csrf: string }) };
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

export async function logout(c: Context) {
  const session = await getSession(c);
  if (session) await redis.del(`imageshow:session:${session.id}`);
  deleteCookie(c, "imageshow_session", { path: "/" });
}

function loginRateLimitKey(c: Context, username: string) {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || c.req.header("x-real-ip") || "unknown";
  const normalizedUser = username.trim().toLowerCase().slice(0, 80) || "empty";
  return `imageshow:login_fail:${ip}:${normalizedUser}`;
}

async function reserveLoginAttempt(c: Context, username: string) {
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
    loginRateLimitWindowSeconds,
    loginGlobalWindowSeconds
  )) as [number, number];
  if (Number(counts[0]) > loginRateLimitMaxFailures || Number(counts[1]) > loginGlobalMaxAttempts) {
    throw new ApiError(429, "too_many_login_attempts", "Too many login attempts. Try again later.");
  }
}

async function clearLoginFailures(c: Context, username: string) {
  await redis.del(loginRateLimitKey(c, username));
}
