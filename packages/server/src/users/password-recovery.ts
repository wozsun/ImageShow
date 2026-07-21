import { hashPassword } from "../core/password.ts";
import { adminPasswordInput, adminUsernameInput } from "../core/credentials.ts";

type PasswordRecoveryQuery = (
  sql: string,
  params: unknown[]
) => Promise<{ rowCount: number | null; rows: Array<{ username: string }> }>;

type AdministratorPasswordRecoveryResult =
  | { username: string; sessionsInvalidated: true; removedSessions: number }
  | { username: string; sessionsInvalidated: false; error: unknown };

async function resetAdministratorPassword(
  query: PasswordRecoveryQuery,
  usernameInput: string,
  passwordInput: string
) {
  const username = adminUsernameInput.parse(usernameInput);
  const password = adminPasswordInput.parse(passwordInput);
  const passwordHash = await hashPassword(password);
  const result = await query(
    "UPDATE admin_account SET password_hash = $2, updated_at = now() WHERE username = $1 RETURNING username",
    [username, passwordHash]
  );
  if (!result.rowCount) throw new Error(`管理员不存在: ${username}`);
  return result.rows[0].username;
}

export async function resetAdministratorPasswordWithSessionCleanup(
  query: PasswordRecoveryQuery,
  invalidateSessions: () => Promise<number>,
  usernameInput: string,
  passwordInput: string
): Promise<AdministratorPasswordRecoveryResult> {
  const username = await resetAdministratorPassword(query, usernameInput, passwordInput);
  try {
    return {
      username,
      sessionsInvalidated: true,
      removedSessions: await invalidateSessions()
    };
  } catch (error) {
    return { username, sessionsInvalidated: false, error };
  }
}
