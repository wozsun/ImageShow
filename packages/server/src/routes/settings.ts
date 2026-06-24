import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { appConfig } from "@imageshow/shared";
import { ok } from "../core/http.js";
import { getSettingsForAdmin, parseSettingsInput, reloadAppConfig, resolveStorageConfigForTest, saveAppSettings } from "../config/settings.js";
import { testStorage } from "../storage/storage.js";
import { invalidateImageReadCaches } from "../core/redis.js";

export function registerSettingsRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/settings`, async (c) => {
    return c.json(ok({ settings: await getSettingsForAdmin(), defaults: appConfig }));
  });

  app.post(`${adminApiBasePath}/settings`, async (c) => {
    const input = parseSettingsInput(await c.req.json().catch(() => ({})));
    await saveAppSettings(input);
    if (input.storage) await invalidateImageReadCaches();
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/settings/reload`, async (c) => {
    reloadAppConfig();
    await invalidateImageReadCaches();
    return c.json(ok({ settings: await getSettingsForAdmin() }));
  });

  app.post(`${adminApiBasePath}/storage/test`, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const input = Object.keys(body).length ? parseSettingsInput(body) : {};
    return c.json(ok({ result: await testStorage(await resolveStorageConfigForTest(input.storage)) }));
  });
}
