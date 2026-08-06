import type { Hono } from "hono";
import {
  adminApiBasePath,
  adminPermissions,
  type AdminCheckStatusDto
} from "@imageshow/shared/browser";
import { apiSuccess } from "../core/http/responses.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import { requestReadyImageCacheRebuild } from "../images/ready-cache/coordinator.ts";
import { readAdminCheckStatus } from "../checks/lightweight-status.ts";

const readyImageCachePath = `${adminApiBasePath}/cache/ready-images`;

export function registerAdminCacheRoutes(app: Hono) {
  app.post(
    `${readyImageCachePath}/rebuild`,
    requireAdminPermission(adminPermissions.cacheMaintenanceRebuild),
    async (c) => {
      void requestReadyImageCacheRebuild().catch(() => undefined);
      const status = await readAdminCheckStatus();
      return c.json(apiSuccess(status satisfies AdminCheckStatusDto));
    }
  );
}
