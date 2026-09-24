import type { Context, Hono } from "hono";
import {
  adminApiBasePath,
  type AdminPreferencesResponseDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import {
  apiSuccess,
  apiSuccessEtag,
  privateCacheableApiSuccess
} from "../core/http/responses.ts";
import { privateNoStoreCacheControl } from "../core/http/headers.ts";
import { readJsonBody } from "../core/http/json-body.ts";
import { limitAdminPreferencesBody } from "../core/http/request-body-limit.ts";
import { parse } from "./validation/parse.ts";
import { adminPreferencesInput } from "./validation/users.ts";
import {
  readAdminPreferences,
  updateAdminPreferences
} from "../users/preferences.ts";

function authenticatedUsername(c: Context) {
  const session = c.get("session") as { username?: unknown } | undefined;
  if (typeof session?.username !== "string" || !session.username) {
    throw new ApiError(401, "unauthorized", "Unauthorized");
  }
  return session.username;
}

export function registerAdminPreferenceRoutes(app: Hono) {
  app.get(`${adminApiBasePath}/preferences`, async (c) => {
    const preferences = await readAdminPreferences(authenticatedUsername(c));
    const response = { preferences } satisfies AdminPreferencesResponseDto;
    return privateCacheableApiSuccess(c, response);
  });

  app.patch(`${adminApiBasePath}/preferences`, limitAdminPreferencesBody, async (c) => {
    const preferences = parse(
      adminPreferencesInput,
      await readJsonBody(c)
    );
    const savedPreferences = await updateAdminPreferences(
      authenticatedUsername(c),
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
