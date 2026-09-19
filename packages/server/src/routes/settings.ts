import type { Hono } from "hono";
import {
  adminApiBasePath,
  type RuntimeConfig,
  type AdminSettingsResponseDto
} from "@imageshow/shared/browser";
import {
  apiSuccess,
  cacheableContentResponse,
  createApiSuccessSnapshot
} from "../core/http/responses.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { requireSuperAdmin } from "../users/admin-authorization.ts";
import {
  getSettingsForAdmin,
  parseSettingsInput,
  saveAppSettings
} from "../config/app-settings.ts";
import { getRuntimeConfig, reloadRuntimeConfigFromDisk } from "../config/runtime-config-store.ts";
import { privateRevalidationCacheControl } from "../core/http/headers.ts";

const settingsRepresentation = createApiSuccessSnapshot((config: RuntimeConfig) => ({
  settings: getSettingsForAdmin(config)
} satisfies AdminSettingsResponseDto));

export function registerSettingsRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/settings`, (c) => {
    return cacheableContentResponse(c, settingsRepresentation(getRuntimeConfig()), {
      cacheControl: privateRevalidationCacheControl,
      contentType: "application/json; charset=UTF-8"
    });
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
