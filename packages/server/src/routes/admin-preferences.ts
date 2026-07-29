import type { Context, Hono } from "hono";
import {
  adminApiBasePath,
  type AdminPreferencesResponseDto
} from "@imageshow/shared/browser";
import { ApiError } from "../core/api-error.ts";
import { apiSuccess } from "../core/http/responses.ts";
import { limitAdminPreferencesBody } from "../core/http/request-body-limit.ts";
import { adminPreferencesInput, parse } from "../core/validation.ts";
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
    return c.json(apiSuccess(response));
  });

  app.patch(`${adminApiBasePath}/preferences`, limitAdminPreferencesBody, async (c) => {
    const preferences = parse(
      adminPreferencesInput,
      await c.req.json().catch(() => ({}))
    );
    const savedPreferences = await updateAdminPreferences(
      authenticatedUsername(c),
      preferences
    );
    const response = {
      preferences: savedPreferences
    } satisfies AdminPreferencesResponseDto;
    return c.json(apiSuccess(response));
  });
}
