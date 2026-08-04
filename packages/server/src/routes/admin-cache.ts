import type { Hono } from "hono";
import {
  adminApiBasePath,
  adminPermissions,
  type ReadyImageCacheAdminStatusDto
} from "@imageshow/shared/browser";
import { apiSuccess } from "../core/http/responses.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import { getReadyImageCacheAdminStatus } from "../images/ready-cache/admin-status.ts";
import { requestReadyImageCacheRebuild } from "../images/ready-cache/coordinator.ts";

const readyImageCachePath = `${adminApiBasePath}/cache/ready-images`;

export function registerAdminCacheRoutes(app: Hono) {
  app.get(readyImageCachePath, async (c) => {
    const status = await getReadyImageCacheAdminStatus();
    return c.json(apiSuccess(status satisfies ReadyImageCacheAdminStatusDto));
  });

  app.post(
    `${readyImageCachePath}/rebuild`,
    requireAdminPermission(adminPermissions.cacheMaintenanceRebuild),
    async (c) => {
      void requestReadyImageCacheRebuild().catch(() => undefined);
      const status = await getReadyImageCacheAdminStatus();
      return c.json(apiSuccess(status satisfies ReadyImageCacheAdminStatusDto));
    }
  );
}
