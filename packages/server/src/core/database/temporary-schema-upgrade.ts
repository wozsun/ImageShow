import { errorMessage } from "../api-error.ts";
import type { DatabaseReader } from "./readiness/contract.ts";

// Temporary exception to "existing databases are maintained by hand" for
// 6.9.0 – 6.9.1 only; 6.9.2 deletes this module. The statements come from the
// marked section of schema.sql, so the upgrade and a clean install create the
// same objects from one text.
const sectionStart = "-- BEGIN 6.9 analytics tables";
const sectionEnd = "-- END 6.9 analytics tables";
const createdObjectPattern = /^CREATE (?:UNIQUE )?(?:TABLE|INDEX) IF NOT EXISTS (\w+)/gmu;

function upgradeSection(schema: string) {
  const start = schema.indexOf(sectionStart);
  const end = schema.indexOf(sectionEnd);
  if (start < 0 || end < start) {
    throw new Error("schema.sql is missing the 6.9 analytics section");
  }
  const section = schema.slice(start, end);
  const objects = [...section.matchAll(createdObjectPattern)].map((match) => match[1]!);
  if (!objects.length) throw new Error("schema.sql 6.9 analytics section creates no objects");
  return { section, objects };
}

/**
 * Creates the 6.9 tables and indexes that an existing database lacks, inside
 * the startup transaction and before readiness. Existing objects are neither
 * altered nor read; a table whose structure differs is left to readiness. The
 * section runs only when an object is missing, because PostgreSQL checks the
 * schema CREATE privilege even for IF NOT EXISTS on an existing table.
 */
export async function applyTemporarySchemaUpgrade(database: DatabaseReader, schema: string) {
  const { section, objects } = upgradeSection(schema);
  const missing = (
    await database.query<{ name: string }>(
      `SELECT name
         FROM unnest($1::text[]) AS required(name)
        WHERE to_regclass(format('public.%I', name)) IS NULL`,
      [objects]
    )
  ).rows.map((row) => row.name);
  if (!missing.length) return [];
  try {
    await database.query(section);
  } catch (error) {
    throw new Error(
      `cannot create the 6.9 analytics tables (${missing.join(", ")}): ${errorMessage(error)}; ` +
        `the application role needs CREATE on schema public, or a database owner runs the "${sectionStart}" ` +
        "section of this release's schema.sql and grants the application role SELECT, INSERT, UPDATE and DELETE on the new tables first",
      { cause: error }
    );
  }
  return missing;
}
