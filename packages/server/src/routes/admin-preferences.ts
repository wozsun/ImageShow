import type { Context, Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
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
    return c.json(apiSuccess({ preferences }));
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
    return c.json(apiSuccess({ preferences: savedPreferences }));
  });
}
