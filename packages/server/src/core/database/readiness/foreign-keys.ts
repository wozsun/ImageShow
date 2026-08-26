import { requiredForeignKeys, requiredTableNames, type DatabaseReader, type RequiredForeignKey } from "./contract.ts";
import { primaryKeyLabel, sameColumns } from "./constraint-helpers.ts";

type ForeignKeyRow = {
  table_name: string;
  columns: string[];
  referenced_table: string;
  referenced_columns: string[];
  on_delete: string;
  is_validated: boolean;
};

function foreignKeyLabel(required: RequiredForeignKey) {
  const action = {
    r: "RESTRICT",
    c: "CASCADE",
    n: "SET NULL"
  }[required.onDelete];
  return `${primaryKeyLabel(required)} -> `
    + `${required.referencedTable}(${required.referencedColumns.join(", ")}) `
    + `ON DELETE ${action}`;
}

export async function assertRequiredForeignKeys(database: DatabaseReader) {
  const rows = (await database.query<ForeignKeyRow>(
    `SELECT source.relname AS table_name,
            ARRAY(
              SELECT attribute.attname
                FROM unnest(constraint_record.conkey)
                  WITH ORDINALITY AS key(attnum, ordinal)
                JOIN pg_attribute attribute
                  ON attribute.attrelid=constraint_record.conrelid
                 AND attribute.attnum=key.attnum
               ORDER BY key.ordinal
            )::text[] AS columns,
            target.relname AS referenced_table,
            ARRAY(
              SELECT attribute.attname
                FROM unnest(constraint_record.confkey)
                  WITH ORDINALITY AS key(attnum, ordinal)
                JOIN pg_attribute attribute
                  ON attribute.attrelid=constraint_record.confrelid
                 AND attribute.attnum=key.attnum
               ORDER BY key.ordinal
            )::text[] AS referenced_columns,
            constraint_record.confdeltype::text AS on_delete,
            constraint_record.convalidated AS is_validated
       FROM pg_constraint constraint_record
       JOIN pg_class source ON source.oid=constraint_record.conrelid
       JOIN pg_namespace namespace ON namespace.oid=source.relnamespace
       JOIN pg_class target ON target.oid=constraint_record.confrelid
       JOIN pg_namespace target_namespace
         ON target_namespace.oid=target.relnamespace
      WHERE namespace.nspname='public'
        AND target_namespace.nspname='public'
        AND source.relname=ANY($1::text[])
        AND constraint_record.contype='f'`,
    [requiredTableNames]
  )).rows;
  const missing = requiredForeignKeys.filter((required) => (
    !rows.some((row) => (
      row.is_validated
      && row.table_name === required.table
      && sameColumns(row.columns, required.columns)
      && row.referenced_table === required.referencedTable
      && sameColumns(row.referenced_columns, required.referencedColumns)
      && row.on_delete === required.onDelete
    ))
  ));
  if (missing.length) {
    throw new Error(
      `required foreign keys are missing or invalid: ${missing
        .map(foreignKeyLabel)
        .join(", ")}`
    );
  }
}
