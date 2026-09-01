import type { Hono } from "hono";
import {
  adminApiBasePath,
  adminPermissions,
  type TrashPurgeMaintenanceResponseDto
} from "@imageshow/shared/browser";
import { apiSuccess } from "../core/http/responses.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { trashPurgeMaintenanceInput } from "./validation/images.ts";
import { parse } from "./validation/parse.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import { inspectRedisState } from "../checks/redis-inspect.ts";
import { checkDatabase, checkTrash } from "../checks/database-check.ts";
import { maintainStorage } from "../checks/storage-maintenance.ts";
import { checkStorage } from "../checks/storage-check.ts";
import { checkSystemState } from "../checks/system-summary.ts";
import { readAdminCheckStatus } from "../checks/lightweight-status.ts";
import { maintainTrashPurge } from "../images/trash-purge-maintenance.ts";

export function registerCheckRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/check/status`, async (c) => (
    c.json(apiSuccess(await readAdminCheckStatus()))
  ));
  app.post(`${adminApiBasePath}/check/db`, async (c) => c.json(apiSuccess(await checkDatabase())));
  app.post(`${adminApiBasePath}/check/trash`, async (c) => c.json(apiSuccess(await checkTrash())));
  app.post(`${adminApiBasePath}/check/redis`, async (c) => c.json(apiSuccess(
    await inspectRedisState(c.req.raw.signal)
  )));
  app.post(`${adminApiBasePath}/check/storage`, async (c) => c.json(apiSuccess(await checkStorage(c.req.raw.signal))));
  app.post(
    `${adminApiBasePath}/check/storage-maintenance`,
    requireAdminPermission(adminPermissions.storageMaintenanceExecute),
    async (c) => c.json(apiSuccess(await maintainStorage(c.req.raw.signal)))
  );
  app.post(
    `${adminApiBasePath}/check/trash-purge-maintenance`,
    requireAdminPermission(adminPermissions.imageTrashPurge),
    async (c) => {
      const input = parse(
        trashPurgeMaintenanceInput,
        await readJsonBody(c)
      );
      const response: TrashPurgeMaintenanceResponseDto =
        await maintainTrashPurge(input);
      return c.json(apiSuccess(response));
    }
  );
  app.post(`${adminApiBasePath}/check/all`, async (c) => c.json(apiSuccess(
    await checkSystemState(c.req.raw.signal)
  )));
}
