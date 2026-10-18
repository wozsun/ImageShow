import { databaseReadiness, requiredTableNames, type DatabaseReader } from "./contract.ts";

export async function assertRequiredTablesAndColumns(database: DatabaseReader) {
  const rows = (
    await database.query<{
      table_name: string;
      relation_kind: string;
      column_name: string;
      type_name: string;
      type_modifier: number;
      not_null: boolean;
      default_value: string | null;
      requires_insert_value: boolean;
    }>(
      `SELECT relation.relname AS table_name,
            relation.relkind::text AS relation_kind,
            attribute.attname AS column_name,
            type.typname AS type_name,
            attribute.atttypmod::int AS type_modifier,
            attribute.attnotnull AS not_null,
            pg_get_expr(defaults.adbin, defaults.adrelid) AS default_value,
            (attribute.attnotnull OR type.typnotnull)
              AND defaults.oid IS NULL
              AND type.typdefaultbin IS NULL
              AND attribute.attidentity = ''
              AND attribute.attgenerated = '' AS requires_insert_value
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       JOIN pg_attribute attribute
         ON attribute.attrelid=relation.oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
       JOIN pg_type type ON type.oid=attribute.atttypid
       LEFT JOIN pg_attrdef defaults
         ON defaults.adrelid=attribute.attrelid AND defaults.adnum=attribute.attnum
      WHERE namespace.nspname='public'
        AND relation.relname = ANY($1::text[])`,
      [requiredTableNames]
    )
  ).rows;

  const relationKinds = new Map(rows.map((row) => [row.table_name, row.relation_kind]));
  const invalidTables = requiredTableNames.filter((table) => {
    const kind = relationKinds.get(table);
    return kind !== "r" && kind !== "p";
  });
  if (invalidTables.length) {
    throw new Error(
      `required public tables are missing or are not base tables: ${invalidTables.join(", ")}`
    );
  }

  const actualColumns = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));
  const incompatible: string[] = [];
  const requiredExtraColumns: string[] = [];
  for (const [table, readiness] of Object.entries(databaseReadiness)) {
    for (const [column, expectedType] of Object.entries(readiness.columns)) {
      const actual = actualColumns.get(`${table}.${column}`);
      if (!actual
        || actual.type_name !== expectedType
        || actual.type_modifier !== -1
        || (table === "metadata" && /^[lms]_(width|height|byte_size|md5)$/.test(column) && !actual.not_null)) {
        incompatible.push(`${table}.${column}`);
      }
    }
    if (readiness.privileges.some((privilege) => privilege === "INSERT")) {
      for (const actual of rows) {
        if (actual.table_name === table
          && !Object.hasOwn(readiness.columns, actual.column_name)
          && actual.requires_insert_value) {
          requiredExtraColumns.push(`${table}.${actual.column_name}`);
        }
      }
    }
  }
  const theme = actualColumns.get("metadata.theme");
  if (theme && (theme.not_null || theme.default_value !== null)) {
    throw new Error("metadata.theme must be nullable without a default");
  }
  if (incompatible.length) {
    throw new Error(
      `required columns are missing or have incompatible types: ${incompatible.join(", ")}`
    );
  }
  if (requiredExtraColumns.length) {
    throw new Error(
      `extra columns require values not supplied by application INSERTs: ${requiredExtraColumns.join(", ")}`
    );
  }
}
