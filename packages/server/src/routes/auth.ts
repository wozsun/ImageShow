import type { Hono } from "hono";
import { adminApiBasePath, type AuthStateDto } from "@imageshow/shared";
import { ApiError } from "../core/api-error.ts";
import { apiSuccess } from "../core/http/responses.ts";
import { limitAdminLoginBody } from "../core/http/request-body-limit.ts";
import {
  assertSameOrigin,
  blockCrossSiteFetch
} from "../core/http/request-security.ts";
import { applicationVersion } from "../core/application-version.ts";
import { issueAltchaChallenge, verifyAltchaProof } from "../core/altcha.ts";
import { redis } from "../core/redis-client.ts";
import { parse, passwordChangeInput } from "../core/validation.ts";
import { changeAdminPassword } from "../users/admin-accounts.ts";
import {
  adminSessionRedisClient,
  invalidateAdminSessionsByUsername
} from "../users/session-invalidation.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { getEffectiveLoginBackground } from "../config/app-settings.ts";
import {
  createAdminSession,
  deleteAdminSession,
  readAdminSession
} from "../users/admin-session.ts";
import { adminPermissionsForRole } from "../users/admin-authorization.ts";

const sessionRedis = adminSessionRedisClient(redis);

export function registerPublicAuthRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/auth/challenge`, blockCrossSiteFetch, async (c) => {
    return c.json(await issueAltchaChallenge(c));
  });

  app.post(
    `${adminApiBasePath}/auth/login`,
    async (c, next) => {
      assertSameOrigin(c);
      await next();
    },
    limitAdminLoginBody,
    async (c) => {
      const body = await c.req.json().catch(() => ({}));
      await verifyAltchaProof(body.altcha);
      return c.json(apiSuccess(await createAdminSession(
        c,
        String(body.username ?? ""),
        String(body.password ?? "")
      )));
    }
  );

  app.get(`${adminApiBasePath}/auth/me`, async (c) => {
    const session = await readAdminSession(c);
    const authState = {
      authenticated: Boolean(session),
      username: session?.username ?? "",
      role: session?.role ?? "",
      permissions: session
        ? adminPermissionsForRole(session.role)
        : [],
      csrf_token: session?.csrf ?? "",
      application_version: session ? applicationVersion() : "",
      altcha_enabled: getRuntimeConfig().altcha.enabled,
      login_background: getEffectiveLoginBackground()
    } satisfies AuthStateDto;
    return c.json(apiSuccess(authState));
  });
}

export function registerProtectedAuthRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/auth/logout`, async (c) => {
    await deleteAdminSession(c);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/auth/password`, async (c) => {
    const session = await readAdminSession(c);
    if (!session) throw new ApiError(401, "unauthorized", "Unauthorized");
    const input = parse(passwordChangeInput, await c.req.json().catch(() => ({})));
    await changeAdminPassword(session.username, input.current_password, input.new_password);
    await invalidateAdminSessionsByUsername(sessionRedis, session.username, session.id);
    return c.json(apiSuccess());
  });
}
