import {
  adminPreferencesMaxBytes,
  normalizeAdminPreferences,
  type AdminPreferences
} from "@imageshow/shared";
import { ApiError } from "../core/api-error.ts";
import { pool } from "../core/db.ts";

type PreferenceQueryResult = {
  rowCount: number | null;
  rows: Array<{ preferences?: unknown }>;
};

export type AdminPreferenceQuery = (
  text: string,
  values: unknown[]
) => Promise<PreferenceQueryResult>;

const queryAdminPreferences: AdminPreferenceQuery = async (text, values) =>
  pool.query(text, values);

function unauthorizedAdmin() {
  return new ApiError(401, "unauthorized", "Unauthorized");
}

function serializedPreferenceBytes(preferences: AdminPreferences) {
  return Buffer.byteLength(JSON.stringify(preferences), "utf8");
}

function isPreferenceSizeViolation(error: unknown) {
  const databaseError = error as { code?: string; constraint?: string };
  return databaseError.code === "23514"
    && databaseError.constraint === "admin_account_preferences_size_check";
}

export async function readAdminPreferences(
  username: string,
  query: AdminPreferenceQuery = queryAdminPreferences
): Promise<AdminPreferences> {
  const result = await query(
    "SELECT preferences FROM admin_account WHERE username = $1",
    [username]
  );
  if (!result.rowCount) throw unauthorizedAdmin();
  return normalizeAdminPreferences(result.rows[0]?.preferences);
}

export async function updateAdminPreferences(
  username: string,
  preferences: AdminPreferences,
  query: AdminPreferenceQuery = queryAdminPreferences
): Promise<AdminPreferences> {
  if (serializedPreferenceBytes(preferences) > adminPreferencesMaxBytes) {
    throw new ApiError(
      413,
      "admin_preferences_too_large",
      "Administrator preferences are too large"
    );
  }

  try {
    const result = await query(
      `UPDATE admin_account
       SET preferences = preferences || $2::jsonb,
           updated_at = now()
       WHERE username = $1
       RETURNING preferences`,
      [username, JSON.stringify(preferences)]
    );
    if (!result.rowCount) throw unauthorizedAdmin();
    return normalizeAdminPreferences(result.rows[0]?.preferences);
  } catch (error) {
    if (isPreferenceSizeViolation(error)) {
      throw new ApiError(
        413,
        "admin_preferences_too_large",
        "Administrator preferences are too large"
      );
    }
    throw error;
  }
}
