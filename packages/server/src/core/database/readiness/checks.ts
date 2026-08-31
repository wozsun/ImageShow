import { appConfig } from "@imageshow/shared";
import { sameColumns } from "./constraint-helpers.ts";
import type { DatabaseReader } from "./contract.ts";

type CheckConstraintRow = {
  columns: string[];
  definition: string;
  is_validated: boolean;
};

function normalizedExpression(value: string) {
  return value.toLowerCase().replaceAll("::text", "").replace(/\s+/gu, "");
}

function orderedPairs(left: string, right: string) {
  return [`${left}and${right}`, `${right}and${left}`];
}

function orderedTriples(first: string, second: string, third: string) {
  return [
    `${first}and${second}and${third}`,
    `${first}and${third}and${second}`,
    `${second}and${first}and${third}`,
    `${second}and${third}and${first}`,
    `${third}and${first}and${second}`,
    `${third}and${second}and${first}`
  ];
}

function isIdentityPairCheck(row: CheckConstraintRow) {
  if (!sameColumns(row.columns, ["identity_provider", "identity_id"])) {
    return false;
  }
  const expression = normalizedExpression(row.definition);
  const nullPairs = orderedPairs(
    "identity_providerisnull",
    "identity_idisnull"
  );
  const valuePairs = orderedPairs(
    "identity_providerisnotnull",
    "identity_idisnotnull"
  );
  return nullPairs.some((nullPair) => valuePairs.some((valuePair) => (
    expression === `${nullPair}or${valuePair}`
    || expression === `${valuePair}or${nullPair}`
  )));
}

function isIdentityProviderTokenCheck(row: CheckConstraintRow) {
  if (!sameColumns(row.columns, ["identity_provider"])) return false;
  const expression = normalizedExpression(row.definition);
  const nullable = "identity_providerisnull";
  const pattern = "identity_provider~'^[a-z0-9]+(?:-[a-z0-9]+)*$'";
  const boundedBodies = [
    ...orderedTriples(
      "char_length(identity_provider)>=1",
      "char_length(identity_provider)<=32",
      pattern
    ),
    ...orderedPairs(
      "char_length(identity_provider)between1and32",
      pattern
    )
  ];
  return boundedBodies.some((body) => (
    expression === `${nullable}or${body}`
    || expression === `${body}or${nullable}`
  ));
}

function isIdentityIdNonemptyCheck(row: CheckConstraintRow) {
  if (!sameColumns(row.columns, ["identity_id"])) return false;
  const expression = normalizedExpression(row.definition);
  return [
    "identity_idisnullorchar_length(identity_id)>0",
    "char_length(identity_id)>0oridentity_idisnull"
  ].includes(expression);
}

export async function assertRequiredCheckConstraints(database: DatabaseReader) {
  const rows = (await database.query<CheckConstraintRow>(
    `SELECT ARRAY(
              SELECT attribute.attname
                FROM unnest(constraint_record.conkey)
                  WITH ORDINALITY AS key(attnum, ordinal)
                JOIN pg_attribute attribute
                  ON attribute.attrelid=constraint_record.conrelid
                 AND attribute.attnum=key.attnum
               ORDER BY key.ordinal
            )::text[] AS columns,
            pg_get_expr(
              constraint_record.conbin,
              constraint_record.conrelid,
              true
            ) AS definition,
            constraint_record.convalidated AS is_validated
       FROM pg_constraint constraint_record
       JOIN pg_class relation ON relation.oid=constraint_record.conrelid
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public'
        AND relation.relname='author'
        AND constraint_record.contype='c'`
  )).rows.filter((row) => row.is_validated);

  const missing = [
    ["author identity null pairing", isIdentityPairCheck],
    ["author identity provider token", isIdentityProviderTokenCheck],
    ["author identity nonempty ID", isIdentityIdNonemptyCheck]
  ].flatMap(([label, matches]) => (
    rows.some(matches as (row: CheckConstraintRow) => boolean)
      ? []
      : [label as string]
  ));
  if (missing.length) {
    throw new Error(
      `required CHECK constraints are missing or invalid: ${missing.join(", ")}`
    );
  }
}

export async function assertSupportedAuthorIdentityProviders(
  database: DatabaseReader
) {
  const result = await database.query<{ unsupported: boolean }>(
    `SELECT EXISTS(
              SELECT 1
                FROM author
               WHERE identity_provider IS NOT NULL
                 AND NOT (identity_provider=ANY($1::text[]))
            ) AS unsupported`,
    [appConfig.authorIdentity.providers]
  );
  if (result.rows[0]?.unsupported) {
    throw new Error("unsupported author identity providers are present");
  }
}
