import { pool } from "../core/db.ts";
import { ApiError } from "../core/http.ts";
import { hashPassword, verifyPassword } from "../core/password.ts";

export type AdminUserRecord = { username: string; role: string; created_at: string };

export async function listAdminUsers(): Promise<AdminUserRecord[]> {
  return (await pool.query(
    "SELECT username, role, created_at::text AS created_at FROM admin_account ORDER BY (role <> 'super'), username ASC"
  )).rows as AdminUserRecord[];
}

export async function createImageAdminUser(username: string, password: string) {
  const hash = await hashPassword(password);
  try {
    await pool.query("INSERT INTO admin_account(username, password_hash, role) VALUES($1, $2, 'image')", [username, hash]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ApiError(409, "username_taken", "用户名已存在", { username });
    throw error;
  }
}

export async function resetUserPassword(username: string, password: string) {
  const target = await pool.query("SELECT role FROM admin_account WHERE username = $1", [username]);
  if (!target.rowCount) throw new ApiError(404, "not_found", "用户不存在");
  if (target.rows[0].role === "super") throw new ApiError(409, "super_immutable", "超级管理员的密码无法在此修改", { username });
  const hash = await hashPassword(password);
  await pool.query("UPDATE admin_account SET password_hash = $2, updated_at = now() WHERE username = $1", [username, hash]);
}

export async function changeOwnPassword(username: string, currentPassword: string, newPassword: string) {
  const row = (await pool.query("SELECT password_hash FROM admin_account WHERE username = $1", [username])).rows[0] as { password_hash: string } | undefined;
  if (!row) throw new ApiError(404, "not_found", "User not found");
  if (!(await verifyPassword(row.password_hash, currentPassword))) {
    throw new ApiError(401, "invalid_current_password", "当前密码不正确");
  }
  const hash = await hashPassword(newPassword);
  await pool.query("UPDATE admin_account SET password_hash = $2, updated_at = now() WHERE username = $1", [username, hash]);
}

export async function deleteAdminUser(username: string) {
  const target = await pool.query("SELECT role FROM admin_account WHERE username = $1", [username]);
  if (!target.rowCount) throw new ApiError(404, "not_found", "用户不存在");
  if (target.rows[0].role === "super") throw new ApiError(409, "super_immutable", "超级管理员不可删除", { username });
  await pool.query("DELETE FROM admin_account WHERE username = $1", [username]);
}
