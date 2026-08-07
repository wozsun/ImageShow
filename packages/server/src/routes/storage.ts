import type { Hono } from "hono";
import {
  adminApiBasePath,
  adminPermissions,
  type StorageBackendOptionsResponseDto,
  type StorageBackendMigrationResponseDto,
  type StorageBackendsAdminResponseDto
} from "@imageshow/shared/browser";
import {
  apiSuccess,
  privateCacheableApiSuccess
} from "../core/http/responses.ts";
import {
  requireAdminPermission,
  requireSuperAdmin
} from "../users/admin-authorization.ts";
import {
  parse,
  slugListInput,
  storageBackendMigrationInput,
  storageSlugInput
} from "../core/validation.ts";
import {
  storageBackendCreateInput,
  storageBackendUpdateInput
} from "../storage/backend-config.ts";
import {
  createStorageBackend,
  deleteStorageBackend,
  reorderStorageBackends,
  setDefaultStorageBackend
} from "../storage/backend-mutations.ts";
import {
  getStorageBackendsForAdmin,
  listStorageBackendOptions
} from "../storage/backend-read-model.ts";
import { resolveStorageTestConfig } from "../storage/backend-probe.ts";
import { updateStorageBackend } from "../storage/backend-update.ts";
import { retryStorageBackendCleanup } from "../storage/move-cleanup.ts";
import { testStorageBackend } from "../storage/backend-self-test.ts";
import { migrateStorageBackend } from "../storage/backend-migration.ts";

export function registerStorageRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/storage/options`, async (c) => {
    const response = {
      backends: await listStorageBackendOptions()
    } satisfies StorageBackendOptionsResponseDto;
    return privateCacheableApiSuccess(c, response);
  });

  app.get(`${adminApiBasePath}/storage/backends`, requireSuperAdmin, async (c) => {
    const response = {
      backends: await getStorageBackendsForAdmin()
    } satisfies StorageBackendsAdminResponseDto;
    return c.json(apiSuccess(response));
  });

  app.post(
    `${adminApiBasePath}/storage/backends/migrate`,
    requireAdminPermission(adminPermissions.storageMaintenanceMigrate),
    async (c) => {
      const input = parse(
        storageBackendMigrationInput,
        await c.req.json().catch(() => ({}))
      );
      const response = apiSuccess(
        await migrateStorageBackend(input.source, input.target)
      ) satisfies StorageBackendMigrationResponseDto;
      return c.json(response);
    }
  );

  app.post(`${adminApiBasePath}/storage/backends`, requireSuperAdmin, async (c) => {
    const input = parse(storageBackendCreateInput, await c.req.json().catch(() => ({})));
    await createStorageBackend(input);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/storage/backends/reorder`, requireSuperAdmin, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    await reorderStorageBackends(input.slugs);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/storage/backends/:slug/default`, requireSuperAdmin, async (c) => {
    const slug = parse(storageSlugInput, c.req.param("slug"));
    await setDefaultStorageBackend(slug);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/storage/backends/:slug/delete`, requireSuperAdmin, async (c) => {
    const slug = parse(storageSlugInput, c.req.param("slug"));
    await deleteStorageBackend(slug);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/storage/backends/:slug/cleanup/retry`, requireSuperAdmin, async (c) => {
    const slug = parse(storageSlugInput, c.req.param("slug"));
    await retryStorageBackendCleanup(slug);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/storage/backends/:slug`, requireSuperAdmin, async (c) => {
    const slug = parse(storageSlugInput, c.req.param("slug"));
    const input = parse(storageBackendUpdateInput, await c.req.json().catch(() => ({})));
    await updateStorageBackend(slug, input);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/storage/test`, requireSuperAdmin, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const config = await resolveStorageTestConfig(body);
    await testStorageBackend(config);
    return c.json(apiSuccess());
  });
}
