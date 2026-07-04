import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ApiError, login, logout, ok, requireCsrf, getSession } from "../core/http.js";
import { issueCaptcha, verifyCaptcha } from "../core/captcha.js";
import { parse, passwordChangeInput } from "../core/validation.js";
import { changeOwnPassword } from "../users/service.js";
import { getRuntimeConfig } from "../config/env.js";
import { getEffectiveLoginBackground } from "../config/settings.js";

export function registerPublicAuthRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/auth/captcha`, (c) => issueCaptcha(c));

  app.post(`${adminApiBasePath}/auth/login`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    await verifyCaptcha(c, String(body.captcha ?? ""));
    const result = await login(c, String(body.username ?? ""), String(body.password ?? ""));
    return c.json(ok(result));
  });

  app.get(`${adminApiBasePath}/auth/me`, async (c) => {
    const session = await getSession(c);
    return c.json(ok({
      authenticated: Boolean(session),
      username: session?.username ?? "",
      role: session?.role ?? "",
      csrf_token: session?.csrf ?? "",
      captcha_enabled: getRuntimeConfig().captcha.enabled,
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
    return c.json(ok());
  });
}
