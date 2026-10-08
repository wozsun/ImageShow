import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { errorMessage } from "../api-error.ts";
import { assertDatabaseReadiness } from "./readiness.ts";
import { logger } from "../logger.ts";
import { upgradeDatabaseFrom679 } from "./upgrade-6.8.0.ts";
import { pool } from "./pools.ts";
import { withTransactionOnClient } from "./transactions.ts";

export async function initializeDatabaseSchema() {
  const client = await pool.connect();
  try {
    await initializeDatabaseSchemaOnClient(client);
  } finally {
    client.release();
  }
}

function databaseSchemaPath(asset = "schema.sql") {
  const candidates = [
    join(import.meta.dirname, "..", "..", asset),
    join(import.meta.dirname, "..", "..", "..", asset)
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error(`PostgreSQL database asset is missing: ${asset}`);
  }
  return path;
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
  return new Error(
    `PostgreSQL database is non-empty but is not ready for the current application: ${errorMessage(error)}`,
    { cause: error }
  );
}

async function initializeDatabaseSchemaOnClient(client: PoolClient) {
  const empty = await databaseHasNoUserRelations(client);
  const schema = empty
    ? await readFile(databaseSchemaPath(), "utf8")
    : null;
  let upgraded = false;
  await withTransactionOnClient(client, async (transaction) => {
    try {
      if (schema) await transaction.query(schema);
      else upgraded = await upgradeDatabaseFrom679(transaction, () =>
        readFile(databaseSchemaPath("schema-upgrade-6.8.0.sql"), "utf8")
      );
      await assertCoreDatabaseReady(transaction);
    } catch (error) {
      if (!empty) throw databaseReadinessError(error);
      throw error;
    }
  });
  if (upgraded) logger.info("database_upgrade_6_8_0_completed");
}

export async function pingDatabase() {
  await pool.query("SELECT 1");
}

let readinessPromise: Promise<void> | null = null;

export async function assertCoreDatabaseReady(database: Pick<PoolClient, "query"> = pool) {
  // Initialization owns a dedicated transaction; only concurrent checks using
  // the shared pool can share the same in-flight structure and access proof.
  if (database !== pool) return assertDatabaseReadiness(database);
  readinessPromise ??= assertDatabaseReadiness(database).finally(() => {
    readinessPromise = null;
  });
  await readinessPromise;
}
