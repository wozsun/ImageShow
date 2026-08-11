import pg, { type PoolClient } from "pg";
import { appConfig } from "@imageshow/shared";
import { logger } from "./logger.ts";

export type DatabaseReader = Pick<PoolClient, "query">;

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
  nextPool.on("error", (error) => {
    logger.error("idle PostgreSQL client error", error);
  });
  nextAdvisoryLockPool.on("error", (error) => {
    logger.error("idle PostgreSQL advisory-lock client error", error);
  });
  configuredConnection = Object.freeze({ ...databaseConfig });
  pool = nextPool;
  advisoryLockPool = nextAdvisoryLockPool;
}

export function connectAdvisoryLockClient(): Promise<PoolClient> {
  return requireAdvisoryLockPool().connect();
}

export async function closeDatabasePools() {
  const pools = [pool, advisoryLockPool].filter(
    (candidate): candidate is pg.Pool => candidate !== undefined
      && candidate !== null
  );
  await Promise.allSettled(pools.map((candidate) => candidate.end()));
}
