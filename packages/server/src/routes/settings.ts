import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ok, requireSuper } from "../core/http.ts";
import { applicationVersion } from "../core/application-version.ts";
import {
  getSettingsForAdmin,
  parseSettingsInput,
  reloadAppConfig,
  saveAppSettings
} from "../config/app-settings.ts";

export function registerSettingsRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/settings`, (c) => {
    return c.json(ok({
      settings: getSettingsForAdmin(),
      application_version: applicationVersion()
    }));
  });

  app.post(`${adminApiBasePath}/settings`, requireSuper, async (c) => {
    const input = parseSettingsInput(await c.req.json().catch(() => ({})));
    saveAppSettings(input);
    return c.json(ok());
  });

  app.post(`${adminApiBasePath}/settings/reload`, requireSuper, (c) => {
    reloadAppConfig();
    return c.json(ok());
  });

}
