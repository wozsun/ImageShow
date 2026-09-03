import type { Context, Next } from "hono";
import type {
  AdminLoginResultDto,
  AdminRole
} from "@imageshow/shared/browser";
import { randomBytes } from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/database/pools.ts";
import { loginRateLimiter } from "../core/login-rate-limit.ts";
import { isCurrentPasswordHash, verifyPassword } from "../core/password.ts";
import { redis } from "../core/redis/client.ts";
import {
  deleteRedisStringIfEqual,
  refreshRedisStringTtlIfEqual,
  replaceRedisStringIfEqualKeepingTtl
} from "../core/redis/conditional-string.ts";
import {
  assertSameOrigin,
  requestClientIp,
  requestIsSecure
} from "../core/http/request-security.ts";
import { runRequiredRedisCommand } from "../core/runtime-availability.ts";
import {
  adminCredentialVersion,
  parseAdminCredentialVersions,
  type AdminCredentialTransitionVersions
} from "./session-credential.ts";
import { adminSessionKey } from "./admin-session-key.ts";
import { closeAdminSessionConnections } from "./admin-session-connections.ts";

const adminSessionCookie = "imageshow_session";

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

function setAdminSessionCookie(
  context: Context,
  sessionId: string,
  sessionTtl: number
) {
  setCookie(context, adminSessionCookie, sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    secure: requestIsSecure(context),
    path: "/",
    maxAge: sessionTtl
  });
}

async function replaceCredentialTransitionSnapshot(
  id: string,
  expectedPayload: string,
  nextPayload: string
) {
  return runRequiredRedisCommand(() => replaceRedisStringIfEqualKeepingTtl(
    redis,
    adminSessionKey(id),
    expectedPayload,
    nextPayload
  ));
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
  return runRequiredRedisCommand(() => deleteRedisStringIfEqual(
    redis,
    adminSessionKey(id),
    expectedPayload
  ));
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
  setAdminSessionCookie(context, sessionId, sessionTtl);
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

/** Read and validate one stable Redis snapshot without changing its TTL. */
async function validateAdminSessionSnapshotById(
  id: string
): Promise<Readonly<{ session: AdminSession; payload: string }> | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const raw = await runRequiredRedisCommand(
      () => redis.get(adminSessionKey(id))
    );
    if (!raw) return null;
    const session = await validateAdminSessionPayload(id, raw);
    if (session === adminSessionChanged) continue;
    return session ? { session, payload: raw } : null;
  }
  throw new ApiError(
    503,
    "session_changed",
    "Administrator session changed; retry request"
  );
}

/**
 * Validate through the same Redis + PostgreSQL authority as HTTP middleware.
 * Long-lived transports use this non-renewing path for auth heartbeats.
 */
export async function validateAdminSessionById(
  id: string
): Promise<AdminSession | null> {
  return (await validateAdminSessionSnapshotById(id))?.session ?? null;
}

async function readAdminSession(
  context: Context
): Promise<AdminSession | null> {
  const id = getCookie(context, adminSessionCookie);
  return id ? validateAdminSessionById(id) : null;
}

type AdminSessionProbe = Readonly<{
  session: AdminSession;
  renew: () => Promise<void>;
}>;

/** Prepare the explicit /auth/me probe without renewing an incomplete read. */
export async function readAdminSessionProbe(
  context: Context
): Promise<AdminSessionProbe | null> {
  const id = getCookie(context, adminSessionCookie);
  if (!id) return null;

  const snapshot = await validateAdminSessionSnapshotById(id);
  if (!snapshot) return null;
  return {
    session: snapshot.session,
    renew: async () => {
      const sessionTtl = getRuntimeConfig().security.session_ttl_seconds;
      const renewed = await runRequiredRedisCommand(
        () => refreshRedisStringTtlIfEqual(
          redis,
          adminSessionKey(id),
          snapshot.payload,
          sessionTtl
        )
      );
      if (!renewed) {
        throw new ApiError(
          503,
          "session_changed",
          "Administrator session changed; retry request"
        );
      }
      setAdminSessionCookie(context, id, sessionTtl);
    }
  };
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
    closeAdminSessionConnections([session.id]);
  }
  deleteCookie(context, adminSessionCookie, { path: "/" });
}
