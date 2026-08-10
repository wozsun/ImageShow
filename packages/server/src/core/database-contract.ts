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
// schema.sql remains the only complete definition for clean installations.
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
  import_session: {
    columns: {
      id: "uuid",
      mode: "text",
      status: "text",
      execution_token: "uuid",
      raw_token: "uuid",
      idempotency_key: "text",
      request_hash: "text",
      storage_slug: "text",
      final_object_key: "text",
      source_url: "text",
      expected_size: "int8",
      metadata_payload: "jsonb",
      prepared_payload: "jsonb",
      error: "text",
      image_time: "timestamptz",
      expires_at: "timestamptz",
      created_at: "timestamptz",
      updated_at: "timestamptz"
    },
    privileges: readWritePrivileges
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
 * surface ImageShow currently consumes and deliberately ignores unrelated
 * tables, extra columns, defaults, constraints, triggers and indexes.
 */
export async function assertDatabaseStructure(database: DatabaseReader) {
  await assertRequiredTablesAndColumns(database);
  await assertRuntimeDatabaseAccess(database);
  await assertRequiredSeedRows(database);
}
