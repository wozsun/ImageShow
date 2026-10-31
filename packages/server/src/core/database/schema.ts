import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { errorMessage } from "../api-error.ts";
import { logger } from "../logger.ts";
import { assertDatabaseReadiness } from "./readiness.ts";
import { pool } from "./pools.ts";
import { applyTemporarySchemaUpgrade } from "./temporary-schema-upgrade.ts";
import { withTransactionOnClient } from "./transactions.ts";

export async function initializeDatabaseSchema() {
  const client = await pool.connect();
  try {
    await initializeDatabaseSchemaOnClient(client);
  } finally {
    client.release();
  }
}

function databaseSchemaPath() {
  const candidates = [
    join(import.meta.dirname, "..", "..", "schema.sql"),
    join(import.meta.dirname, "..", "..", "..", "schema.sql")
  ];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) {
    throw new Error("PostgreSQL database asset is missing: schema.sql");
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
  const schema = await readFile(databaseSchemaPath(), "utf8");
  const created = await withTransactionOnClient(client, async (transaction) => {
    try {
      const upgraded = empty ? [] : await applyTemporarySchemaUpgrade(transaction, schema);
      if (empty) await transaction.query(schema);
      await assertCoreDatabaseReady(transaction);
      return upgraded;
    } catch (error) {
      if (!empty) throw databaseReadinessError(error);
      throw error;
    }
  });
  if (created.length) logger.warn("database_temporary_upgrade_applied", { created });
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
