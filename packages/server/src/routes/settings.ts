import type { Hono } from "hono";
import { adminApiBasePath, appConfig } from "@imageshow/shared";
import { ok, requireSuper } from "../core/http.js";
import {
  createStorageBackend,
  deleteStorageBackend,
  getSettingsForAdmin,
  getStorageBackendsForAdmin,
  listStorageBackendOptions,
  parseSettingsInput,
  reloadAppConfig,
  reorderStorageBackends,
  resolveStorageTestConfig,
  saveAppSettings,
  setDefaultStorageBackend,
  storageBackendCreateInput,
  storageBackendUpdateInput,
  updateStorageBackend
} from "../config/settings.js";
import { parse, slugListInput, storageSlugInput } from "../core/validation.js";
import { testStorage } from "../storage/storage.js";

export function registerSettingsRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/settings`, async (c) => {
    return c.json(ok({ settings: await getSettingsForAdmin(), defaults: appConfig }));
  });

  app.post(`${adminApiBasePath}/settings`, requireSuper, async (c) => {
    const input = parseSettingsInput(await c.req.json().catch(() => ({})));
    await saveAppSettings(input);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/settings/reload`, requireSuper, async (c) => {
    reloadAppConfig();
    return c.json(ok({ settings: await getSettingsForAdmin() }));
  });

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
    return c.json(ok({ result: await testStorage(await resolveStorageTestConfig(body)) }));
  });
}
