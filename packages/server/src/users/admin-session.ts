import type { Context, Next } from "hono";
import type { AdminRole } from "@imageshow/shared";
import { randomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { loginRateLimiter } from "../core/login-rate-limit.ts";
import { verifyPassword } from "../core/password.ts";
import { redis } from "../core/redis-client.ts";
import { assertSameOrigin, requestClientIp } from "../core/http/request-security.ts";

const adminSessionCookie = "imageshow_session";
const adminSessionKeyPrefix = "imageshow:session:";

type AdminSession = {
  id: string;
  username: string;
  csrf: string;
  role: AdminRole;
};

function requestIsSecure(context: Context) {
  return context.req.header("x-forwarded-proto") === "https"
    || new URL(context.req.url).protocol === "https:";
}

export async function createAdminSession(
  context: Context,
  username: string,
  password: string
) {
  assertSameOrigin(context);
  const ip = requestClientIp(context);
  await loginRateLimiter.reserve(ip, username);
  const result = await pool.query(
    "SELECT username, password_hash, role FROM admin_account WHERE username = $1",
    [username]
  );
  const user = result.rows[0] as {
    username: string;
    password_hash: string;
    role: AdminRole;
  } | undefined;
  if (!user || !(await verifyPassword(user.password_hash, password))) {
    throw new ApiError(
      401,
      "invalid_credentials",
      "用户名或密码错误"
    );
  }
  await loginRateLimiter.clear(ip, username);
  const sessionId = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const sessionTtl = getRuntimeConfig().security.session_ttl_seconds;
  await redis.set(
    `${adminSessionKeyPrefix}${sessionId}`,
    JSON.stringify({ username, csrf, role: user.role }),
    "EX",
    sessionTtl
  );
  setCookie(context, adminSessionCookie, sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    secure: requestIsSecure(context),
    path: "/",
    maxAge: sessionTtl
  });
  return { csrf_token: csrf };
}

export async function readAdminSession(
  context: Context
): Promise<AdminSession | null> {
  const id = getCookie(context, adminSessionCookie);
  if (!id) return null;
  const raw = await redis.get(`${adminSessionKeyPrefix}${id}`);
  if (!raw) return null;
  return {
    id,
    ...(JSON.parse(raw) as Omit<AdminSession, "id">)
  };
}

export async function requireAdminSession(context: Context, next: Next) {
  const session = await readAdminSession(context);
  if (!session) throw new ApiError(401, "unauthorized", "Unauthorized");
  context.set("session", session);
  await next();
}

export async function requireAdminCsrf(context: Context, next: Next) {
  const session = context.get("session") as { csrf: string } | undefined;
  if (!session || context.req.header("x-csrf-token") !== session.csrf) {
    throw new ApiError(403, "csrf_invalid", "CSRF token invalid");
  }
  await next();
}

export async function deleteAdminSession(context: Context) {
  const session = await readAdminSession(context);
  if (session) await redis.del(`${adminSessionKeyPrefix}${session.id}`);
  deleteCookie(context, adminSessionCookie, { path: "/" });
}
