import { requiredPrimaryKeys, requiredTableNames, requiredUniqueIndexes, type DatabaseReader, type RequiredUniqueIndex } from "./contract.ts";
import { primaryKeyLabel, sameColumns } from "./constraint-helpers.ts";

type UniqueIndexRow = {
  table_name: string;
  columns: string[];
  is_primary: boolean;
  is_unique: boolean;
  is_valid: boolean;
  is_ready: boolean;
  is_live: boolean;
  predicate: string | null;
  expressions: string | null;
};

function normalizedPredicate(predicate: string) {
  return predicate
    .toLowerCase()
    .replaceAll("::text", "")
    .replace(/\s+/g, "");
}

function predicateMatches(
  actual: string | null,
  expected: RequiredUniqueIndex["predicate"]
) {
  if (expected === "none") return actual === null;
  if (!actual) return false;
  const normalized = normalizedPredicate(actual);
  switch (expected) {
    case "default_storage":
      return ["is_default", "is_default=true", "true=is_default"]
        .includes(normalized);
    case "non_null_idempotency":
      return normalized === "idempotency_keyisnotnull";
    case "active_cache_rebuild":
      return [
        "type='cache.rebuild'and(status=any(array['pending','running']))",
        "type='cache.rebuild'and(status=any(array['running','pending']))",
        "(status=any(array['pending','running']))andtype='cache.rebuild'",
        "(status=any(array['running','pending']))andtype='cache.rebuild'"
      ].includes(normalized);
    case "super_admin":
      return ["role='super'", "'super'=role"].includes(normalized);
  }
}
function uniqueIndexLabel(required: RequiredUniqueIndex) {
  const predicate = {
    none: "",
    default_storage: " WHERE is_default",
    non_null_idempotency: " WHERE idempotency_key IS NOT NULL",
    active_cache_rebuild:
      " WHERE type = 'cache.rebuild' AND status IN ('pending', 'running')",
    super_admin: " WHERE role = 'super'"
  }[required.predicate];
  return `${primaryKeyLabel(required)}${predicate}`;
}

export async function assertRequiredUniqueIndexes(database: DatabaseReader) {
  const rows = (await database.query<UniqueIndexRow>(
    `SELECT relation.relname AS table_name,
            ARRAY(
              SELECT attribute.attname
                FROM unnest(index_record.indkey::smallint[])
                  WITH ORDINALITY AS key(attnum, ordinal)
                JOIN pg_attribute attribute
                  ON attribute.attrelid=index_record.indrelid
                 AND attribute.attnum=key.attnum
               WHERE key.ordinal <= index_record.indnkeyatts
               ORDER BY key.ordinal
            )::text[] AS columns,
            index_record.indisprimary AS is_primary,
            index_record.indisunique AS is_unique,
            index_record.indisvalid AS is_valid,
            index_record.indisready AS is_ready,
            index_record.indislive AS is_live,
            pg_get_expr(
              index_record.indpred,
              index_record.indrelid,
              true
            ) AS predicate,
            pg_get_expr(
              index_record.indexprs,
              index_record.indrelid,
              true
            ) AS expressions
       FROM pg_index index_record
       JOIN pg_class relation ON relation.oid=index_record.indrelid
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public'
        AND relation.relname=ANY($1::text[])
        AND index_record.indisunique`,
    [requiredTableNames]
  )).rows;
  const usable = (row: UniqueIndexRow) => (
    row.is_unique
    && row.is_valid
    && row.is_ready
    && row.is_live
    && row.expressions === null
  );
  const missingPrimaryKeys = requiredPrimaryKeys.filter((required) => (
    !rows.some((row) => (
      usable(row)
      && row.is_primary
      && row.table_name === required.table
      && sameColumns(row.columns, required.columns)
      && row.predicate === null
    ))
  ));
  if (missingPrimaryKeys.length) {
    throw new Error(
      `required primary keys are missing or invalid: ${missingPrimaryKeys
        .map(primaryKeyLabel)
        .join(", ")}`
    );
  }

  const missingUniqueIndexes = requiredUniqueIndexes.filter((required) => (
    !rows.some((row) => (
      usable(row)
      && row.table_name === required.table
      && sameColumns(row.columns, required.columns)
      && predicateMatches(row.predicate, required.predicate)
    ))
  ));
  if (missingUniqueIndexes.length) {
    throw new Error(
      `required unique indexes are missing or invalid: ${missingUniqueIndexes
        .map(uniqueIndexLabel)
        .join(", ")}`
    );
  }
}
