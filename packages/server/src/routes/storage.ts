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
import { readJsonBody } from "../core/http/json-body.ts";
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
  storageBackendTestInput,
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
        await readJsonBody(c)
      );
      const response = apiSuccess(
        await migrateStorageBackend(input.source, input.target)
      ) satisfies StorageBackendMigrationResponseDto;
      return c.json(response);
    }
  );

  app.post(`${adminApiBasePath}/storage/backends`, requireSuperAdmin, async (c) => {
    const input = parse(storageBackendCreateInput, await readJsonBody(c));
    await createStorageBackend(input);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/storage/backends/reorder`, requireSuperAdmin, async (c) => {
    const input = parse(slugListInput, await readJsonBody(c));
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
    const input = parse(storageBackendUpdateInput, await readJsonBody(c));
    await updateStorageBackend(slug, input);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/storage/test`, requireSuperAdmin, async (c) => {
    const body = parse(storageBackendTestInput, await readJsonBody(c));
    const config = await resolveStorageTestConfig(body);
    await testStorageBackend(config, c.req.raw.signal);
    return c.json(apiSuccess());
  });
}
