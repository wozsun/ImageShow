import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import {
  ApiError,
  assertSameOrigin,
  blockCrossSiteFetch,
  getSession,
  login,
  logout,
  ok,
  requireCsrf
} from "../core/http.ts";
import { issueAltchaChallenge, verifyAltchaProof } from "../core/altcha.ts";
import { redis } from "../core/redis-client.ts";
import { parse, passwordChangeInput } from "../core/validation.ts";
import { changeOwnPassword } from "../users/service.ts";
import {
  adminSessionRedisClient,
  invalidateAdminSessionsByUsername
} from "../users/session-invalidation.ts";
import { getRuntimeConfig } from "../config/runtime-config-store.ts";
import { getEffectiveLoginBackground } from "../config/app-settings.ts";

const sessionRedis = adminSessionRedisClient(redis);

export function registerPublicAuthRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/auth/challenge`, blockCrossSiteFetch, async (c) => {
    return c.json(await issueAltchaChallenge(c));
  });

  app.post(`${adminApiBasePath}/auth/login`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    assertSameOrigin(c);
    await verifyAltchaProof(body.altcha);
    return c.json(ok(await login(
      c,
      String(body.username ?? ""),
      String(body.password ?? "")
    )));
  });

  app.get(`${adminApiBasePath}/auth/me`, async (c) => {
    const session = await getSession(c);
    return c.json(ok({
      authenticated: Boolean(session),
      username: session?.username ?? "",
      role: session?.role ?? "",
      csrf_token: session?.csrf ?? "",
      altcha_enabled: getRuntimeConfig().altcha.enabled,
      login_background: getEffectiveLoginBackground()
    }));
  });
}

export function registerProtectedAuthRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/auth/logout`, requireCsrf, async (c) => {
    await logout(c);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/auth/password`, requireCsrf, async (c) => {
    const session = await getSession(c);
    if (!session) throw new ApiError(401, "unauthorized", "Unauthorized");
    const input = parse(passwordChangeInput, await c.req.json().catch(() => ({})));
    await changeOwnPassword(session.username, input.current_password, input.new_password);
    await invalidateAdminSessionsByUsername(sessionRedis, session.username, session.id);
    return c.json(ok());
  });
}
