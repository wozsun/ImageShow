import type { Hono } from "hono";
import {
  adminApiBasePath,
  type AdminSettingsResponseDto
} from "@imageshow/shared/browser";
import {
  apiSuccess,
  privateCacheableApiSuccess
} from "../core/http/responses.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { requireSuperAdmin } from "../users/admin-authorization.ts";
import {
  getSettingsForAdmin,
  parseSettingsInput,
  saveAppSettings
} from "../config/app-settings.ts";
import { reloadRuntimeConfigFromDisk } from "../config/runtime-config-store.ts";

export function registerSettingsRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/settings`, (c) => {
    const response = {
      settings: getSettingsForAdmin()
    } satisfies AdminSettingsResponseDto;
    return privateCacheableApiSuccess(c, response);
  });

  app.post(`${adminApiBasePath}/settings`, requireSuperAdmin, async (c) => {
    const input = parseSettingsInput(await readJsonBody(c));
    await saveAppSettings(input);
    return c.json(apiSuccess({ settings: getSettingsForAdmin() } satisfies AdminSettingsResponseDto));
  });

  app.post(`${adminApiBasePath}/settings/reload`, requireSuperAdmin, async (c) => {
    await reloadRuntimeConfigFromDisk();
    return c.json(apiSuccess({ settings: getSettingsForAdmin() } satisfies AdminSettingsResponseDto));
  });

}
