import { hashPassword, passwordHashNeedsUpgrade } from "../core/password.ts";

type PasswordUpgradeQuery = (
  sql: string,
  params: unknown[]
) => Promise<{ rowCount: number | null }>;

export async function rehashPasswordIfNeeded(
  query: PasswordUpgradeQuery,
  input: { username: string; password: string; currentHash: string }
) {
  if (!passwordHashNeedsUpgrade(input.currentHash)) return false;
  const nextHash = await hashPassword(input.password);
  const result = await query(
    "UPDATE admin_account SET password_hash = $2, updated_at = now() WHERE username = $1 AND password_hash = $3",
    [input.username, nextHash, input.currentHash]
  );
  return Boolean(result.rowCount);
}
