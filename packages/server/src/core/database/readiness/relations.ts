import { databaseReadiness, requiredTableNames, type DatabaseReader } from "./contract.ts";

export async function assertRequiredTablesAndColumns(database: DatabaseReader) {
  const rows = (await database.query<{
    table_name: string;
    relation_kind: string;
    column_name: string;
    type_name: string;
    type_modifier: number;
  }>(
    `SELECT relation.relname AS table_name,
            relation.relkind::text AS relation_kind,
            attribute.attname AS column_name,
            type.typname AS type_name,
            attribute.atttypmod::int AS type_modifier
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       JOIN pg_attribute attribute
         ON attribute.attrelid=relation.oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
       JOIN pg_type type ON type.oid=attribute.atttypid
      WHERE namespace.nspname='public'
        AND relation.relname = ANY($1::text[])`,
    [requiredTableNames]
  )).rows;

  const relationKinds = new Map(
    rows.map((row) => [row.table_name, row.relation_kind])
  );
  const invalidTables = requiredTableNames.filter((table) => {
    const kind = relationKinds.get(table);
    return kind !== "r" && kind !== "p";
  });
  if (invalidTables.length) {
    throw new Error(
      `required public tables are missing or are not base tables: ${invalidTables.join(", ")}`
    );
  }

  const actualColumns = new Map(
    rows.map((row) => [`${row.table_name}.${row.column_name}`, row])
  );
  const incompatible: string[] = [];
  for (const [table, readiness] of Object.entries(databaseReadiness)) {
    for (const [column, expectedType] of Object.entries(readiness.columns)) {
      const actual = actualColumns.get(`${table}.${column}`);
      if (
        !actual
        || actual.type_name !== expectedType
        || actual.type_modifier !== -1
      ) {
        incompatible.push(`${table}.${column}`);
      }
    }
  }
  if (incompatible.length) {
    throw new Error(
      `required columns are missing or have incompatible types: ${incompatible.join(", ")}`
    );
  }
}
