import type { Context, Hono } from "hono";
import { z } from "zod";
import { adminApiBasePath, type AuthStateDto } from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import {
  apiSuccess,
  apiSuccessEtag
} from "../core/http/responses.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { limitAdminLoginBody } from "../core/http/request-body-limit.ts";
import {
  assertSameOrigin,
  blockCrossSiteFetch
} from "../core/http/request-security.ts";
import { applicationVersion } from "../core/application-version.ts";
import { issueAltchaChallenge, verifyAltchaProof } from "../core/altcha.ts";
import { redis } from "../core/redis/client.ts";
import { parse } from "./validation/parse.ts";
import { passwordChangeInput } from "./validation/users.ts";
import { changeAdminPassword } from "../users/admin-accounts.ts";
import {
  adminSessionRedisClient,
  invalidateCommittedAdminSessionsByUsername
} from "../users/session-invalidation.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { getEffectiveLoginBackground } from "../config/app-settings.ts";
import {
  createAdminSession,
  deleteAdminSession,
  readAdminSession,
  authorizeAdminSessionCredentialTransition,
  type AdminSession
} from "../users/admin-session.ts";
import { adminPermissionsForRole } from "../users/admin-authorization.ts";
import { readAdminPreferences } from "../users/preferences.ts";

const sessionRedis = adminSessionRedisClient(redis);
const adminLoginInput = z.strictObject({
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(128),
  altcha: z.unknown().optional()
});

function authenticatedSession(context: Context) {
  return context.get("session") as AdminSession | undefined;
}

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
      const body = parse(adminLoginInput, await readJsonBody(c));
      await verifyAltchaProof(body.altcha);
      return c.json(apiSuccess(await createAdminSession(
        c,
        body.username,
        body.password
      )));
    }
  );

  app.get(`${adminApiBasePath}/auth/me`, async (c) => {
    const session = await readAdminSession(c);
    const runtime = getRuntimeConfig();
    if (!session) {
      const authState = {
        authenticated: false,
        altcha_enabled: runtime.altcha.enabled,
        login_background: getEffectiveLoginBackground()
      } satisfies AuthStateDto;
      return c.json(apiSuccess(authState));
    }

    const preferences = await readAdminPreferences(session.username);
    const authState = {
      authenticated: true,
      username: session.username,
      role: session.role,
      permissions: adminPermissionsForRole(session.role),
      csrf_token: session.csrf,
      application_version: applicationVersion(),
      preferences,
      preferences_etag: apiSuccessEtag({ preferences }),
      version_settings: runtime.site.version
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
    const session = authenticatedSession(c);
    if (!session) throw new ApiError(401, "unauthorized", "Unauthorized");
    const input = parse(passwordChangeInput, await readJsonBody(c));
    const [
      staleCredentialVersion,
      validCredentialVersion
    ] = await changeAdminPassword(
      session.username,
      input.current_password,
      input.new_password,
      (credentialVersions) => authorizeAdminSessionCredentialTransition(
        session,
        credentialVersions
      )
    );
    await invalidateCommittedAdminSessionsByUsername(
      sessionRedis,
      session.username,
      {
        operation: "password_change",
        preservedSessionId: session.id,
        staleCredentialVersion,
        validCredentialVersion
      }
    );
    return c.json(apiSuccess());
  });
}
