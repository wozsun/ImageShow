import type { Hono } from "hono";
import {
  adminApiBasePath,
  type AdminPreferencesResponseDto
} from "@imageshow/shared/browser";
import { adminSessionOf } from "../core/http/admin-session-context.ts";
import {
  apiSuccess,
  apiSuccessEtag,
  privateCacheableApiSuccess
} from "../core/http/responses.ts";
import { privateNoStoreCacheControl } from "../core/http/headers.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { parse } from "./validation/parse.ts";
import { adminPreferencesInput } from "./validation/users.ts";
import {
  readAdminPreferences,
  updateAdminPreferences
} from "../users/preferences.ts";

export function registerAdminPreferenceRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/preferences`, async (c) => {
    const preferences = await readAdminPreferences(adminSessionOf(c).username);
    const response = { preferences } satisfies AdminPreferencesResponseDto;
    return privateCacheableApiSuccess(c, response);
  });

  app.patch(`${adminApiBasePath}/preferences`, async (c) => {
    const preferences = parse(
      adminPreferencesInput,
      await readJsonBody(c)
    );
    const savedPreferences = await updateAdminPreferences(
      adminSessionOf(c).username,
      preferences
    );
    const response = {
      preferences: savedPreferences
    } satisfies AdminPreferencesResponseDto;
    c.header("Cache-Control", privateNoStoreCacheControl);
    c.header("ETag", apiSuccessEtag(response));
    return c.json(apiSuccess(response));
  });
}
