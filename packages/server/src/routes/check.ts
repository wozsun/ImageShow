import type { Hono } from "hono";
import {
  adminApiBasePath,
  adminPermissions
} from "@imageshow/shared/browser";
import { apiSuccess } from "../core/http/responses.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import { inspectRedisState } from "../checks/redis-inspect.ts";
import { checkDatabase } from "../checks/database-check.ts";
import { maintainStorage } from "../checks/storage-maintenance.ts";
import { checkStorage } from "../checks/storage-check.ts";
import { checkSystemState } from "../checks/system-summary.ts";
import { readAdminCheckStatus } from "../checks/lightweight-status.ts";

export function registerCheckRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/check/status`, async (c) => (
    c.json(apiSuccess(await readAdminCheckStatus()))
  ));
  app.post(`${adminApiBasePath}/check/db`, async (c) => c.json(apiSuccess(await checkDatabase())));
  app.post(`${adminApiBasePath}/check/redis`, async (c) => c.json(apiSuccess(
    await inspectRedisState(c.req.raw.signal)
  )));
  app.post(`${adminApiBasePath}/check/storage`, async (c) => c.json(apiSuccess(await checkStorage(c.req.raw.signal))));
  app.post(
    `${adminApiBasePath}/check/storage-maintenance`,
    requireAdminPermission(adminPermissions.storageMaintenanceExecute),
    async (c) => c.json(apiSuccess(await maintainStorage(c.req.raw.signal)))
  );
  app.post(`${adminApiBasePath}/check/all`, async (c) => c.json(apiSuccess(
    await checkSystemState(c.req.raw.signal)
  )));
}
