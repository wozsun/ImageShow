import type { Context, Hono } from "hono";
import { adminApiBasePath } from "@imageshow/shared";
import { ApiError, ok } from "../core/http.ts";
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
    return c.json(ok({ preferences }));
  });

  app.patch(`${adminApiBasePath}/preferences`, async (c) => {
    const preferences = parse(
      adminPreferencesInput,
      await c.req.json().catch(() => ({}))
    );
    await updateAdminPreferences(
      authenticatedUsername(c),
      preferences
    );
    return c.json(ok({ preferences }));
  });
}
