import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { login, logout, ok, requireCsrf, getSession } from "../core/http.js";

export function registerPublicAuthRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/auth/login`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await login(c, String(body.username ?? ""), String(body.password ?? ""));
    return c.json(ok(result));
  });

  app.get(`${adminApiBasePath}/auth/me`, async (c) => {
    const session = await getSession(c);
    return c.json(ok({ authenticated: Boolean(session), username: session?.username ?? "", csrf_token: session?.csrf ?? "" }));
  });
}

export function registerProtectedAuthRoutes(app: Hono) {
  app.post(`${adminApiBasePath}/auth/logout`, requireCsrf, async (c) => {
    await logout(c);
    return c.json(ok());
  });
}
