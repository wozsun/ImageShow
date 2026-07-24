import type { Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { apiSuccess } from "../core/http/responses.ts";
import { requireSuperAdmin } from "../users/admin-authorization.ts";
import {
  getSettingsForAdmin,
  parseSettingsInput,
  reloadAppConfig,
  saveAppSettings
} from "../config/app-settings.ts";

export function registerSettingsRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/settings`, (c) => {
    return c.json(apiSuccess({
      settings: getSettingsForAdmin()
    }));
  });

  app.post(`${adminApiBasePath}/settings`, requireSuperAdmin, async (c) => {
    const input = parseSettingsInput(await c.req.json().catch(() => ({})));
    await saveAppSettings(input);
    return c.json(apiSuccess());
  });

  app.post(`${adminApiBasePath}/settings/reload`, requireSuperAdmin, async (c) => {
    await reloadAppConfig();
    return c.json(apiSuccess());
  });

}
