import type { Context, Next } from "hono";
import type {
  AdminLoginResultDto,
  AdminRole
} from "@imageshow/shared/browser";
import { randomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/db.ts";
import { loginRateLimiter } from "../core/login-rate-limit.ts";
import {
  passwordHashAdminSessionMode,
  verifyPassword
} from "../core/password.ts";
import { redis } from "../core/redis-client.ts";
import { assertSameOrigin, requestClientIp } from "../core/http/request-security.ts";
import { runRequiredRedisCommand } from "../core/runtime-availability.ts";
import {
  adminCredentialVersion,
  parseAdminCredentialVersions
} from "./session-credential.ts";

const adminSessionCookie = "imageshow_session";
const adminSessionKeyPrefix = "imageshow:session:";
const replaceSessionIfUnchangedScript = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2], 'XX', 'KEEPTTL')
return 1
`;
const deleteSessionIfUnchangedScript = `
local current = redis.call('GET', KEYS[1])
if current ~= ARGV[1] then
  return 0
end
return redis.call('UNLINK', KEYS[1])
`;

export type AdminSession = {
  id: string;
  username: string;
  csrf: string;
  role: AdminRole;
  credentialVersion: string;
};

type StoredAdminSession = {
  username: string;
  csrf: string;
  role: AdminRole;
  credential_versions: string[];
};

type AdminAccountCredential = {
  username: string;
  password_hash: string;
  role: AdminRole;
};

async function readAdminAccountCredential(
  username: string
): Promise<AdminAccountCredential | null> {
  try {
    const result = await pool.query<AdminAccountCredential>(
      `SELECT username, password_hash, role
         FROM admin_account
        WHERE username = $1`,
      [username]
    );
    return result.rows[0] ?? null;
  } catch (error) {
    throw new ApiError(
      503,
      "database_unavailable",
      "PostgreSQL unavailable",
      { dependency: "postgresql" }
    );
  }
}

function storedAdminSession(value: unknown): StoredAdminSession | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.username !== "string"
    || typeof candidate.csrf !== "string"
    || (candidate.role !== "super" && candidate.role !== "image")
  ) return null;
  return {
    username: candidate.username,
    csrf: candidate.csrf,
    role: candidate.role,
    credential_versions: parseAdminCredentialVersions(
      candidate.credential_versions
    )
  };
}

function sessionPayload(
  session: Pick<AdminSession, "username" | "csrf" | "role">,
  credentialVersions: string[]
) {
  return JSON.stringify({
    username: session.username,
    csrf: session.csrf,
    role: session.role,
    credential_versions: credentialVersions
  } satisfies StoredAdminSession);
}

async function replaceExistingSession(
  id: string,
  payload: string
) {
  return runRequiredRedisCommand(() => redis.call(
    "SET",
    `${adminSessionKeyPrefix}${id}`,
    payload,
    "XX",
    "KEEPTTL"
  ));
}

async function replaceExistingSessionIfUnchanged(
  id: string,
  expectedPayload: string,
  nextPayload: string
) {
  return runRequiredRedisCommand(() => redis.eval(
    replaceSessionIfUnchangedScript,
    1,
    `${adminSessionKeyPrefix}${id}`,
    expectedPayload,
    nextPayload
  ));
}

async function deleteExistingSessionIfUnchanged(
  id: string,
  expectedPayload: string
) {
  const deleted = await runRequiredRedisCommand(() => redis.eval(
    deleteSessionIfUnchangedScript,
    1,
    `${adminSessionKeyPrefix}${id}`,
    expectedPayload
  ));
  return Number(deleted) === 1;
}

function requestIsSecure(context: Context) {
  return context.req.header("x-forwarded-proto") === "https"
    || new URL(context.req.url).protocol === "https:";
}

export async function createAdminSession(
  context: Context,
  username: string,
  password: string
): Promise<AdminLoginResultDto> {
  assertSameOrigin(context);
  const ip = requestClientIp(context);
  await loginRateLimiter.reserve(ip, username);
  const user = await readAdminAccountCredential(username);
  if (
    !user
    || passwordHashAdminSessionMode(user.password_hash) === "invalid"
    || !(await verifyPassword(user.password_hash, password))
  ) {
    throw new ApiError(
      401,
      "invalid_credentials",
      "用户名或密码错误"
    );
  }
  const sessionId = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const sessionTtl = getRuntimeConfig().security.session_ttl_seconds;
  const credentialVersion = adminCredentialVersion(user.password_hash);
  await loginRateLimiter.clear(ip, user.username);
  await runRequiredRedisCommand(() => redis.set(
    `${adminSessionKeyPrefix}${sessionId}`,
    sessionPayload(
      { username: user.username, csrf, role: user.role },
      [credentialVersion]
    ),
    "EX",
    sessionTtl
  ));
  setCookie(context, adminSessionCookie, sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    secure: requestIsSecure(context),
    path: "/",
    maxAge: sessionTtl
  });
  return { csrf_token: csrf };
}

const adminSessionChanged = Symbol("admin-session-changed");

async function validateAdminSessionPayload(id: string, raw: string): Promise<
  AdminSession | null | typeof adminSessionChanged
> {
  let stored: StoredAdminSession | null = null;
  try {
    stored = storedAdminSession(JSON.parse(raw));
  } catch {
    stored = null;
  }
  if (stored) {
    const credential = await readAdminAccountCredential(stored.username);
    const passwordHashMode = credential
      ? passwordHashAdminSessionMode(credential.password_hash)
      : "invalid";
    const credentialVersion = credential
      ? adminCredentialVersion(credential.password_hash)
      : null;
    const credentialMatches = Boolean(
      credential
      && credentialVersion
      && credential.role === stored.role
      && passwordHashMode !== "invalid"
      && !(
        stored.credential_versions.length === 0
        && passwordHashMode === "bound"
      )
      && !(
        stored.credential_versions.length > 0
        && !stored.credential_versions.includes(credentialVersion)
      )
    );
    if (credentialMatches && credentialVersion) {
      if (stored.credential_versions.length === 0) {
        const replaced = await replaceExistingSessionIfUnchanged(
          id,
          raw,
          sessionPayload(stored, [credentialVersion])
        );
        if (Number(replaced) !== 1) return adminSessionChanged;
      }
      return {
        id,
        username: stored.username,
        csrf: stored.csrf,
        role: stored.role,
        credentialVersion
      };
    }
  }
  return await deleteExistingSessionIfUnchanged(id, raw)
    ? null
    : adminSessionChanged;
}

export async function readAdminSession(
  context: Context
): Promise<AdminSession | null> {
  const id = getCookie(context, adminSessionCookie);
  if (!id) return null;
  const raw = await runRequiredRedisCommand(
    () => redis.get(`${adminSessionKeyPrefix}${id}`)
  );
  if (!raw) return null;
  const session = await validateAdminSessionPayload(id, raw);
  if (session !== adminSessionChanged) return session;

  const changedRaw = await runRequiredRedisCommand(
    () => redis.get(`${adminSessionKeyPrefix}${id}`)
  );
  if (!changedRaw) return null;
  const retried = await validateAdminSessionPayload(id, changedRaw);
  if (retried !== adminSessionChanged) return retried;
  throw new ApiError(
    503,
    "session_changed",
    "Administrator session changed; retry request"
  );
}

export async function authorizeAdminSessionCredentialTransition(
  session: AdminSession,
  nextCredentialVersion: string
) {
  const updated = await replaceExistingSession(
    session.id,
    sessionPayload(session, [
      session.credentialVersion,
      nextCredentialVersion
    ])
  );
  if (updated !== "OK") {
    throw new ApiError(401, "unauthorized", "Administrator session expired");
  }
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
  const session = (context.get("session") as AdminSession | undefined)
    ?? await readAdminSession(context);
  if (session) {
    await runRequiredRedisCommand(
      () => redis.del(`${adminSessionKeyPrefix}${session.id}`)
    );
  }
  deleteCookie(context, adminSessionCookie, { path: "/" });
}
