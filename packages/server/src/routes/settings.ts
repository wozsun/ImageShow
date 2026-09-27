import type { Hono } from "hono";
import {
  adminApiBasePath,
  type RuntimeConfig,
  type RuntimeConfigResponseDto,
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
  saveAppSettings
} from "../config/app-settings.ts";
import { getRuntimeConfig, reloadRuntimeConfigFromDisk } from "../config/runtime-config-store.ts";
import { assertLocalImageHostForSite } from "../storage/backends/registry.ts";
import { privateNoStoreCacheControl, privateRevalidationCacheControl } from "../core/http/headers.ts";

const settingsRepresentation = createApiSuccessSnapshot(
  (config: RuntimeConfig) =>
    ({
      settings: getSettingsForAdmin(config)
    }) satisfies AdminSettingsResponseDto
);

export function registerSettingsRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/settings`, (c) => {
    return cacheableContentResponse(c, settingsRepresentation(getRuntimeConfig()), {
      cacheControl: privateRevalidationCacheControl,
      contentType: "application/json; charset=UTF-8"
    });
  });

  app.get(`${adminApiBasePath}/settings/runtime`, requireSuperAdmin, (c) => {
    c.header("Cache-Control", privateNoStoreCacheControl);
    const config = getRuntimeConfig();
    return c.json(apiSuccess({
      config,
      settings: getSettingsForAdmin(config)
    } satisfies RuntimeConfigResponseDto));
  });

  app.post(`${adminApiBasePath}/settings`, requireSuperAdmin, async (c) => {
    const config = await saveAppSettings(await readJsonBody(c));
    c.header("Cache-Control", privateNoStoreCacheControl);
    return c.json(
      apiSuccess({ config, settings: getSettingsForAdmin(config) } satisfies RuntimeConfigResponseDto)
    );
  });

  app.post(`${adminApiBasePath}/settings/reload`, requireSuperAdmin, async (c) => {
    const config = await reloadRuntimeConfigFromDisk((candidate) =>
      assertLocalImageHostForSite(candidate.site.domain)
    );
    c.header("Cache-Control", privateNoStoreCacheControl);
    return c.json(
      apiSuccess({ config, settings: getSettingsForAdmin(config) } satisfies RuntimeConfigResponseDto)
    );
  });
}
