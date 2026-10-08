import { currentDatabaseReadiness, type DatabaseReader, type DatabaseReadinessContract } from "./readiness/contract.ts";
import { assertRequiredForeignKeys } from "./readiness/foreign-keys.ts";
import { assertRequiredUniqueIndexes } from "./readiness/indexes.ts";
import { assertRuntimeDatabaseAccess } from "./readiness/privileges.ts";
import { assertRequiredTablesAndColumns } from "./readiness/relations.ts";
import { assertRequiredSeedRows } from "./readiness/seeds.ts";
import {
  assertRequiredCheckConstraints,
  assertSupportedAuthorIdentityProviders
} from "./readiness/checks.ts";

export async function assertDatabaseReadiness(
  database: DatabaseReader,
  contract: DatabaseReadinessContract = currentDatabaseReadiness
) {
  await assertRequiredTablesAndColumns(database, contract);
  await assertRuntimeDatabaseAccess(database, contract);
  await assertRequiredUniqueIndexes(database, contract);
  await assertRequiredCheckConstraints(database);
  await assertSupportedAuthorIdentityProviders(database);
  await assertRequiredForeignKeys(database, contract);
  await assertRequiredSeedRows(database, contract);
}
