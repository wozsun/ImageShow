import type { PoolClient } from "pg";

type DatabaseReader = Pick<PoolClient, "query">;
type PostgreSqlType =
  | "_text"
  | "bool"
  | "int2"
  | "int4"
  | "int8"
  | "jsonb"
  | "text"
  | "timestamptz"
  | "uuid";
type TablePrivilege = "SELECT" | "INSERT" | "UPDATE" | "DELETE";
type TableReadiness = {
  columns: Record<string, PostgreSqlType>;
  privileges: readonly TablePrivilege[];
};

const readWritePrivileges = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

// This is deliberately limited to columns referenced by current runtime SQL.
// Clean installations are defined by the sealed schema.sql baseline together
// with the current release's schema-additions.sql.
const databaseReadiness = {
  storage_backend: {
    columns: {
      slug: "text",
      display_name: "text",
      type: "text",
      config: "jsonb",
      namespace_identities: "_text",
      enabled: "bool",
      is_default: "bool",
      sort_order: "int4",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  theme: {
    columns: {
      slug: "text",
      display_name: "text",
      sort_order: "int4",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  tag: {
    columns: {
      slug: "text",
      display_name: "text",
      sort_order: "int4",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  author: {
    columns: {
      slug: "text",
      display_name: "text",
      link: "text",
      sort_order: "int4",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  metadata: {
    columns: {
      id: "uuid",
      status: "text",
      storage_slug: "text",
      object_key: "text",
      device: "text",
      brightness: "text",
      theme: "text",
      author: "text",
      ext: "text",
      md5: "text",
      width: "int4",
      height: "int4",
      image_size: "int8",
      thumbnail_size: "int8",
      title: "text",
      description: "text",
      source: "text",
      original: "text",
      image_time: "timestamptz",
      deleted_at: "timestamptz",
      purge_state: "text",
      purge_started_at: "timestamptz",
      purge_attempts: "int4",
      purge_error: "text",
      created_by: "text",
      created_at: "timestamptz",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  image_tag: {
    columns: {
      image_id: "uuid",
      tag_slug: "text"
    },
    privileges: ["SELECT", "INSERT", "DELETE"]
  },
  ready_image_revision: {
    columns: {
      singleton: "int2",
      revision: "int8",
      updated_at: "timestamptz"
    },
    privileges: ["SELECT", "UPDATE"]
  },
  background_job: {
    columns: {
      id: "uuid",
      type: "text",
      status: "text",
      execution_token: "uuid",
      target_id: "text",
      idempotency_key: "text",
      payload: "jsonb",
      error: "text",
      retry_count: "int4",
      next_retry_at: "timestamptz",
      created_at: "timestamptz",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  },
  admin_account: {
    columns: {
      username: "text",
      password_hash: "text",
      role: "text",
      preferences: "jsonb",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
  }
} as const satisfies Record<string, TableReadiness>;

const requiredTableNames = Object.keys(databaseReadiness);

type RequiredPrimaryKey = {
  table: string;
  columns: readonly string[];
};

type RequiredUniqueIndex = RequiredPrimaryKey & {
  predicate:
    | "none"
    | "default_storage"
    | "nonempty_final_object"
    | "non_null_idempotency"
    | "active_cache_rebuild"
    | "super_admin";
};

type RequiredForeignKey = {
  table: string;
  columns: readonly string[];
  referencedTable: string;
  referencedColumns: readonly string[];
  onDelete: "r" | "c" | "n";
};

const requiredPrimaryKeys = [
  { table: "storage_backend", columns: ["slug"] },
  { table: "theme", columns: ["slug"] },
  { table: "tag", columns: ["slug"] },
  { table: "author", columns: ["slug"] },
  { table: "metadata", columns: ["id"] },
  { table: "image_tag", columns: ["image_id", "tag_slug"] },
  { table: "ready_image_revision", columns: ["singleton"] },
  { table: "background_job", columns: ["id"] },
  { table: "admin_account", columns: ["username"] }
] as const satisfies readonly RequiredPrimaryKey[];

const requiredUniqueIndexes = [
  {
    table: "metadata",
    columns: ["object_key"],
    predicate: "none"
  },
  {
    table: "background_job",
    columns: ["idempotency_key"],
    predicate: "non_null_idempotency"
  },
  {
    table: "background_job",
    columns: ["type"],
    predicate: "active_cache_rebuild"
  },
  {
    table: "storage_backend",
    columns: ["is_default"],
    predicate: "default_storage"
  },
  {
    table: "admin_account",
    columns: ["role"],
    predicate: "super_admin"
  }
] as const satisfies readonly RequiredUniqueIndex[];

const requiredForeignKeys = [
  {
    table: "metadata",
    columns: ["storage_slug"],
    referencedTable: "storage_backend",
    referencedColumns: ["slug"],
    onDelete: "r"
  },
  {
    table: "metadata",
    columns: ["theme"],
    referencedTable: "theme",
    referencedColumns: ["slug"],
    onDelete: "r"
  },
  {
    table: "metadata",
    columns: ["author"],
    referencedTable: "author",
    referencedColumns: ["slug"],
    onDelete: "n"
  },
  {
    table: "image_tag",
    columns: ["image_id"],
    referencedTable: "metadata",
    referencedColumns: ["id"],
    onDelete: "c"
  },
  {
    table: "image_tag",
    columns: ["tag_slug"],
    referencedTable: "tag",
    referencedColumns: ["slug"],
    onDelete: "c"
  }
] as const satisfies readonly RequiredForeignKey[];

async function assertRequiredTablesAndColumns(database: DatabaseReader) {
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

async function assertRuntimeDatabaseAccess(database: DatabaseReader) {
  const session = (await database.query<{
    transaction_read_only: string;
    public_schema_usage: boolean;
  }>(
    `SELECT current_setting('transaction_read_only') AS transaction_read_only,
            has_schema_privilege(current_user, 'public', 'USAGE')
              AS public_schema_usage`
  )).rows[0];
  if (
    session?.transaction_read_only !== "off"
    || !session.public_schema_usage
  ) {
    throw new Error(
      `database session cannot run ImageShow writes: `
        + `transaction_read_only=${session?.transaction_read_only ?? "unknown"}, `
        + `public_schema_usage=${session?.public_schema_usage ?? false}`
    );
  }

  const required = Object.entries(databaseReadiness).flatMap(
    ([table, readiness]) => readiness.privileges.map((privilege) => ({
      table,
      privilege
    }))
  );
  const rows = (await database.query<{
    table_name: string;
    privilege_name: string;
    allowed: boolean;
  }>(
    `SELECT required.table_name,
            required.privilege_name,
            has_table_privilege(
              current_user,
              format('public.%I', required.table_name),
              required.privilege_name
            ) AS allowed
       FROM unnest($1::text[], $2::text[])
         AS required(table_name, privilege_name)`,
    [
      required.map(({ table }) => table),
      required.map(({ privilege }) => privilege)
    ]
  )).rows;
  const missing = rows.filter((row) => !row.allowed);
  if (missing.length) {
    throw new Error(
      `database role lacks required table privileges: `
        + missing
          .map((row) => `${row.table_name}.${row.privilege_name}`)
          .join(", ")
    );
  }
}

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

function sameColumns(actual: readonly string[], expected: readonly string[]) {
  return actual.length === expected.length
    && actual.every((column, index) => column === expected[index]);
}

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
    case "nonempty_final_object":
      return [
        "final_object_key<>''",
        "''<>final_object_key",
        "final_object_key!=''"
      ].includes(normalized);
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

function primaryKeyLabel(required: RequiredPrimaryKey) {
  return `${required.table}(${required.columns.join(", ")})`;
}

function uniqueIndexLabel(required: RequiredUniqueIndex) {
  const predicate = {
    none: "",
    default_storage: " WHERE is_default",
    nonempty_final_object: " WHERE final_object_key <> ''",
    non_null_idempotency: " WHERE idempotency_key IS NOT NULL",
    active_cache_rebuild:
      " WHERE type = 'cache.rebuild' AND status IN ('pending', 'running')",
    super_admin: " WHERE role = 'super'"
  }[required.predicate];
  return `${primaryKeyLabel(required)}${predicate}`;
}

async function assertRequiredUniqueIndexes(database: DatabaseReader) {
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

async function assertRequiredForeignKeys(database: DatabaseReader) {
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

async function assertRequiredSeedRows(database: DatabaseReader) {
  const row = (await database.query<{
    revision_ready: boolean;
    local_storage_ready: boolean;
    none_theme_ready: boolean;
    unsupported_storage_types: string[];
  }>(
    `SELECT (
              SELECT count(*)=1
                 AND bool_and(singleton=1 AND revision >= 0)
                FROM ready_image_revision
            ) AS revision_ready,
            EXISTS (
              SELECT 1 FROM storage_backend
               WHERE slug='local' AND type='local'
            ) AS local_storage_ready,
            EXISTS (
              SELECT 1 FROM theme WHERE slug='none'
            ) AS none_theme_ready,
            ARRAY(
              SELECT DISTINCT type
                FROM storage_backend
               WHERE type NOT IN ('local', 's3')
               ORDER BY type
            ) AS unsupported_storage_types`
  )).rows[0];
  const missing = [
    !row?.revision_ready && "ready_image_revision singleton",
    !row?.local_storage_ready && "storage_backend.local",
    !row?.none_theme_ready && "theme.none"
  ].filter((value): value is string => Boolean(value));
  if (missing.length) {
    throw new Error(
      `required seed rows are missing or invalid: ${missing.join(", ")}`
    );
  }
  if (row.unsupported_storage_types.length) {
    throw new Error(
      `unsupported storage backend types: ${row.unsupported_storage_types.join(", ")}`
    );
  }
}

/**
 * Read-only readiness for an existing database. It verifies only the runtime
 * surface ImageShow currently consumes: columns and access, behavioral primary
 * keys, uniqueness, foreign-key delete actions, and stable seed rows. It
 * deliberately ignores unrelated objects and schema-wide cosmetic details.
 */
export async function assertDatabaseReadiness(database: DatabaseReader) {
  await assertRequiredTablesAndColumns(database);
  await assertRuntimeDatabaseAccess(database);
  await assertRequiredUniqueIndexes(database);
  await assertRequiredForeignKeys(database);
  await assertRequiredSeedRows(database);
}
