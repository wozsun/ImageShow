import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { apiSuccess } from "../core/http/responses.ts";
import { requireSuperAdmin } from "../users/admin-authorization.ts";
import { inspectRedisState } from "../checks/redis-inspect.ts";
import { checkDatabase, checkTrash } from "../checks/database-check.ts";
import { cleanupStorage } from "../checks/storage-cleanup.ts";
import { checkStorage } from "../checks/storage-check.ts";
import { migrateStorageLocation } from "../checks/storage-migrate.ts";
import { checkSystemState } from "../checks/system-summary.ts";

export function registerCheckRoutes(app: Hono) {
  app.use(`${adminApiBasePath}/check/*`, requireSuperAdmin);

  app.post(`${adminApiBasePath}/check/db`, async (c) => c.json(apiSuccess(await checkDatabase())));
  app.post(`${adminApiBasePath}/check/redis`, async (c) => c.json(apiSuccess(await inspectRedisState())));
  app.post(`${adminApiBasePath}/check/storage`, async (c) => c.json(apiSuccess(await checkStorage())));
  app.post(`${adminApiBasePath}/check/storage-cleanup`, async (c) => c.json(apiSuccess(await cleanupStorage())));
  app.post(`${adminApiBasePath}/check/trash`, async (c) => c.json(apiSuccess(await checkTrash())));
  app.post(`${adminApiBasePath}/check/all`, async (c) => c.json(apiSuccess(await checkSystemState())));

  app.post(`${adminApiBasePath}/check/migrate-storage-location`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(apiSuccess(await migrateStorageLocation(body)));
  });
}
