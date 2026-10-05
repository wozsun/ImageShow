import { markPromiseAsHandled } from "node:util";
import type { Hono } from "hono";
import {
  adminApiBasePath,
  adminPermissions,
  type AdminCheckStatusDto
} from "@imageshow/shared/browser";
import { apiSuccess } from "../core/http/responses.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import { neverAbortedSignal } from "../core/abort.ts";
import { requestReadyImageCacheRebuild } from "../images/ready-cache/coordinator.ts";
import { readAdminCheckStatus } from "../checks/lightweight-status.ts";

const readyImageCachePath = `${adminApiBasePath}/cache/ready-images`;

export function registerAdminCacheRoutes(app: Hono) {
  app.post(
    `${readyImageCachePath}/rebuild`,
    requireAdminPermission(adminPermissions.cacheMaintenanceRebuild),
    async (c) => {
      // The rebuild belongs to the coordinator, not to this request.
      markPromiseAsHandled(requestReadyImageCacheRebuild({ signal: neverAbortedSignal }));
      const status = await readAdminCheckStatus();
      return c.json(apiSuccess(status satisfies AdminCheckStatusDto));
    }
  );
}
