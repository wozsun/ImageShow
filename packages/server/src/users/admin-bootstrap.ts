import { hashPassword } from "../core/password.ts";
import { adminPasswordInput, adminUsernameInput } from "../core/credentials.ts";
import { withAdvisoryLock } from "../core/db.ts";

const ADMIN_BOOTSTRAP_LOCK = "imageshow:admin-bootstrap";

export type AdminBootstrapCredentials = {
  username?: string;
  password?: string;
};

export async function ensureSuperAdmin(
  credentials: AdminBootstrapCredentials
) {
  return withAdvisoryLock(ADMIN_BOOTSTRAP_LOCK, async (signal, lockClient) => {
    signal.throwIfAborted();
    const hasSuper = await lockClient.query(
      "SELECT 1 FROM admin_account WHERE role = 'super' LIMIT 1"
    );
    if (hasSuper.rowCount) return false;

    if (!credentials.username || !credentials.password) {
      throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required to provision the super admin.");
    }

    const username = adminUsernameInput.parse(credentials.username);
    const password = adminPasswordInput.parse(credentials.password);
    const passwordHash = await hashPassword(password);
    signal.throwIfAborted();
    await lockClient.query(
      "INSERT INTO admin_account(username, password_hash, role) VALUES($1, $2, 'super')",
      [username, passwordHash]
    );
    return true;
  });
}
