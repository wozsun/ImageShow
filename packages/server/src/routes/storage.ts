import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok, requireSuper } from "../core/http.ts";
import { parse, slugListInput, storageSlugInput } from "../core/validation.ts";
import {
  storageBackendCreateInput,
  storageBackendUpdateInput
} from "../storage/backend-config.ts";
import {
  createStorageBackend,
  deleteStorageBackend,
  getStorageBackendsForAdmin,
  listStorageBackendOptions,
  reorderStorageBackends,
  resolveStorageTestConfig,
  setDefaultStorageBackend,
  updateStorageBackend
} from "../storage/backend-registry.ts";
import { testStorageBackend } from "../storage/storage.ts";

export function registerStorageRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/storage/options`, async (c) => {
    return c.json(ok({ backends: await listStorageBackendOptions() }));
  });

  app.get(`${adminApiBasePath}/storage/backends`, requireSuper, async (c) => {
    return c.json(ok({ backends: await getStorageBackendsForAdmin() }));
  });

  app.post(`${adminApiBasePath}/storage/backends`, requireSuper, async (c) => {
    const input = parse(storageBackendCreateInput, await c.req.json().catch(() => ({})));
    await createStorageBackend(input);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/storage/backends/reorder`, requireSuper, async (c) => {
    const input = parse(slugListInput, await c.req.json().catch(() => ({})));
    await reorderStorageBackends(input.slugs);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/storage/backends/:slug/default`, requireSuper, async (c) => {
    const slug = parse(storageSlugInput, c.req.param("slug"));
    await setDefaultStorageBackend(slug);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/storage/backends/:slug/delete`, requireSuper, async (c) => {
    const slug = parse(storageSlugInput, c.req.param("slug"));
    await deleteStorageBackend(slug);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/storage/backends/:slug`, requireSuper, async (c) => {
    const slug = parse(storageSlugInput, c.req.param("slug"));
    const input = parse(storageBackendUpdateInput, await c.req.json().catch(() => ({})));
    await updateStorageBackend(slug, input);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/storage/test`, requireSuper, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const config = await resolveStorageTestConfig(body);
    return c.json(ok({ result: await testStorageBackend(config) }));
  });
}
