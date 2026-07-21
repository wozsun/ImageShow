import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
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

export async function withTransactionOnClient<T>(
  client: PoolClient,
  work: (client: PoolClient) => Promise<T>,
  options: { onTransactionId?: (transactionId: string) => void } = {}
): Promise<T> {
  try {
    await client.query("BEGIN");
    if (options.onTransactionId) {
      const transactionId = String((await client.query(
        "SELECT pg_current_xact_id()::text AS transaction_id"
      )).rows[0]?.transaction_id ?? "");
      if (!transactionId) throw new Error("PostgreSQL did not assign a transaction ID");
      options.onTransactionId(transactionId);
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export type TransactionOutcome = "committed" | "rolled_back" | "unknown";

/** Inspect the immutable outcome of one PostgreSQL transaction receipt. */
export async function inspectTransactionOutcome(
  transactionId: string
): Promise<TransactionOutcome> {
  const status = (await pool.query(
    "SELECT pg_xact_status($1::xid8) AS status",
    [transactionId]
  )).rows[0]?.status;
  if (status === "committed") return "committed";
  if (status === "aborted") return "rolled_back";
  return "unknown";
}

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await withTransactionOnClient(client, work);
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

class AdvisoryLockLostError extends Error {
  readonly code = "advisory_lock_lost";

  constructor(cause?: unknown) {
    super("PostgreSQL advisory lock connection was lost", { cause });
    this.name = "AdvisoryLockLostError";
  }
}

type AdvisoryLockWork<T> = (
  signal: AbortSignal,
  lockClient: PoolClient
) => Promise<T>;
const advisoryLockSignalContext = new AsyncLocalStorage<AbortSignal>();

function signalError(signal: AbortSignal) {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Operation aborted");
}

function raceWithSignal<T>(signal: AbortSignal, operation: Promise<T>): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(signalError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signalError(signal));
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", aborted);
    });
  });
}

function combinedLockSignal(signal: AbortSignal) {
  const parent = advisoryLockSignalContext.getStore();
  return parent ? AbortSignal.any([parent, signal]) : signal;
}

async function runWithAdvisoryLocks<T>(
  locks: readonly AdvisoryLockRequest[],
  work: AdvisoryLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  advisoryLockSignalContext.getStore()?.throwIfAborted();
  const client = await advisoryLockPool.connect();
  const acquired: AdvisoryLockRequest[] = [];
  let destroyClient = false;
  const connectionLoss = new AbortController();
  const lockSignal = combinedLockSignal(connectionLoss.signal);
  const connectionLost = (cause?: unknown) => {
    destroyClient = true;
    if (!connectionLoss.signal.aborted) {
      connectionLoss.abort(new AdvisoryLockLostError(cause));
    }
  };
  const onClientError = (error: Error) => connectionLost(error);
  const onClientEnd = () => connectionLost();
  client.on("error", onClientError);
  client.on("end", onClientEnd);
  try {
    for (const lock of locks) {
      const tryAcquire = lock.acquisition === "try";
      const lockFunction = lock.mode === "shared"
        ? tryAcquire ? "pg_try_advisory_lock_shared" : "pg_advisory_lock_shared"
        : tryAcquire ? "pg_try_advisory_lock" : "pg_advisory_lock";
      let result;
      try {
        lockSignal.throwIfAborted();
        result = await raceWithSignal(
          lockSignal,
          client.query(
            `SELECT ${lockFunction}(hashtext($1)) AS acquired`,
            [lock.key]
          )
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
    const operation = Promise.resolve().then(() => (
      advisoryLockSignalContext.run(lockSignal, () => {
        lockSignal.throwIfAborted();
        return work(lockSignal, client);
      })
    ));
    let value: T;
    try {
      value = await raceWithSignal(lockSignal, operation);
    } catch (error) {
      if (lockSignal.aborted) {
        // Keep same-process limiters and active-operation registries occupied
        // until cooperative cleanup has actually stopped. The PostgreSQL
        // session lock is already gone, so publication still needs its own
        // fencing, but a second local executor must not overlap the old one.
        await operation.catch(() => undefined);
        throw signalError(lockSignal);
      }
      throw error;
    }
    lockSignal.throwIfAborted();
    return { acquired: true, value };
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
    try {
      client.release(destroyClient);
    } finally {
      client.off("error", onClientError);
      client.off("end", onClientEnd);
    }
  }
}

export async function withAdvisoryLocks<T>(
  locks: readonly Omit<AdvisoryLockRequest, "acquisition">[],
  work: AdvisoryLockWork<T>
): Promise<T> {
  const attempt = await runWithAdvisoryLocks(locks, work);
  if (!attempt.acquired) throw new Error("Blocking advisory lock was not acquired");
  return attempt.value;
}

export function tryWithAdvisoryLocks<T>(
  locks: readonly AdvisoryLockRequest[],
  work: AdvisoryLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  return runWithAdvisoryLocks(locks, work);
}

export function withAdvisoryLock<T>(
  key: string,
  work: AdvisoryLockWork<T>,
  mode: "exclusive" | "shared" = "exclusive"
): Promise<T> {
  return withAdvisoryLocks([{ key, mode }], work);
}

export function runMigrations() {
  return withAdvisoryLock(
    "imageshow:migrations",
    (signal, client) => runMigrationsUnderLock(signal, client)
  );
}

async function runMigrationsUnderLock(
  signal: AbortSignal,
  client: PoolClient
) {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundledMigrationDir = join(here, "..", "migrations");
  const migrationDir = existsSync(bundledMigrationDir)
    ? bundledMigrationDir
    : join(here, "..", "..", "migrations");
  const files = (await readdir(migrationDir)).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) {
    signal.throwIfAborted();
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
    signal.throwIfAborted();
    if (applied) continue;

    const body = await readFile(join(migrationDir, file), "utf8");
    signal.throwIfAborted();
    await client.query("BEGIN");
    try {
      await client.query(body);
      signal.throwIfAborted();
      await client.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
      signal.throwIfAborted();
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
}

export async function pingDb() {
  await pool.query("SELECT 1");
}

export async function closeDatabasePools() {
  await Promise.allSettled([pool.end(), advisoryLockPool.end()]);
}
