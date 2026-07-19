import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type PoolClient } from "pg";
import { appConfig } from "@imageshow/shared";
import { bootstrapEnvironment } from "../config/bootstrap-env.ts";
import { deploymentConfig } from "../config/deployment-config.ts";
import { ensureSuperAdmin } from "../users/admin-bootstrap.ts";
import { logger } from "./logger.ts";

const databaseConfig = deploymentConfig.database;

export const pool = new pg.Pool({
  host: databaseConfig.host,
  port: databaseConfig.port,
  database: databaseConfig.name,
  user: databaseConfig.user,
  password: databaseConfig.password,
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

export async function withAdvisoryLock<T>(key: string, work: () => Promise<T>, mode: "exclusive" | "shared" = "exclusive"): Promise<T> {
  const client = await pool.connect();
  const lockFunction = mode === "shared" ? "pg_advisory_lock_shared" : "pg_advisory_lock";
  const unlockFunction = mode === "shared" ? "pg_advisory_unlock_shared" : "pg_advisory_unlock";
  try {
    await client.query(`SELECT ${lockFunction}(hashtext($1))`, [key]);
    return await work();
  } finally {
    await client.query(`SELECT ${unlockFunction}(hashtext($1))`, [key]).catch(() => undefined);
    client.release();
  }
}

export async function runMigrations() {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationDir = join(here, "..", "migrations");
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('imageshow:migrations'))");
    for (const file of files) {
      const version = file.replace(/\.sql$/, "");
      let applied = false;
      try {
        applied = Boolean((await client.query(
          "SELECT 1 FROM schema_migrations WHERE version = $1",
          [version]
        )).rowCount);
      } catch (error) {
        if ((error as { code?: string }).code !== "42P01") throw error;
      }
      if (applied) continue;

      const body = await readFile(join(migrationDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(body);
        await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('imageshow:migrations'))").catch(() => undefined);
    client.release();
  }
}

export async function initializeAdmin() {
  const client = await pool.connect();
  try {
    await ensureSuperAdmin(
      (sql, params) => client.query(sql, params),
      {
        username: bootstrapEnvironment.adminUsername,
        password: bootstrapEnvironment.adminPassword
      }
    );
  } finally {
    client.release();
  }
}

export async function pingDb() {
  await pool.query("SELECT 1");
}
