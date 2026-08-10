import type { Context, Next } from "hono";
import type {
  AdminLoginResultDto,
  AdminRole
} from "@imageshow/shared/browser";
import { randomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/database-pools.ts";
import { loginRateLimiter } from "../core/login-rate-limit.ts";
import { isCurrentPasswordHash, verifyPassword } from "../core/password.ts";
import { redis } from "../core/redis-client.ts";
import { assertSameOrigin, requestClientIp } from "../core/http/request-security.ts";
import { runRequiredRedisCommand } from "../core/runtime-availability.ts";
import {
  adminCredentialVersion,
  parseAdminCredentialVersions,
  type AdminCredentialTransitionVersions
} from "./session-credential.ts";
import { adminSessionKey } from "./admin-session-key.ts";

const adminSessionCookie = "imageshow_session";
const replaceCredentialTransitionSnapshotScript = `
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

type AdminSessionCredentialTransitionStore = {
  readSession(id: string): Promise<string | null>;
  replaceSessionSnapshot(
    id: string,
    expectedPayload: string,
    nextPayload: string
  ): Promise<boolean>;
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
  const credentialVersions = parseAdminCredentialVersions(
    candidate.credential_versions
  );
  if (
    Object.keys(candidate).length !== 4
    || typeof candidate.username !== "string"
    || typeof candidate.csrf !== "string"
    || (candidate.role !== "super" && candidate.role !== "image")
    || !credentialVersions
  ) return null;
  return {
    username: candidate.username,
    csrf: candidate.csrf,
    role: candidate.role,
    credential_versions: credentialVersions
  };
}

function parseStoredAdminSession(raw: string) {
  try {
    return storedAdminSession(JSON.parse(raw));
  } catch {
    return null;
  }
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

async function replaceCredentialTransitionSnapshot(
  id: string,
  expectedPayload: string,
  nextPayload: string
) {
  const replaced = await runRequiredRedisCommand(() => redis.eval(
    replaceCredentialTransitionSnapshotScript,
    1,
    adminSessionKey(id),
    expectedPayload,
    nextPayload
  ));
  return Number(replaced) === 1;
}

const adminSessionCredentialTransitionStore = {
  readSession: (id: string) => runRequiredRedisCommand(
    () => redis.get(adminSessionKey(id))
  ),
  replaceSessionSnapshot: replaceCredentialTransitionSnapshot
} satisfies AdminSessionCredentialTransitionStore;

async function deleteExistingSessionIfUnchanged(
  id: string,
  expectedPayload: string
) {
  const deleted = await runRequiredRedisCommand(() => redis.eval(
    deleteSessionIfUnchangedScript,
    1,
    adminSessionKey(id),
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
    adminSessionKey(sessionId),
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
  const stored = parseStoredAdminSession(raw);
  if (stored) {
    const credential = await readAdminAccountCredential(stored.username);
    const credentialVersion = credential
      ? adminCredentialVersion(credential.password_hash)
      : null;
    const credentialMatches = Boolean(
      credential
      && credentialVersion
      && credential.role === stored.role
      && isCurrentPasswordHash(credential.password_hash)
      && stored.credential_versions.includes(credentialVersion)
    );
    if (credentialMatches && credentialVersion) {
      return {
        id,
        username: stored.username,
        csrf: stored.csrf,
        role: stored.role
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
    () => redis.get(adminSessionKey(id))
  );
  if (!raw) return null;
  const session = await validateAdminSessionPayload(id, raw);
  if (session !== adminSessionChanged) return session;

  const changedRaw = await runRequiredRedisCommand(
    () => redis.get(adminSessionKey(id))
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
  credentialVersions: AdminCredentialTransitionVersions,
  store: AdminSessionCredentialTransitionStore = (
    adminSessionCredentialTransitionStore
  )
) {
  const currentPayload = await store.readSession(session.id);
  const stored = currentPayload
    ? parseStoredAdminSession(currentPayload)
    : null;
  const transitionAllowed = Boolean(
    stored
    && stored.username === session.username
    && stored.csrf === session.csrf
    && stored.role === session.role
    && stored.credential_versions.includes(credentialVersions[0])
  );
  if (!currentPayload || !transitionAllowed) {
    throw new ApiError(401, "unauthorized", "Administrator session expired");
  }
  const updated = await store.replaceSessionSnapshot(
    session.id,
    currentPayload,
    sessionPayload(session, credentialVersions)
  );
  if (!updated) {
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
      () => redis.del(adminSessionKey(session.id))
    );
  }
  deleteCookie(context, adminSessionCookie, { path: "/" });
}
