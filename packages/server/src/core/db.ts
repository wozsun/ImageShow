import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import pg, { type PoolClient } from "pg";
import { appConfig } from "@imageshow/shared";
import { deploymentConfig } from "../config/deployment-config.ts";
import {
  assertDatabaseStructure,
  databaseSchemaContractRevision
} from "./database-contract.ts";
import { logger } from "./logger.ts";

const databaseConfig = deploymentConfig.database;

const poolConfig = {
  host: databaseConfig.host,
  port: databaseConfig.port,
  database: databaseConfig.name,
  user: databaseConfig.user,
  password: databaseConfig.password,
  max: appConfig.pgPool.max,
  options: "-c search_path=public",
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
const cancellationPool = new pg.Pool({
  ...poolConfig,
  application_name: "imageshow-query-cancellation",
  max: 2,
  connectionTimeoutMillis: 1_000,
  query_timeout: 1_500,
  statement_timeout: 1_000,
  allowExitOnIdle: true
});

pool.on("error", (error) => logger.error("idle PostgreSQL client error", error));
advisoryLockPool.on("error", (error) => {
  logger.error("idle PostgreSQL advisory-lock client error", error);
});
cancellationPool.on("error", (error) => {
  logger.error("idle PostgreSQL cancellation client error", error);
});

export function createDedicatedDatabaseClient(applicationName: string) {
  return new pg.Client({
    ...poolConfig,
    application_name: applicationName
  });
}

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
const poisonedAdvisoryClients = new WeakSet<PoolClient>();

export function runWithAdvisoryLockSignal<T>(
  signal: AbortSignal,
  work: () => Promise<T>
): Promise<T> {
  const parent = advisoryLockSignalContext.getStore();
  const combined = parent ? AbortSignal.any([parent, signal]) : signal;
  combined.throwIfAborted();
  return advisoryLockSignalContext.run(combined, work);
}

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

function advisoryLockFunction(lock: AdvisoryLockRequest) {
  const tryAcquire = lock.acquisition === "try";
  if (lock.mode === "shared") {
    return tryAcquire ? "pg_try_advisory_lock_shared" : "pg_advisory_lock_shared";
  }
  return tryAcquire ? "pg_try_advisory_lock" : "pg_advisory_lock";
}

function advisoryUnlockFunction(lock: AdvisoryLockRequest) {
  return lock.mode === "shared"
    ? "pg_advisory_unlock_shared"
    : "pg_advisory_unlock";
}

async function runAdvisoryLockWork<T>(
  signal: AbortSignal,
  client: PoolClient,
  work: AdvisoryLockWork<T>
) {
  const operation = Promise.resolve().then(() => (
    advisoryLockSignalContext.run(signal, () => {
      signal.throwIfAborted();
      return work(signal, client);
    })
  ));
  try {
    const value = await raceWithSignal(signal, operation);
    signal.throwIfAborted();
    return value;
  } catch (error) {
    if (signal.aborted) {
      // Keep same-process limiters and active-operation registries occupied
      // until cooperative cleanup has actually stopped.
      await operation.catch(() => undefined);
      throw signalError(signal);
    }
    throw error;
  }
}

async function runWithAdvisoryLocksOnClient<T>(
  client: PoolClient,
  signal: AbortSignal,
  locks: readonly AdvisoryLockRequest[],
  work: AdvisoryLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  signal.throwIfAborted();
  if (poisonedAdvisoryClients.has(client)) throw new AdvisoryLockLostError();
  const acquired: AdvisoryLockRequest[] = [];
  try {
    for (const lock of locks) {
      let result;
      try {
        signal.throwIfAborted();
        result = await raceWithSignal(
          signal,
          client.query(
            `SELECT ${advisoryLockFunction(lock)}(hashtext($1)) AS acquired`,
            [lock.key]
          )
        );
      } catch (error) {
        // The server may have acquired the lock before the response was lost.
        // The owning outer scope must destroy this session rather than reuse it.
        poisonedAdvisoryClients.add(client);
        throw error;
      }
      if (lock.acquisition === "try" && result.rows[0]?.acquired !== true) {
        return { acquired: false };
      }
      acquired.push(lock);
    }
    return {
      acquired: true,
      value: await runAdvisoryLockWork(signal, client, work)
    };
  } finally {
    for (const lock of acquired.reverse()) {
      if (poisonedAdvisoryClients.has(client)) break;
      try {
        const result = await client.query(
          `SELECT ${advisoryUnlockFunction(lock)}(hashtext($1)) AS unlocked`,
          [lock.key]
        );
        if (result.rows[0]?.unlocked !== true) {
          poisonedAdvisoryClients.add(client);
        }
      } catch {
        poisonedAdvisoryClients.add(client);
      }
    }
  }
}

async function runWithAdvisoryLocks<T>(
  locks: readonly AdvisoryLockRequest[],
  work: AdvisoryLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  advisoryLockSignalContext.getStore()?.throwIfAborted();
  const client = await advisoryLockPool.connect();
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
    return await runWithAdvisoryLocksOnClient(client, lockSignal, locks, work);
  } finally {
    destroyClient ||= poisonedAdvisoryClients.has(client);
    try {
      client.release(destroyClient);
    } finally {
      client.off("error", onClientError);
      client.off("end", onClientEnd);
    }
  }
}

