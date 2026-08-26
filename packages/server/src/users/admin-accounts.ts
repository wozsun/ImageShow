import { pool } from "../core/database/pools.ts";
import { withTransaction } from "../core/database/transactions.ts";
import { ApiError } from "../core/api-error.ts";
import { hashPassword, verifyPassword } from "../core/password.ts";
import type { AdminUserDto } from "@imageshow/shared/browser";
import {
  adminCredentialTransitionVersions,
  adminCredentialVersion,
  type AdminCredentialTransitionVersions
} from "./session-credential.ts";

export async function listAdminAccounts(): Promise<AdminUserDto[]> {
  return (await pool.query(
    "SELECT username, role FROM admin_account ORDER BY (role <> 'super'), username ASC"
  )).rows as AdminUserDto[];
}

export async function createImageAdmin(username: string, password: string) {
  const hash = await hashPassword(password);
  try {
    await pool.query(
      "INSERT INTO admin_account(username, password_hash, role) VALUES($1, $2, 'image')",
      [username, hash]
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new ApiError(
        409,
        "username_taken",
        "用户名已存在",
        { username }
      );
    }
    throw error;
  }
}

export async function resetImageAdminPassword(
  username: string,
  password: string
) {
  const hash = await hashPassword(password);
  const nextCredentialVersion = adminCredentialVersion(hash);
  return withTransaction(async (client) => {
    const target = await client.query<{ role: string; password_hash: string }>(
      `SELECT role, password_hash
         FROM admin_account
        WHERE username = $1
        FOR UPDATE`,
      [username]
    );
    if (!target.rowCount) {
      throw new ApiError(404, "not_found", "用户不存在");
    }
    if (target.rows[0].role === "super") {
      throw new ApiError(
        409,
        "super_immutable",
        "超级管理员的密码无法在此修改",
        { username }
      );
    }
    await client.query(
      "UPDATE admin_account SET password_hash = $2, updated_at = now() WHERE username = $1",
      [username, hash]
    );
    return adminCredentialTransitionVersions(
      target.rows[0]!.password_hash,
      nextCredentialVersion
    );
  });
}

export async function changeAdminPassword(
  username: string,
  currentPassword: string,
  newPassword: string,
  authorizeCredentialTransition: (
    credentialVersions: AdminCredentialTransitionVersions
  ) => Promise<void>
) {
  const hash = await hashPassword(newPassword);
  const nextCredentialVersion = adminCredentialVersion(hash);
  return withTransaction(async (client) => {
    const row = (await client.query(
      "SELECT password_hash FROM admin_account WHERE username = $1 FOR UPDATE",
      [username]
    )).rows[0] as { password_hash: string } | undefined;
    if (!row) throw new ApiError(404, "not_found", "User not found");
    if (!(await verifyPassword(row.password_hash, currentPassword))) {
      throw new ApiError(401, "invalid_current_password", "当前密码不正确");
    }
    const credentialVersions = adminCredentialTransitionVersions(
      row.password_hash,
      nextCredentialVersion
    );
    await authorizeCredentialTransition(credentialVersions);
    await client.query(
      "UPDATE admin_account SET password_hash = $2, updated_at = now() WHERE username = $1",
      [username, hash]
    );
    return credentialVersions;
  });
}

export async function deleteImageAdmin(username: string) {
  return withTransaction(async (client) => {
    const target = await client.query<{ role: string; password_hash: string }>(
      `SELECT role, password_hash
         FROM admin_account
        WHERE username = $1
        FOR UPDATE`,
      [username]
    );
    if (!target.rowCount) {
      throw new ApiError(404, "not_found", "用户不存在");
    }
    if (target.rows[0].role === "super") {
      throw new ApiError(
        409,
        "super_immutable",
        "超级管理员不可删除",
        { username }
      );
    }
    await client.query(
      "DELETE FROM admin_account WHERE username = $1",
      [username]
    );
    return adminCredentialVersion(target.rows[0]!.password_hash);
  });
}
