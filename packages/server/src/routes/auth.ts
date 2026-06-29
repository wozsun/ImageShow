import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ApiError, login, logout, ok, requireCsrf, getSession } from "../core/http.js";
import { issueCaptcha, verifyCaptcha } from "../core/captcha.js";
import { parse, passwordChangeInput } from "../core/validation.js";
import { changeOwnPassword } from "../users/service.js";

// Thin HTTP layer for admin auth; session/login/logout logic lives in core/http.ts.
export function registerPublicAuthRoutes(app: Hono) {
  // Login captcha image (public, registered before the requireAuth middleware). Each GET
  // issues a fresh one-time challenge and sets the captcha cookie.
  app.get(`${adminApiBasePath}/auth/captcha`, (c) => issueCaptcha(c));

  app.post(`${adminApiBasePath}/auth/login`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    await verifyCaptcha(c, String(body.captcha ?? ""));
    const result = await login(c, String(body.username ?? ""), String(body.password ?? ""));
    return c.json(ok(result));
  });

  app.get(`${adminApiBasePath}/auth/me`, async (c) => {
    const session = await getSession(c);
    return c.json(ok({ authenticated: Boolean(session), username: session?.username ?? "", role: session?.role ?? "", csrf_token: session?.csrf ?? "" }));
  });
}

export function registerProtectedAuthRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/auth/logout`, requireCsrf, async (c) => {
    await logout(c);
    return c.json(ok());
  });

  // Self-service password change for the current session's account (any role). Verifies the
  // current password and applies the new one; the session itself stays valid.
  app.post(`${adminApiBasePath}/auth/password`, requireCsrf, async (c) => {
    const session = await getSession(c);
    if (!session) throw new ApiError(401, "unauthorized", "Unauthorized");
    const input = parse(passwordChangeInput, await c.req.json().catch(() => ({})));
    await changeOwnPassword(session.username, input.current_password, input.new_password);
    return c.json(ok());
  });
}
