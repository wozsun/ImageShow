import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { apiSuccess } from "../core/http/responses.ts";
import { requireSuperAdmin } from "../users/admin-authorization.ts";
import { redis } from "../core/redis-client.ts";
import { adminUsernameInput } from "../core/credentials.ts";
import { parse, userCreateInput, userPasswordInput } from "../core/validation.ts";
import {
  createImageAdmin,
  deleteImageAdmin,
  listAdminAccounts,
  resetImageAdminPassword
} from "../users/admin-accounts.ts";
import {
  adminSessionRedisClient,
  invalidateAdminSessionsByUsername
} from "../users/session-invalidation.ts";

const sessionRedis = adminSessionRedisClient(redis);

export function registerAdminUserRoutes(app: Hono) {
  app.use(`${adminApiBasePath}/users`, requireSuperAdmin);
  app.use(`${adminApiBasePath}/users/*`, requireSuperAdmin);

  app.get(`${adminApiBasePath}/users`, async (c) => c.json(apiSuccess({ items: await listAdminAccounts() })));

  app.post(`${adminApiBasePath}/users`, async (c) => {
    const input = parse(userCreateInput, await c.req.json().catch(() => ({})));
    await createImageAdmin(input.username, input.password);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/users/:username/password`, async (c) => {
    const username = parse(adminUsernameInput, c.req.param("username"));
    const input = parse(userPasswordInput, await c.req.json().catch(() => ({})));
    await resetImageAdminPassword(username, input.password);
    await invalidateAdminSessionsByUsername(sessionRedis, username);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/users/:username/delete`, async (c) => {
    const username = parse(adminUsernameInput, c.req.param("username"));
    await deleteImageAdmin(username);
    await invalidateAdminSessionsByUsername(sessionRedis, username);
    return c.json(apiSuccess());
  });
}