/** Acquire additional advisory locks on an already-owned lock session. */
export async function withAdvisoryLocksOnClient<T>(
  client: PoolClient,
  signal: AbortSignal,
  locks: readonly Omit<AdvisoryLockRequest, "acquisition">[],
  work: AdvisoryLockWork<T>
): Promise<T> {
  const attempt = await runWithAdvisoryLocksOnClient(client, signal, locks, work);
  if (!attempt.acquired) throw new Error("Blocking advisory lock was not acquired");
  return attempt.value;
}

/** Try additional advisory locks without borrowing a second pool session. */
export function tryWithAdvisoryLocksOnClient<T>(
  client: PoolClient,
  signal: AbortSignal,
  locks: readonly AdvisoryLockRequest[],
  work: AdvisoryLockWork<T>
): Promise<AdvisoryLockAttempt<T>> {
  return runWithAdvisoryLocksOnClient(client, signal, locks, work);
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

export function initializeDatabaseSchema() {
  return withAdvisoryLock(
    "imageshow:schema-bootstrap",
    (signal, client) => initializeDatabaseSchemaUnderLock(signal, client)
  );
}

function databaseSchemaPath() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "schema.sql"),
    join(here, "..", "..", "schema.sql")
  ];
  const schemaPath = candidates.find((candidate) => existsSync(candidate));
  if (!schemaPath) {
    throw new Error("PostgreSQL clean-install schema asset is missing");
  }
  return schemaPath;
}

async function databaseHasNoUserRelations(client: PoolClient) {
  const result = await client.query<{ relation_count: string }>(
    `SELECT count(*)::text AS relation_count
       FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname <> 'information_schema'
        AND left(namespace.nspname, 3) <> 'pg_'
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')`
  );
  return Number(result.rows[0]?.relation_count ?? -1) === 0;
}

function databaseReadinessError(error: unknown) {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `PostgreSQL database is non-empty but does not satisfy schema contract `
      + `revision ${databaseSchemaContractRevision}: ${reason}`,
    { cause: error }
  );
}

async function initializeDatabaseSchemaUnderLock(
  signal: AbortSignal,
  client: PoolClient
) {
  signal.throwIfAborted();
  if (!await databaseHasNoUserRelations(client)) {
    signal.throwIfAborted();
    try {
      await assertCoreDatabaseReady(client);
    } catch (error) {
      throw databaseReadinessError(error);
    }
    return;
  }

  const body = await readFile(databaseSchemaPath(), "utf8");
  signal.throwIfAborted();
  await client.query("BEGIN");
  try {
    await client.query(body);
    signal.throwIfAborted();
    await assertCoreDatabaseReady(client);
    signal.throwIfAborted();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

export async function pingDb() {
  await pool.query("SELECT 1");
}

export async function assertCoreDatabaseReady(
  database: Pick<PoolClient, "query"> = pool
) {
  await assertDatabaseStructure(database);
}

export async function requestDatabaseBackendCancellation(
  processId: number,
  terminate = false
) {
  const functionName = terminate ? "pg_terminate_backend" : "pg_cancel_backend";
  return (await cancellationPool.query<{ accepted: boolean }>(
    `SELECT ${functionName}($1) AS accepted`,
    [processId]
  )).rows[0]?.accepted === true;
}

export async function databaseBackendQueryIsActive(processId: number) {
  return (await cancellationPool.query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_stat_activity
        WHERE pid=$1 AND state='active'
     ) AS active`,
    [processId]
  )).rows[0]?.active === true;
}

export async function closeDatabasePools() {
  await Promise.allSettled([
    pool.end(),
    advisoryLockPool.end(),
    cancellationPool.end()
  ]);
}
