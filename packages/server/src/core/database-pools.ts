import pg, { type PoolClient } from "pg";
import { appConfig } from "@imageshow/shared";
import { logger } from "./logger.ts";

export type DatabaseConnectionConfig = Readonly<{
  host: string;
  port: number;
  name: string;
  user: string;
  password: string;
}>;

let configuredConnection: DatabaseConnectionConfig | null = null;

export let pool: pg.Pool;
let advisoryLockPool: pg.Pool | null = null;
let cancellationPool: pg.Pool | null = null;

function sameConnection(
  left: DatabaseConnectionConfig,
  right: DatabaseConnectionConfig
) {
  return left.host === right.host
    && left.port === right.port
    && left.name === right.name
    && left.user === right.user
    && left.password === right.password;
}

function requireAdvisoryLockPool() {
  if (!advisoryLockPool) {
    throw new Error("PostgreSQL pools have not been configured");
  }
  return advisoryLockPool;
}

function requireCancellationPool() {
  if (!cancellationPool) {
    throw new Error("PostgreSQL pools have not been configured");
  }
  return cancellationPool;
}

export function configureDatabasePools(
  databaseConfig: DatabaseConnectionConfig
) {
  if (configuredConnection) {
    if (!sameConnection(configuredConnection, databaseConfig)) {
      throw new Error(
        "PostgreSQL pools are already configured for another database"
      );
    }
    return;
  }

  const nextPoolConfig = {
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
  const nextPool = new pg.Pool(nextPoolConfig);
  const nextAdvisoryLockPool = new pg.Pool({
    ...nextPoolConfig,
    application_name: "imageshow-advisory-locks",
    allowExitOnIdle: true
  });
  const nextCancellationPool = new pg.Pool({
    ...nextPoolConfig,
    application_name: "imageshow-query-cancellation",
    max: 2,
    connectionTimeoutMillis: 1_000,
    query_timeout: 1_500,
    statement_timeout: 1_000,
    allowExitOnIdle: true
  });

  nextPool.on("error", (error) => {
    logger.error("idle PostgreSQL client error", error);
  });
  nextAdvisoryLockPool.on("error", (error) => {
    logger.error("idle PostgreSQL advisory-lock client error", error);
  });
  nextCancellationPool.on("error", (error) => {
    logger.error("idle PostgreSQL cancellation client error", error);
  });

  configuredConnection = Object.freeze({ ...databaseConfig });
  pool = nextPool;
  advisoryLockPool = nextAdvisoryLockPool;
  cancellationPool = nextCancellationPool;
}

export function connectAdvisoryLockClient(): Promise<PoolClient> {
  return requireAdvisoryLockPool().connect();
}

export async function requestDatabaseBackendCancellation(
  processId: number,
  terminate = false
) {
  const functionName = terminate ? "pg_terminate_backend" : "pg_cancel_backend";
  return (await requireCancellationPool().query<{ accepted: boolean }>(
    `SELECT ${functionName}($1) AS accepted`,
    [processId]
  )).rows[0]?.accepted === true;
}

export async function databaseBackendQueryIsActive(processId: number) {
  return (await requireCancellationPool().query<{ active: boolean }>(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_stat_activity
        WHERE pid=$1 AND state='active'
     ) AS active`,
    [processId]
  )).rows[0]?.active === true;
}

export async function closeDatabasePools() {
  const pools = [pool, advisoryLockPool, cancellationPool].filter(
    (candidate): candidate is pg.Pool => candidate !== undefined
      && candidate !== null
  );
  await Promise.allSettled(pools.map((candidate) => candidate.end()));
}
