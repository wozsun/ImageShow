import { hashPassword } from "../core/password.ts";
import { adminPasswordInput, adminUsernameInput } from "../core/credentials.ts";
import { withAdvisoryLock } from "../core/db.ts";
import type { PoolClient } from "pg";

const ADMIN_BOOTSTRAP_LOCK = "imageshow:admin-bootstrap";

type AdminBootstrapQueryResult = {
  rowCount: number | null;
  rows?: unknown[];
};

type AdminBootstrapQuery = (
  sql: string,
  params?: unknown[]
) => Promise<AdminBootstrapQueryResult>;

export type AdminBootstrapCredentials = {
  username?: string;
  password?: string;
};

type AdminBootstrapLock = <T>(
  key: string,
  work: (signal: AbortSignal, lockClient?: PoolClient) => Promise<T>
) => Promise<T>;

type AdminBootstrapDependencies = {
  query?: AdminBootstrapQuery;
  withLock?: AdminBootstrapLock;
};

export async function ensureSuperAdmin(
  credentials: AdminBootstrapCredentials,
  dependencies: AdminBootstrapDependencies = {}
) {
  const withLock: AdminBootstrapLock = dependencies.withLock
    ?? ((key, work) => withAdvisoryLock(
      key,
      (signal, lockClient) => work(signal, lockClient)
    ));
  return withLock(ADMIN_BOOTSTRAP_LOCK, async (signal, lockClient) => {
    const query = dependencies.query ?? ((sql: string, params?: unknown[]) => {
      if (!lockClient) throw new Error("Admin bootstrap lock client is unavailable");
      return lockClient.query(sql, params);
    });
    signal.throwIfAborted();
    const hasSuper = await query("SELECT 1 FROM admin_account WHERE role = 'super' LIMIT 1");
    if (hasSuper.rowCount) return false;

    if (!credentials.username || !credentials.password) {
      throw new Error("ADMIN_USERNAME and ADMIN_PASSWORD are required to provision the super admin.");
    }

    const username = adminUsernameInput.parse(credentials.username);
    const password = adminPasswordInput.parse(credentials.password);
    const passwordHash = await hashPassword(password);
    signal.throwIfAborted();
    await query(
      "INSERT INTO admin_account(username, password_hash, role) VALUES($1, $2, 'super')",
      [username, passwordHash]
    );
    return true;
  });
}
