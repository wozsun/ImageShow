import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok, requireSuper } from "../core/http.ts";
import { redis } from "../core/redis-client.ts";
import { adminUsernameInput, parse, userCreateInput, userPasswordInput } from "../core/validation.ts";
import { createImageAdminUser, deleteAdminUser, listAdminUsers, resetUserPassword } from "../users/service.ts";
import {
  adminSessionRedisClient,
  invalidateAdminSessionsByUsername
} from "../users/session-invalidation.ts";

const sessionRedis = adminSessionRedisClient(redis);

export function registerAdminUserRoutes(app: Hono) {
  app.use(`${adminApiBasePath}/users`, requireSuper);
  app.use(`${adminApiBasePath}/users/*`, requireSuper);

  app.get(`${adminApiBasePath}/users`, async (c) => c.json(ok({ items: await listAdminUsers() })));

  app.post(`${adminApiBasePath}/users`, async (c) => {
    const input = parse(userCreateInput, await c.req.json().catch(() => ({})));
    await createImageAdminUser(input.username, input.password);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/users/:username/password`, async (c) => {
    const username = parse(adminUsernameInput, c.req.param("username"));
    const input = parse(userPasswordInput, await c.req.json().catch(() => ({})));
    await resetUserPassword(username, input.password);
    await invalidateAdminSessionsByUsername(sessionRedis, username);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/users/:username/delete`, async (c) => {
    const username = parse(adminUsernameInput, c.req.param("username"));
    await deleteAdminUser(username);
    await invalidateAdminSessionsByUsername(sessionRedis, username);
    return c.json(ok());
  });
}
