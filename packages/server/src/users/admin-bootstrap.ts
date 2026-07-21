import { hashPassword } from "../core/password.ts";
import { adminPasswordInput, adminUsernameInput } from "../core/credentials.ts";

const ADMIN_BOOTSTRAP_LOCK = "imageshow:admin-bootstrap";

type AdminBootstrapQueryResult = {
  rowCount: number | null;
  rows?: unknown[];
};

export type AdminBootstrapQuery = (
  sql: string,
  params?: unknown[]
) => Promise<AdminBootstrapQueryResult>;

export type AdminBootstrapCredentials = {
  username?: string;
  password?: string;
};

export async function ensureSuperAdmin(
  query: AdminBootstrapQuery,
  credentials: AdminBootstrapCredentials
) {
  await query("SELECT pg_advisory_lock(hashtext($1))", [ADMIN_BOOTSTRAP_LOCK]);
  try {
    const hasSuper = await query("SELECT 1 FROM admin_account WHERE role = 'super' LIMIT 1");
    if (hasSuper.rowCount) return false;

    if (!credentials.username || !credentials.password) {
      throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required to provision the super admin.");
    }

    const username = adminUsernameInput.parse(credentials.username);
    const password = adminPasswordInput.parse(credentials.password);
    const passwordHash = await hashPassword(password);
    await query(
      "INSERT INTO admin_account(username, password_hash, role) VALUES($1, $2, 'super')",
      [username, passwordHash]
    );
    return true;
  } finally {
    await query("SELECT pg_advisory_unlock(hashtext($1))", [ADMIN_BOOTSTRAP_LOCK]).catch(() => undefined);
  }
}
