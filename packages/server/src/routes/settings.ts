import type { Hono } from "hono";
import { adminApiBasePath, appConfig } from "@imageshow/shared";
import { ok, requireSuper } from "../core/http.ts";
import {
  getSettingsForAdmin,
  parseSettingsInput,
  reloadAppConfig,
  saveAppSettings
} from "../config/app-settings.ts";

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

}
