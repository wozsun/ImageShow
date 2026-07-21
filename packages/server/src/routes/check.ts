import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok, requireSuper } from "../core/http.ts";
import { inspectRedisState } from "../checks/redis-inspect.ts";
import { checkAll, checkDatabase, checkStorage, checkTrash, cleanupStorage, migrateStorageLocation } from "../checks/service.ts";

export function registerCheckRoutes(app: Hono) {
  app.use(`${adminApiBasePath}/check/*`, requireSuper);

  app.post(`${adminApiBasePath}/check/db`, async (c) => c.json(ok(await checkDatabase())));
  app.post(`${adminApiBasePath}/check/redis`, async (c) => c.json(ok(await inspectRedisState())));
  app.post(`${adminApiBasePath}/check/storage`, async (c) => c.json(ok(await checkStorage())));
  app.post(`${adminApiBasePath}/check/storage-cleanup`, async (c) => c.json(ok(await cleanupStorage())));
  app.post(`${adminApiBasePath}/check/trash`, async (c) => c.json(ok(await checkTrash())));
  app.post(`${adminApiBasePath}/check/all`, async (c) => c.json(ok(await checkAll())));

  app.post(`${adminApiBasePath}/check/migrate-storage-location`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(ok(await migrateStorageLocation(body)));
  });
}
