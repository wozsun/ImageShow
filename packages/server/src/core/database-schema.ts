import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { assertDatabaseReadiness } from "./database-readiness.ts";
import { withAdvisoryLock } from "./database-advisory-locks.ts";
import { pool } from "./database-pools.ts";

export function initializeDatabaseSchema() {
  return withAdvisoryLock(
    "imageshow:schema-bootstrap",
    (signal, client) => initializeDatabaseSchemaUnderLock(signal, client)
  );
}

type DatabaseAsset = "schema.sql" | "schema-additions.sql";

function databaseAssetPath(asset: DatabaseAsset) {
  const candidates = [
    join(import.meta.dirname, "..", asset),
    join(import.meta.dirname, "..", "..", asset)
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
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `PostgreSQL database is non-empty but is not ready for the current application: ${reason}`,
    { cause: error }
  );
}

async function initializeDatabaseSchemaUnderLock(
  signal: AbortSignal,
  client: PoolClient
) {
  signal.throwIfAborted();
  const empty = await databaseHasNoUserRelations(client);
  const [schema, additions] = await Promise.all([
    empty
      ? readFile(databaseAssetPath("schema.sql"), "utf8")
      : Promise.resolve(null),
    readFile(databaseAssetPath("schema-additions.sql"), "utf8")
  ]);
  signal.throwIfAborted();
  await client.query("BEGIN");
  try {
    if (schema) await client.query(schema);
    signal.throwIfAborted();
    await client.query(additions);
    signal.throwIfAborted();
    await assertCoreDatabaseReady(client);
    signal.throwIfAborted();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (!empty) throw databaseReadinessError(error);
    throw error;
  }
}

export async function pingDatabase() {
  await pool.query("SELECT 1");
}

export async function assertCoreDatabaseReady(
  database: Pick<PoolClient, "query"> = pool
) {
  await assertDatabaseReadiness(database);
}
