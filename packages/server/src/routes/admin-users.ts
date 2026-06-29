import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok, requireSuper } from "../core/http.js";
import { adminUsernameInput, parse, userCreateInput, userPasswordInput } from "../core/validation.js";
import { createImageAdmin, deleteUser, listAdminUsers, resetUserPassword } from "../users/service.js";

// Thin HTTP layer for admin-account management; all logic lives in users/service.ts.
export function registerAdminUserRoutes(app: Hono) {
  // Everything under /users is super-admin only (runs after the global requireAuth).
  app.use(`${adminApiBasePath}/users`, requireSuper);
  app.use(`${adminApiBasePath}/users/*`, requireSuper);

  app.get(`${adminApiBasePath}/users`, async (c) => c.json(ok({ items: await listAdminUsers() })));

  app.post(`${adminApiBasePath}/users`, async (c) => {
    const input = parse(userCreateInput, await c.req.json().catch(() => ({})));
    await createImageAdmin(input.username, input.password);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/users/:username/password`, async (c) => {
    const username = parse(adminUsernameInput, c.req.param("username"));
    const input = parse(userPasswordInput, await c.req.json().catch(() => ({})));
    await resetUserPassword(username, input.password);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/users/:username/delete`, async (c) => {
    const username = parse(adminUsernameInput, c.req.param("username"));
    await deleteUser(username);
    return c.json(ok());
  });
}
