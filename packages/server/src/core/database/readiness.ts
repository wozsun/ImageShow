import type { DatabaseReader } from "./readiness/contract.ts";
import { assertRequiredForeignKeys } from "./readiness/foreign-keys.ts";
import { assertRequiredUniqueIndexes } from "./readiness/indexes.ts";
import { assertRuntimeDatabaseAccess } from "./readiness/privileges.ts";
import { assertRequiredTablesAndColumns } from "./readiness/relations.ts";
import { assertRequiredSeedRows } from "./readiness/seeds.ts";
import {
  assertRequiredCheckConstraints,
  assertSupportedAuthorIdentityProviders
} from "./readiness/checks.ts";

export async function assertDatabaseReadiness(database: DatabaseReader) {
  await assertRequiredTablesAndColumns(database);
  await assertRuntimeDatabaseAccess(database);
  await assertRequiredUniqueIndexes(database);
  await assertRequiredCheckConstraints(database);
  await assertSupportedAuthorIdentityProviders(database);
  await assertRequiredForeignKeys(database);
  await assertRequiredSeedRows(database);
}
