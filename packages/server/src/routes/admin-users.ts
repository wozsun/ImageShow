import type { Hono } from "hono";
import {
  adminApiBasePath,
  type AdminUsersResponseDto
} from "@imageshow/shared/browser";
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
  invalidateCommittedAdminSessionsByUsername
} from "../users/session-invalidation.ts";

const sessionRedis = adminSessionRedisClient(redis);

export function registerAdminUserRoutes(app: Hono) {
  app.use(`${adminApiBasePath}/users`, requireSuperAdmin);
  app.use(`${adminApiBasePath}/users/*`, requireSuperAdmin);

  app.get(`${adminApiBasePath}/users`, async (c) => {
    const response = {
      items: await listAdminAccounts()
    } satisfies AdminUsersResponseDto;
    return c.json(apiSuccess(response));
  });

  app.post(`${adminApiBasePath}/users`, async (c) => {
    const input = parse(userCreateInput, await c.req.json().catch(() => ({})));
    await createImageAdmin(input.username, input.password);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/users/:username/password`, async (c) => {
    const username = parse(adminUsernameInput, c.req.param("username"));
    const input = parse(userPasswordInput, await c.req.json().catch(() => ({})));
    const validCredentialVersion = await resetImageAdminPassword(
      username,
      input.password
    );
    await invalidateCommittedAdminSessionsByUsername(sessionRedis, username, {
      operation: "password_reset",
      validCredentialVersion
    });
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/users/:username/delete`, async (c) => {
    const username = parse(adminUsernameInput, c.req.param("username"));
    await deleteImageAdmin(username);
    await invalidateCommittedAdminSessionsByUsername(sessionRedis, username, {
      operation: "account_delete"
    });
    return c.json(apiSuccess());
  });
}
