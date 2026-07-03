import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type PoolClient } from "pg";
import argon2 from "argon2";
import { appConfig } from "@imageshow/shared";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

export const pool = new pg.Pool({
  host: env.DATABASE_HOST,
  port: env.DATABASE_PORT,
  database: env.DATABASE_NAME,
  user: env.DATABASE_USER,
  password: env.DATABASE_PASSWORD,
  max: appConfig.pgPool.max,
  idleTimeoutMillis: appConfig.pgPool.idleTimeoutMillis,
  connectionTimeoutMillis: appConfig.pgPool.connectionTimeoutMillis,
  maxLifetimeSeconds: appConfig.pgPool.maxLifetimeSeconds
});

pool.on("error", (error) => logger.error("idle PostgreSQL client error", error));

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function runMigrations() {
  const here = dirname(fileURLToPath(import.meta.url));

  const migrationDir = join(here, "..", "migrations");
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE version = $1", [version]).catch(() => ({ rowCount: 0 }));
    if (exists.rowCount) continue;
    const body = await readFile(join(migrationDir, file), "utf8");
    await withTransaction(async (client) => {
      await client.query(body);
      await client.query("INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING", [version]);
    });
  }
}

export async function initializeAdmin() {
  const hasSuper = await pool.query("SELECT 1 FROM admin_account WHERE role = 'super' LIMIT 1");
  if (hasSuper.rowCount && !env.ADMIN_FORCE_SYNC) return;

  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    throw new Error(hasSuper.rowCount
      ? "ADMIN_FORCE_SYNC=true requires ADMIN_USERNAME and ADMIN_PASSWORD."
      : "ADMIN_USERNAME and ADMIN_PASSWORD are required to provision the super admin.");
  }

  const hash = await argon2.hash(env.ADMIN_PASSWORD, { type: argon2.argon2id });
  await withTransaction(async (client) => {
    if (env.ADMIN_FORCE_SYNC) await client.query("DELETE FROM admin_account WHERE role = 'super' AND username <> $1", [env.ADMIN_USERNAME]);

    await client.query(
      `INSERT INTO admin_account(username, password_hash, role) VALUES($1, $2, 'super')
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'super', updated_at = now()`,
      [env.ADMIN_USERNAME, hash]
    );
  });
}

export async function pingDb() {
  await pool.query("SELECT 1");
}
