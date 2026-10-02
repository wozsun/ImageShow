import type { Hono } from "hono";
import {
  adminPermissions,
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
import { requireAdminPermission } from "../users/admin-authorization.ts";
import {
  getSettingsForAdmin,
  saveAppSettings
} from "../config/app-settings.ts";
import { getRuntimeConfig, reloadRuntimeConfigFromDisk, runtimeConfigRevision } from "../config/runtime-config-store.ts";
import { parse } from "./validation/parse.ts";
import { runtimeConfigSaveInput } from "./validation/settings.ts";
import { assertLocalImageHostForSite } from "../storage/backends/registry.ts";
import { privateNoStoreCacheControl, privateRevalidationCacheControl } from "../core/http/headers.ts";

const settingsRepresentation = createApiSuccessSnapshot(
  (config: RuntimeConfig) =>
    ({
      settings: getSettingsForAdmin(config)
    }) satisfies AdminSettingsResponseDto
);

function runtimeConfigResponse(config: RuntimeConfig) {
  return apiSuccess({
    config,
    revision: runtimeConfigRevision(config),
    settings: getSettingsForAdmin(config)
  } satisfies RuntimeConfigResponseDto);
}

export function registerSettingsRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/settings`, (c) => {
    return cacheableContentResponse(c, settingsRepresentation(getRuntimeConfig()), {
      cacheControl: privateRevalidationCacheControl,
      contentType: "application/json; charset=UTF-8"
    });
  });

  app.get(
    `${adminApiBasePath}/settings/runtime`,
    requireAdminPermission(adminPermissions.settingsManage),
    (c) => {
      c.header("Cache-Control", privateNoStoreCacheControl);
      const config = getRuntimeConfig();
      return c.json(runtimeConfigResponse(config));
    }
  );

  app.post(
    `${adminApiBasePath}/settings`,
    requireAdminPermission(adminPermissions.settingsManage),
    async (c) => {
      const input = parse(runtimeConfigSaveInput, await readJsonBody(c));
      const config = await saveAppSettings(input.config, input.revision);
      c.header("Cache-Control", privateNoStoreCacheControl);
      return c.json(runtimeConfigResponse(config));
    }
  );

  app.post(
    `${adminApiBasePath}/settings/reload`,
    requireAdminPermission(adminPermissions.settingsManage),
    async (c) => {
      const config = await reloadRuntimeConfigFromDisk((candidate) =>
        assertLocalImageHostForSite(candidate.site.domain)
      );
      c.header("Cache-Control", privateNoStoreCacheControl);
      return c.json(runtimeConfigResponse(config));
    }
  );
}
