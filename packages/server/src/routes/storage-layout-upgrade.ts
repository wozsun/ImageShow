import type { Hono } from "hono";
import {
  adminApiBasePath,
  adminPermissions,
  type StorageLayoutUpgradeBatchResponseDto,
  type StorageLayoutUpgradeStatusDto
} from "@imageshow/shared/browser";
import { apiSuccess } from "../core/http/responses.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { migrateStorageLayoutBatch } from "../images/storage-layout-upgrade/migration.ts";
import { readStorageLayoutUpgradeStatus } from "../images/storage-layout-upgrade/status.ts";
import { requireAdminPermission } from "../users/admin-authorization.ts";
import { parse } from "./validation/parse.ts";
import { storageLayoutUpgradeBatchInput } from "./validation/storage-layout-upgrade.ts";

const storageLayoutUpgradePath =
  `${adminApiBasePath}/check/storage-layout-upgrade`;

export function registerStorageLayoutUpgradeRoutes(app: Hono) {
  const requireStorageLayoutUpgrade = requireAdminPermission(
    adminPermissions.storageLayoutUpgrade
  );
  app.use(storageLayoutUpgradePath, requireStorageLayoutUpgrade);
  app.use(`${storageLayoutUpgradePath}/*`, requireStorageLayoutUpgrade);
  app.get(storageLayoutUpgradePath, async (c) => {
    const status: StorageLayoutUpgradeStatusDto =
      await readStorageLayoutUpgradeStatus(c.req.raw.signal);
    return c.json(apiSuccess(status));
  });
  app.post(`${storageLayoutUpgradePath}/batch`, async (c) => {
    const input = parse(
      storageLayoutUpgradeBatchInput,
      await readJsonBody(c)
    );
    const response: StorageLayoutUpgradeBatchResponseDto =
      await migrateStorageLayoutBatch(input.limit, c.req.raw.signal);
    return c.json(apiSuccess(response));
  });
}
