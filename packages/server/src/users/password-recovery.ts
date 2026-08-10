import { hashPassword } from "../core/password.ts";
import { adminPasswordInput, adminUsernameInput } from "../core/credentials.ts";
import { pool } from "../core/database-pools.ts";

type PasswordRecoveryMutation = (
  username: string,
  passwordHash: string
) => Promise<string>;

type AdministratorPasswordRecoveryResult =
  | { username: string; sessionsInvalidated: true; removedSessions: number }
  | { username: string; sessionsInvalidated: false; error: unknown };

export async function resetAdministratorPasswordHash(
  username: string,
  passwordHash: string
) {
  const result = await pool.query<{ username: string }>(
    `UPDATE admin_account
        SET password_hash=$2,
            updated_at=now()
      WHERE username=$1
      RETURNING username`,
    [username, passwordHash]
  );
  if (!result.rowCount) throw new Error(`管理员不存在: ${username}`);
  return result.rows[0]!.username;
}

async function resetAdministratorPassword(
  mutate: PasswordRecoveryMutation,
  usernameInput: string,
  passwordInput: string
) {
  const username = adminUsernameInput.parse(usernameInput);
  const password = adminPasswordInput.parse(passwordInput);
  const passwordHash = await hashPassword(password);
  return mutate(username, passwordHash);
}

export async function resetAdministratorPasswordWithSessionCleanup(
  mutate: PasswordRecoveryMutation,
  invalidateSessions: () => Promise<number>,
  usernameInput: string,
  passwordInput: string
): Promise<AdministratorPasswordRecoveryResult> {
  const username = await resetAdministratorPassword(
    mutate,
    usernameInput,
    passwordInput
  );
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
