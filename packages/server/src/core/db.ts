import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg, { type PoolClient } from "pg";
import { appConfig } from "@imageshow/shared";
import { deploymentConfig } from "../config/deployment-config.ts";
import { logger } from "./logger.ts";

const databaseConfig = deploymentConfig.database;

const poolConfig = {
  host: databaseConfig.host,
  port: databaseConfig.port,
  database: databaseConfig.name,
  user: databaseConfig.user,
  password: databaseConfig.password,
  max: appConfig.pgPool.max,
  idleTimeoutMillis: appConfig.pgPool.idleTimeoutMillis,
  connectionTimeoutMillis: appConfig.pgPool.connectionTimeoutMillis,
  maxLifetimeSeconds: appConfig.pgPool.maxLifetimeSeconds
} satisfies pg.PoolConfig;

export const pool = new pg.Pool(poolConfig);
const advisoryLockPool = new pg.Pool({
  ...poolConfig,
  application_name: "imageshow-advisory-locks",
  allowExitOnIdle: true
});

pool.on("error", (error) => logger.error("idle PostgreSQL client error", error));
advisoryLockPool.on("error", (error) => {
  logger.error("idle PostgreSQL advisory-lock client error", error);
});

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

export type AdvisoryLockRequest = {
  key: string;
  mode?: "exclusive" | "shared";
  acquisition?: "wait" | "try";
};

export type AdvisoryLockAttempt<T> =
  | { acquired: true; value: T }
  | { acquired: false };

async function runWithAdvisoryLocks<T>(
  locks: readonly AdvisoryLockRequest[],
  work: () => Promise<T>
): Promise<AdvisoryLockAttempt<T>> {
  const client = await advisoryLockPool.connect();
  const acquired: AdvisoryLockRequest[] = [];
  let destroyClient = false;
  try {
    for (const lock of locks) {
      const tryAcquire = lock.acquisition === "try";
      const lockFunction = lock.mode === "shared"
        ? tryAcquire ? "pg_try_advisory_lock_shared" : "pg_advisory_lock_shared"
        : tryAcquire ? "pg_try_advisory_lock" : "pg_advisory_lock";
      let result;
      try {
        result = await client.query(
          `SELECT ${lockFunction}(hashtext($1)) AS acquired`,
          [lock.key]
        );
      } catch (error) {
        // The server may have acquired the lock before the response was lost.
        // Destroying the session is the only reliable unlock in that case.
        destroyClient = true;
        throw error;
      }
      if (tryAcquire && result.rows[0]?.acquired !== true) {
        return { acquired: false };
      }
      acquired.push(lock);
    }
    return { acquired: true, value: await work() };
  } finally {
    for (const lock of acquired.reverse()) {
      if (destroyClient) break;
      const unlockFunction = lock.mode === "shared"
        ? "pg_advisory_unlock_shared"
        : "pg_advisory_unlock";
      try {
        const result = await client.query(
          `SELECT ${unlockFunction}(hashtext($1)) AS unlocked`,
          [lock.key]
        );
        if (result.rows[0]?.unlocked !== true) destroyClient = true;
      } catch {
        destroyClient = true;
      }
    }
    client.release(destroyClient);
  }
}

export async function withAdvisoryLocks<T>(
  locks: readonly Omit<AdvisoryLockRequest, "acquisition">[],
  work: () => Promise<T>
): Promise<T> {
  const attempt = await runWithAdvisoryLocks(locks, work);
  if (!attempt.acquired) throw new Error("Blocking advisory lock was not acquired");
  return attempt.value;
}

export function tryWithAdvisoryLocks<T>(
  locks: readonly AdvisoryLockRequest[],
  work: () => Promise<T>
): Promise<AdvisoryLockAttempt<T>> {
  return runWithAdvisoryLocks(locks, work);
}

export function withAdvisoryLock<T>(
  key: string,
  work: () => Promise<T>,
  mode: "exclusive" | "shared" = "exclusive"
): Promise<T> {
  return withAdvisoryLocks([{ key, mode }], work);
}

export function runMigrations() {
  return withAdvisoryLock("imageshow:migrations", runMigrationsUnderLock);
}

async function runMigrationsUnderLock() {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundledMigrationDir = join(here, "..", "migrations");
  const migrationDir = existsSync(bundledMigrationDir)
    ? bundledMigrationDir
    : join(here, "..", "..", "migrations");
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  const client = await pool.connect();
  try {
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
    client.release();
  }
}

export async function pingDb() {
  await pool.query("SELECT 1");
}

export async function closeDatabasePools() {
  await Promise.allSettled([pool.end(), advisoryLockPool.end()]);
}
