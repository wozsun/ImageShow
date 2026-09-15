import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { assertDatabaseReadiness } from "./readiness.ts";
import { pool } from "./pools.ts";
import { upgradeTrashPurgeFor644 } from "./upgrade-6.4.4.ts";
import { logger } from "../logger.ts";

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
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `PostgreSQL database is non-empty but is not ready for the current application: ${reason}`,
    { cause: error }
  );
}

async function initializeDatabaseSchemaOnClient(client: PoolClient) {
  const empty = await databaseHasNoUserRelations(client);
  const schema = empty
    ? await readFile(databaseSchemaPath(), "utf8")
    : null;
  let upgrade: Awaited<ReturnType<typeof upgradeTrashPurgeFor644>> = null;
  await client.query("BEGIN");
  try {
    if (schema) await client.query(schema);
    upgrade = schema ? null : await upgradeTrashPurgeFor644(client);
    await assertCoreDatabaseReady(client);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (!empty) throw databaseReadinessError(error);
    throw error;
  }
  if (upgrade) logger.info("database_upgrade_6_4_4_completed", upgrade);
}

export async function pingDatabase() {
  await pool.query("SELECT 1");
}

let readinessPromise: Promise<void> | null = null;

export async function assertCoreDatabaseReady(
  database: Pick<PoolClient, "query"> = pool
) {
  // Initialization owns a dedicated transaction; only concurrent checks using
  // the shared pool can share the same in-flight structure and access proof.
  if (database !== pool) return assertDatabaseReadiness(database);
  readinessPromise ??= assertDatabaseReadiness(database).finally(() => {
    readinessPromise = null;
  });
  await readinessPromise;
}
