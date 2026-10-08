import type { PoolClient } from "pg";
import { currentDatabaseReadiness, type DatabaseReadinessContract } from "./readiness/contract.ts";
import { assertDatabaseReadiness } from "./readiness.ts";

const groupTables = new Set(["image_group", "image_group_member"]);
const previousReadiness: DatabaseReadinessContract = {
  ...currentDatabaseReadiness,
  tables: Object.fromEntries(Object.entries(currentDatabaseReadiness.tables)
    .filter(([table]) => !groupTables.has(table))
    .map(([table, value]) => [table === "projection_revision" ? "ready_image_revision" : table, value])),
  primaryKeys: currentDatabaseReadiness.primaryKeys.filter(({ table }) => !groupTables.has(table))
    .map((key) => ({ ...key, table: key.table === "projection_revision" ? "ready_image_revision" : key.table })),
  foreignKeys: currentDatabaseReadiness.foreignKeys.filter(({ table }) => !groupTables.has(table)),
  revisionTable: "ready_image_revision"
};

/** Called inside the startup transaction. Removed together with its SQL in 6.8.1. */
export async function upgradeDatabaseFrom679(client: PoolClient, readSql: () => Promise<string>) {
  const shape = (await client.query<{
    groups: string | null; members: string | null; previous: string | null; current: string | null;
  }>(`SELECT to_regclass('public.image_group')::text AS groups,
             to_regclass('public.image_group_member')::text AS members,
             to_regclass('public.ready_image_revision')::text AS previous,
             to_regclass('public.projection_revision')::text AS current`)).rows[0]!;
  if (shape.previous && (shape.groups || shape.members || shape.current)) {
    throw new Error("incomplete 6.8.0 database upgrade: old revision table coexists with new structure");
  }
  if (shape.groups || shape.members || !shape.previous || shape.current) return false;
  // A partial or incompatible old schema must fail before any DDL is attempted.
  await assertDatabaseReadiness(client, previousReadiness);
  try {
    await client.query(await readSql());
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "42501") {
      throw new Error("PostgreSQL 6.8.0 upgrade needs DDL privileges; execute schema-upgrade-6.8.0.sql manually before restarting", { cause: error });
    }
    throw error;
  }
  return true;
}
