import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok, requireSuper } from "../core/http.js";
import { inspectRedisState } from "../core/redis-inspect.js";
import { backfillMissingMd5 } from "../jobs/maintenance.js";
import { checkAll, checkDatabase, checkStorage, checkTrash, cleanupStorage, migrateStorageLocation, migrateStoragePaths, repairDatabase } from "../checks/service.js";

// Thin HTTP layer for the admin maintenance/diagnostics endpoints; the reconciliation
// and migration logic lives in checks/service.ts (plus redis-inspect.ts and
// jobs/maintenance.ts for the two direct delegates).
export function registerCheckRoutes(app: Hono) {
  // Diagnostics + destructive maintenance (storage cleanup / migration) are super-admin
  // only; image admins can't reach the check page or call these endpoints.
  app.use(`${adminApiBasePath}/check/*`, requireSuper);

  app.post(`${adminApiBasePath}/check/db`, async (c) => c.json(ok(await checkDatabase())));

  app.post(`${adminApiBasePath}/check/db-repair`, async (c) => c.json(ok(await repairDatabase())));

  app.post(`${adminApiBasePath}/check/redis`, async (c) => c.json(ok(await inspectRedisState())));

  app.post(`${adminApiBasePath}/check/storage`, async (c) => c.json(ok(await checkStorage())));

  app.post(`${adminApiBasePath}/check/storage-cleanup`, async (c) => c.json(ok(await cleanupStorage())));

  app.post(`${adminApiBasePath}/check/trash`, async (c) => c.json(ok(await checkTrash())));

  app.post(`${adminApiBasePath}/check/all`, async (c) => c.json(ok(await checkAll())));

  app.post(`${adminApiBasePath}/check/backfill-md5`, async (c) => {
    const result = await backfillMissingMd5();
    return c.json(ok({ backfilled: result.processed }));
  });

  app.post(`${adminApiBasePath}/check/migrate-storage-location`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(ok(await migrateStorageLocation(body)));
  });

  app.post(`${adminApiBasePath}/check/migrate-storage-paths`, async (c) => c.json(ok(await migrateStoragePaths())));
}
