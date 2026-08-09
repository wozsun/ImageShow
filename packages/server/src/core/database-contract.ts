import type { PoolClient } from "pg";

export const databaseSchemaContractRevision = 1;

type DatabaseReader = Pick<PoolClient, "query">;

type ColumnContract = {
  udtName: string;
  formattedType: string;
  nullable: boolean;
  defaultExpression: string | null;
};

const formattedTypes = {
  _text: "text[]",
  bool: "boolean",
  int2: "smallint",
  int4: "integer",
  int8: "bigint",
  jsonb: "jsonb",
  text: "text",
  timestamptz: "timestamp with time zone",
  uuid: "uuid"
} as const;

function column(
  udtName: string,
  defaultExpression: string | null = null,
  nullable = false
): ColumnContract {
  const formattedType = formattedTypes[
    udtName as keyof typeof formattedTypes
  ];
  if (!formattedType) throw new Error(`Unsupported contract type: ${udtName}`);
  return { udtName, formattedType, nullable, defaultExpression };
}

const allowedLegacyDatabaseColumns = new Map<string, ColumnContract>([
  ["metadata.extra", column("jsonb", "'{}'::jsonb")],
  ["background_job.result", column("jsonb", "'{}'::jsonb")]
]);

const requiredDatabaseColumns = {
  storage_backend: {
    slug: column("text"),
    display_name: column("text", "''::text"),
    type: column("text", "'local'::text"),
    config: column("jsonb", "'{}'::jsonb"),
    namespace_identities: column("_text", "'{}'::text[]"),
    enabled: column("bool", "true"),
    is_default: column("bool", "false"),
    sort_order: column("int4", "0"),
    created_at: column("timestamptz", "now()"),
    updated_at: column("timestamptz", "now()")
  },
  theme: {
    slug: column("text"),
    display_name: column("text", "''::text"),
    sort_order: column("int4", "0"),
    created_at: column("timestamptz", "now()"),
    updated_at: column("timestamptz", "now()")
  },
  tag: {
    slug: column("text"),
    display_name: column("text", "''::text"),
    sort_order: column("int4", "0"),
    created_at: column("timestamptz", "now()"),
    updated_at: column("timestamptz", "now()")
  },
  author: {
    slug: column("text"),
    display_name: column("text", "''::text"),
    link: column("text", "''::text"),
    sort_order: column("int4", "0"),
    created_at: column("timestamptz", "now()"),
    updated_at: column("timestamptz", "now()")
  },
  metadata: {
    id: column("uuid"),
    status: column("text", "'ready'::text"),
    storage_slug: column("text"),
    object_key: column("text"),
    device: column("text"),
    brightness: column("text"),
    theme: column("text", "'none'::text"),
    author: column("text", null, true),
    ext: column("text"),
    md5: column("text"),
    width: column("int4", "0"),
    height: column("int4", "0"),
    image_size: column("int8", "0"),
    thumbnail_size: column("int8", "0"),
    title: column("text", "''::text"),
    description: column("text", "''::text"),
    source: column("text", "''::text"),
    original: column("text", "''::text"),
    image_time: column("timestamptz", "now()"),
    deleted_at: column("timestamptz", null, true),
    purge_state: column("text", "'idle'::text"),
    purge_started_at: column("timestamptz", null, true),
    purge_attempts: column("int4", "0"),
    purge_error: column("text", null, true),
    created_at: column("timestamptz", "now()"),
    updated_at: column("timestamptz", "now()")
  },
  image_tag: {
    image_id: column("uuid"),
    tag_slug: column("text"),
    created_at: column("timestamptz", "now()")
  },
  ready_image_revision: {
    singleton: column("int2", "1"),
    revision: column("int8", "0"),
    updated_at: column("timestamptz", "clock_timestamp()")
  },
  import_session: {
    id: column("uuid"),
    mode: column("text"),
    status: column("text", "'created'::text"),
    execution_token: column("uuid", null, true),
    raw_token: column("uuid", null, true),
    idempotency_key: column("text"),
    request_hash: column("text", "''::text"),
    storage_slug: column("text"),
    final_object_key: column("text", "''::text"),
    source_url: column("text", "''::text"),
    expected_size: column("int8", null, true),
    metadata_payload: column("jsonb", "'{}'::jsonb"),
    prepared_payload: column("jsonb", "'{}'::jsonb"),
    error: column("text", "''::text"),
    image_time: column("timestamptz", "now()"),
    expires_at: column("timestamptz"),
    created_at: column("timestamptz", "now()"),
    updated_at: column("timestamptz", "now()")
  },
  background_job: {
    id: column("uuid"),
    type: column("text"),
    status: column("text", "'pending'::text"),
    execution_token: column("uuid", null, true),
    target_id: column("text", "''::text"),
    idempotency_key: column("text", null, true),
    payload: column("jsonb", "'{}'::jsonb"),
    error: column("text", "''::text"),
    retry_count: column("int4", "0"),
    next_retry_at: column("timestamptz", null, true),
    created_at: column("timestamptz", "now()"),
    updated_at: column("timestamptz", "now()")
  },
  admin_account: {
    username: column("text"),
    password_hash: column("text"),
    role: column("text", "'image'::text"),
    preferences: column("jsonb", "'{}'::jsonb"),
    created_at: column("timestamptz", "now()"),
    updated_at: column("timestamptz", "now()")
  }
} as const;

const readinessRelations = Object.keys(requiredDatabaseColumns);

const requiredTablePrivileges = {
  storage_backend: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  theme: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  tag: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  author: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  metadata: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  image_tag: ["SELECT", "INSERT", "DELETE"],
  ready_image_revision: ["SELECT", "UPDATE"],
  import_session: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  background_job: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  admin_account: ["SELECT", "INSERT", "UPDATE", "DELETE"]
} as const;

function normalizeDefinition(definition: string | null) {
  if (!definition) return "";
  // PostgreSQL already emits a canonical keyword/identifier shape here. Only
  // collapse formatting whitespace outside quoted tokens; literals and quoted
  // identifiers remain byte-for-byte significant.
  let normalized = "";
  let quote: "'" | '"' | "" = "";
  let pendingSpace = false;
  for (let index = 0; index < definition.length; index += 1) {
    const character = definition[index] ?? "";
    if (quote) {
      normalized += character;
      if (character !== quote) continue;
      if (definition[index + 1] === quote) {
        normalized += quote;
        index += 1;
      } else {
        quote = "";
      }
      continue;
    }
    if (/\s/u.test(character)) {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) normalized += " ";
    pendingSpace = false;
    normalized += character;
    if (character === "'" || character === '"') quote = character;
  }
  return normalized;
}

const requiredRelationalConstraints = [
  ["storage_backend", "PRIMARY KEY (slug)"],
  ["theme", "PRIMARY KEY (slug)"],
  ["tag", "PRIMARY KEY (slug)"],
  ["author", "PRIMARY KEY (slug)"],
  ["metadata", "PRIMARY KEY (id)"],
  ["metadata", "UNIQUE (object_key)"],
  ["metadata", "FOREIGN KEY (storage_slug) REFERENCES storage_backend(slug) ON DELETE RESTRICT"],
  ["metadata", "FOREIGN KEY (theme) REFERENCES theme(slug) ON DELETE RESTRICT"],
  ["metadata", "FOREIGN KEY (author) REFERENCES author(slug) ON DELETE SET NULL"],
  ["image_tag", "PRIMARY KEY (image_id, tag_slug)"],
  ["image_tag", "FOREIGN KEY (image_id) REFERENCES metadata(id) ON DELETE CASCADE"],
  ["image_tag", "FOREIGN KEY (tag_slug) REFERENCES tag(slug) ON DELETE CASCADE"],
  ["ready_image_revision", "PRIMARY KEY (singleton)"],
  ["import_session", "PRIMARY KEY (id)"],
  ["import_session", "UNIQUE (idempotency_key)"],
  ["import_session", "FOREIGN KEY (storage_slug) REFERENCES storage_backend(slug) ON DELETE RESTRICT"],
  ["background_job", "PRIMARY KEY (id)"],
  ["admin_account", "PRIMARY KEY (username)"]
] as const;

const requiredCheckConstraints = [
  ["storage_backend", "CHECK (length(slug) <= 32)"],
  ["storage_backend", "CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'::text)"],
  ["storage_backend", "CHECK (length(display_name) <= 64)"],
  ["storage_backend", "CHECK (type = ANY (ARRAY['local'::text, 's3'::text, 'webdav'::text]))"],
  ["theme", "CHECK (length(slug) <= 32)"],
  ["theme", "CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'::text)"],
  ["theme", "CHECK (length(display_name) <= 64)"],
  ["tag", "CHECK (length(slug) <= 32)"],
  ["tag", "CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'::text)"],
  ["tag", "CHECK (length(display_name) <= 64)"],
  ["author", "CHECK (length(slug) <= 32)"],
  ["author", "CHECK (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'::text)"],
  ["author", "CHECK (length(display_name) <= 64)"],
  ["author", "CHECK (length(link) <= 2048)"],
  ["author", "CHECK (link = ''::text OR link ~* '^https://'::text)"],
  ["metadata", "CHECK (status = ANY (ARRAY['ready'::text, 'deleted'::text]))"],
  ["metadata", "CHECK (device = ANY (ARRAY['pc'::text, 'mb'::text]))"],
  ["metadata", "CHECK (brightness = ANY (ARRAY['dark'::text, 'light'::text]))"],
  ["metadata", "CHECK (theme <> ''::text)"],
  ["metadata", "CHECK (length(theme) <= 32)"],
  ["metadata", "CHECK (theme ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'::text)"],
  ["metadata", "CHECK (author <> ''::text)"],
  ["metadata", "CHECK (length(author) <= 32)"],
  ["metadata", "CHECK (author ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'::text)"],
  ["metadata", "CHECK (ext = ANY (ARRAY['jpg'::text, 'png'::text, 'webp'::text, 'gif'::text, 'avif'::text]))"],
  ["metadata", "CHECK (md5 ~ '^[a-f0-9]{32}$'::text)"],
  ["metadata", "CHECK (width >= 0)"],
  ["metadata", "CHECK (height >= 0)"],
  ["metadata", "CHECK (image_size >= 0)"],
  ["metadata", "CHECK (thumbnail_size >= 0)"],
  ["metadata", "CHECK (length(source) <= 2048)"],
  ["metadata", "CHECK (source = ''::text OR source ~* '^https://'::text)"],
  ["metadata", "CHECK (length(original) <= 2048)"],
  ["metadata", "CHECK (original = ''::text OR original ~* '^https://'::text)"],
  ["metadata", "CHECK (purge_state = ANY (ARRAY['idle'::text, 'purging'::text, 'failed'::text]))"],
  ["ready_image_revision", "CHECK (singleton = 1)"],
  ["ready_image_revision", "CHECK (revision >= 0)"],
  ["import_session", "CHECK (mode = ANY (ARRAY['upload'::text, 'download'::text]))"],
  ["import_session", "CHECK (status = ANY (ARRAY['created'::text, 'materializing'::text, 'received'::text, 'preparing'::text, 'ready'::text, 'committing'::text, 'finalized'::text, 'failed'::text, 'cancelled'::text]))"],
  ["import_session", "CHECK (expected_size IS NULL OR expected_size > 0)"],
  ["import_session", "CHECK (source_url = ''::text OR source_url ~* '^https://'::text)"],
  ["background_job", "CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'succeeded'::text, 'failed'::text, 'ignored'::text]))"],
  ["admin_account", "CHECK (role = ANY (ARRAY['super'::text, 'image'::text]))"],
  ["admin_account", "CHECK (jsonb_typeof(preferences) = 'object'::text)"],
  ["admin_account", "CHECK (octet_length(preferences::text) <= 4096)"],
  ["admin_account", "CHECK (char_length(password_hash) >= 64 AND char_length(password_hash) <= 512 AND password_hash ~ '^\\$argon2id\\$v=[0-9]+\\$m=[0-9]+,t=[0-9]+,p=[0-9]+\\$[A-Za-z0-9+/]+\\$[A-Za-z0-9+/]+$'::text)"]
] as const;

const requiredUniqueIndexes = [
  ["storage_backend", "is_default", "is_default"],
  ["import_session", "final_object_key", "final_object_key <> ''::text"],
  ["background_job", "type", "type = 'cache.rebuild'::text AND (status = ANY (ARRAY['pending'::text, 'running'::text]))"],
  ["background_job", "idempotency_key", "idempotency_key IS NOT NULL"],
  ["admin_account", "role", "role = 'super'::text"]
] as const;

// Index names are intentionally excluded from the contract: PostgreSQL does
// not expose them to application queries. The complete semantic definition is
// still fixed so ordering, predicates, expressions, collations and opclasses
// cannot introduce a write-time failure after readiness has succeeded.
const requiredNonUniqueIndexes = [
  "background_job USING btree (status, updated_at)",
  "background_job USING btree (target_id, type)",
  "image_tag USING btree (tag_slug, image_id)",
  "import_session USING btree (status, expires_at)",
  "metadata USING btree (author)",
  "metadata USING btree (author, image_time DESC, id DESC) WHERE (status = 'ready'::text)",
  "metadata USING btree (brightness, image_time DESC, id DESC) WHERE (status = 'ready'::text)",
  "metadata USING btree (brightness, theme, image_time DESC, id DESC) WHERE (status = 'ready'::text)",
  "metadata USING btree (device, brightness, image_time DESC, id DESC) WHERE (status = 'ready'::text)",
  "metadata USING btree (device, brightness, theme, id) WHERE (status = 'ready'::text)",
  "metadata USING btree (device, brightness, theme, image_time DESC, id DESC) WHERE (status = 'ready'::text)",
  "metadata USING btree (device, image_time DESC, id DESC) WHERE (status = 'ready'::text)",
  "metadata USING btree (device, theme, image_time DESC, id DESC) WHERE (status = 'ready'::text)",
  "metadata USING btree (image_time DESC, id DESC) WHERE (status = 'ready'::text)",
  "metadata USING btree (md5)",
  "metadata USING btree (purge_state, deleted_at, id) WHERE (status = 'deleted'::text)",
  "metadata USING btree (regexp_replace(object_key, '\\.[^/.]+$'::text, '.webp'::text))",
  "metadata USING btree (\"right\"((id)::text, 12)) WHERE (status = 'ready'::text)",
  "metadata USING btree (status, deleted_at, id)",
  "metadata USING btree (status, image_time DESC, id DESC)",
  "metadata USING btree (storage_slug)",
  "metadata USING btree (theme)",
  "metadata USING btree (theme, image_time DESC, id DESC) WHERE (status = 'ready'::text)"
] as const;

const constraintUniqueIndexes = [
  ["storage_backend", "slug", null],
  ["theme", "slug", null],
  ["tag", "slug", null],
  ["author", "slug", null],
  ["metadata", "id", null],
  ["metadata", "object_key", null],
  ["image_tag", "image_id,tag_slug", null],
  ["ready_image_revision", "singleton", null],
  ["import_session", "id", null],
  ["import_session", "idempotency_key", null],
  ["background_job", "id", null],
  ["admin_account", "username", null]
] as const;

const requiredBackgroundJobTypes = [
  "move.cleanup",
  "import.cleanup",
  "trash.purge",
  "cache.rebuild"
] as const;

const acceptedBackgroundJobTypeChecks = new Set([
  "CHECK (type = ANY (ARRAY['move.cleanup'::text, 'import.cleanup'::text, 'trash.purge'::text, 'cache.rebuild'::text]))",
  "CHECK (type = ANY (ARRAY['thumb.generate'::text, 'move.cleanup'::text, 'import.cleanup'::text, 'trash.purge'::text, 'cache.rebuild'::text]))"
].map(normalizeDefinition));

async function assertRelations(database: DatabaseReader) {
  const rows = (await database.query<{
    table_name: string;
    relation_kind: string;
    persistence: string;
    is_partition: boolean;
    has_inheritance: boolean;
    access_method: string | null;
    row_security: boolean;
    force_row_security: boolean;
    has_custom_trigger: boolean;
    has_custom_rule: boolean;
  }>(
    `SELECT CASE
              WHEN namespace.nspname='public' THEN relation.relname
              ELSE namespace.nspname || '.' || relation.relname
            END AS table_name,
            relation.relkind::text AS relation_kind,
            relation.relpersistence::text AS persistence,
            relation.relispartition AS is_partition,
            EXISTS (
              SELECT 1
                FROM pg_inherits inheritance
               WHERE inheritance.inhrelid=relation.oid
                  OR inheritance.inhparent=relation.oid
            ) AS has_inheritance,
            access_method.amname AS access_method,
            relation.relrowsecurity AS row_security,
            relation.relforcerowsecurity AS force_row_security,
            EXISTS (
              SELECT 1
                FROM pg_trigger trigger_record
               WHERE trigger_record.tgrelid=relation.oid
                 AND NOT trigger_record.tgisinternal
            ) AS has_custom_trigger,
            EXISTS (
              SELECT 1
                FROM pg_rewrite rewrite
               WHERE rewrite.ev_class=relation.oid
                 AND rewrite.rulename <> '_RETURN'
            ) AS has_custom_rule
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       LEFT JOIN pg_am access_method ON access_method.oid=relation.relam
      WHERE namespace.nspname='public'
        AND relation.relname = ANY($1::text[])`,
    [readinessRelations]
  )).rows;
  const relations = new Map(rows.map((row) => [row.table_name, row]));
  const invalid = readinessRelations.filter((table) => {
    const relation = relations.get(table);
    return (
      !relation
      || relation.relation_kind !== "r"
      || relation.persistence !== "p"
      || relation.is_partition
      || relation.has_inheritance
      || relation.access_method !== "heap"
      || relation.row_security
      || relation.force_row_security
      || relation.has_custom_trigger
      || relation.has_custom_rule
    );
  });
  if (invalid.length) {
    throw new Error(
      `required public tables are missing or have unsupported storage, partition, inheritance, row-security, trigger, or rule semantics: ${invalid.join(", ")}`
    );
  }
}

async function assertColumns(database: DatabaseReader) {
  const rows = (await database.query<{
    table_name: string;
    column_name: string;
    udt_name: string;
    formatted_type: string;
    collation_name: string | null;
    is_nullable: "YES" | "NO";
    column_default: string | null;
    is_generated: string;
    is_identity: string;
  }>(
    `SELECT column_info.table_name,
            column_info.column_name,
            column_info.udt_name,
            format_type(attribute.atttypid, attribute.atttypmod) AS formatted_type,
            column_info.collation_name,
            column_info.is_nullable,
            column_info.column_default,
            column_info.is_generated,
            column_info.is_identity
       FROM information_schema.columns column_info
       JOIN pg_namespace namespace
         ON namespace.nspname=column_info.table_schema
       JOIN pg_class relation
         ON relation.relnamespace=namespace.oid
        AND relation.relname=column_info.table_name
       JOIN pg_attribute attribute
         ON attribute.attrelid=relation.oid
        AND attribute.attname=column_info.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      WHERE column_info.table_schema='public'
        AND column_info.table_name = ANY($1::text[])`,
    [readinessRelations]
  )).rows;
  const actual = new Map(
    rows.map((row) => [`${row.table_name}.${row.column_name}`, row])
  );
  const invalid: string[] = [];
  for (const [table, columns] of Object.entries(requiredDatabaseColumns)) {
    for (const [name, expected] of Object.entries(columns)) {
      const found = actual.get(`${table}.${name}`);
      if (
        !found
        || found.udt_name !== expected.udtName
        || found.formatted_type !== expected.formattedType
        || found.collation_name !== null
        || (found.is_nullable === "YES") !== expected.nullable
        || found.column_default !== expected.defaultExpression
        || found.is_generated !== "NEVER"
        || found.is_identity !== "NO"
      ) {
        invalid.push(`${table}.${name}`);
      }
    }
  }
  const required = new Set(
    Object.entries(requiredDatabaseColumns).flatMap(([table, columns]) => (
      Object.keys(columns).map((name) => `${table}.${name}`)
    ))
  );
  for (const found of rows) {
    const qualifiedName = `${found.table_name}.${found.column_name}`;
    if (required.has(qualifiedName)) continue;
    const allowed = allowedLegacyDatabaseColumns.get(qualifiedName);
    if (
      !allowed
      || found.udt_name !== allowed.udtName
      || found.formatted_type !== allowed.formattedType
      || found.collation_name !== null
      || (found.is_nullable === "YES") !== allowed.nullable
      || found.column_default !== allowed.defaultExpression
      || found.is_generated !== "NEVER"
      || found.is_identity !== "NO"
    ) {
      invalid.push(`${qualifiedName} (unsupported extra column)`);
    }
  }
  if (invalid.length) {
    throw new Error(`required columns have missing or incompatible definitions: ${invalid.join(", ")}`);
  }
}

async function assertConstraints(database: DatabaseReader) {
  const rows = (await database.query<{
    table_name: string;
    constraint_type: string;
    definition: string;
    columns: string;
    validated: boolean;
  }>(
    `SELECT CASE
              WHEN namespace.nspname='public' THEN relation.relname
              ELSE namespace.nspname || '.' || relation.relname
            END AS table_name,
            con.contype::text AS constraint_type,
            pg_get_constraintdef(con.oid, true) AS definition,
            array_to_string(ARRAY(
              SELECT attribute.attname
                FROM unnest(con.conkey) WITH ORDINALITY key(attnum, position)
                JOIN pg_attribute attribute
                  ON attribute.attrelid=con.conrelid
                 AND attribute.attnum=key.attnum
               ORDER BY key.position
            ), ',') AS columns,
            con.convalidated AS validated
       FROM pg_constraint con
       JOIN pg_class relation ON relation.oid=con.conrelid
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       LEFT JOIN pg_class referenced_relation
         ON referenced_relation.oid=con.confrelid
       LEFT JOIN pg_namespace referenced_namespace
         ON referenced_namespace.oid=referenced_relation.relnamespace
      WHERE (
              (
                namespace.nspname='public'
                AND relation.relname = ANY($1::text[])
              )
              OR (
                con.contype='f'
                AND referenced_namespace.nspname='public'
                AND referenced_relation.relname = ANY($1::text[])
              )
            )
        AND con.contype IN ('p', 'u', 'f', 'c', 'x')`,
    [readinessRelations]
  )).rows;
  const validDefinitions = new Set(
    rows
      .filter((row) => row.validated)
      .map((row) => `${row.table_name}|${normalizeDefinition(row.definition)}`)
  );
  const required = [...requiredRelationalConstraints, ...requiredCheckConstraints];
  const missing = required.filter(([table, definition]) => (
    !validDefinitions.has(`${table}|${normalizeDefinition(definition)}`)
  ));
  if (missing.length) {
    throw new Error(
      `required constraints are missing or incompatible: `
        + missing.map(([table, definition]) => `${table}.${definition}`).join(", ")
    );
  }
  const allowedDefinitions = new Set(required.map(([table, definition]) => (
    `${table}|${normalizeDefinition(definition)}`
  )));
  const unexpected = rows.filter((row) => {
    const definition = normalizeDefinition(row.definition);
    if (
      row.table_name === "background_job"
      && row.constraint_type === "c"
      && acceptedBackgroundJobTypeChecks.has(definition)
    ) {
      return false;
    }
    return !allowedDefinitions.has(`${row.table_name}|${definition}`);
  });
  if (unexpected.length) {
    throw new Error(
      `required tables have unsupported constraints: `
        + unexpected
          .map((row) => `${row.table_name}.${row.definition}`)
          .join(", ")
    );
  }
  const typeConstraints = rows.filter((row) => (
    row.table_name === "background_job"
    && row.constraint_type === "c"
    && row.columns.split(",").includes("type")
    && row.validated
  ));
  if (
    typeConstraints.length !== 1
    || !acceptedBackgroundJobTypeChecks.has(
      normalizeDefinition(typeConstraints[0]?.definition ?? null)
    )
  ) {
    throw new Error(
      `background_job.type does not have one accepted active-type constraint: `
        + requiredBackgroundJobTypes.join(", ")
    );
  }
}

async function assertForeignKeyTriggers(database: DatabaseReader) {
  const rows = (await database.query<{
    table_name: string;
    definition: string;
    trigger_count: number;
    triggers_ready: boolean;
  }>(
    `SELECT relation.relname AS table_name,
            pg_get_constraintdef(con.oid, true) AS definition,
            count(trigger_record.oid)::int AS trigger_count,
            COALESCE(
              bool_and(
                trigger_record.tgisinternal
                AND trigger_record.tgenabled='O'
                AND trigger_record.tgconstraint=con.oid
              ),
              false
            ) AS triggers_ready
       FROM pg_constraint con
       JOIN pg_class relation ON relation.oid=con.conrelid
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       LEFT JOIN pg_trigger trigger_record
         ON trigger_record.tgconstraint=con.oid
      WHERE namespace.nspname='public'
        AND relation.relname = ANY($1::text[])
        AND con.contype='f'
      GROUP BY con.oid, relation.relname`,
    [readinessRelations]
  )).rows;
  const invalid = rows.filter((row) => (
    row.trigger_count !== 4 || !row.triggers_ready
  ));
  if (invalid.length) {
    throw new Error(
      `required foreign keys do not have their four enabled internal triggers: `
        + invalid
          .map((row) => `${row.table_name}.${row.definition}`)
          .join(", ")
    );
  }
}

async function assertRuntimeDatabaseAccess(database: DatabaseReader) {
  const session = (await database.query<{
    transaction_read_only: string;
    session_replication_role: string;
    public_schema_usage: boolean;
  }>(
    `SELECT current_setting('transaction_read_only') AS transaction_read_only,
            current_setting('session_replication_role') AS session_replication_role,
            has_schema_privilege(current_user, 'public', 'USAGE')
              AS public_schema_usage`
  )).rows[0];
  if (
    session?.transaction_read_only !== "off"
    || session.session_replication_role !== "origin"
    || !session.public_schema_usage
  ) {
    throw new Error(
      `database session cannot safely run ImageShow writes: `
        + `transaction_read_only=${session?.transaction_read_only ?? "unknown"}, `
        + `session_replication_role=${session?.session_replication_role ?? "unknown"}, `
        + `public_schema_usage=${session?.public_schema_usage ?? false}`
    );
  }

  const required = Object.entries(requiredTablePrivileges).flatMap(
    ([table, privileges]) => privileges.map((privilege) => ({
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

async function assertUniqueIndexes(database: DatabaseReader) {
  const rows = (await database.query<{
    table_name: string;
    key_definitions: string;
    predicate: string | null;
    key_count: number;
    attribute_count: number;
    has_expressions: boolean;
    nulls_not_distinct: boolean;
    access_method: string;
    is_valid: boolean;
    is_ready: boolean;
    is_live: boolean;
  }>(
    `SELECT relation.relname AS table_name,
            array_to_string(ARRAY(
              SELECT pg_get_indexdef(
                       index_record.indexrelid,
                       position,
                       true
                     )
                FROM generate_series(
                       1,
                       index_record.indnkeyatts::integer
                     ) AS key_position(position)
               ORDER BY key_position.position
            ), ',') AS key_definitions,
            pg_get_expr(index_record.indpred, index_record.indrelid, true) AS predicate,
            index_record.indnkeyatts::integer AS key_count,
            index_record.indnatts::integer AS attribute_count,
            index_record.indexprs IS NOT NULL AS has_expressions,
            index_record.indnullsnotdistinct AS nulls_not_distinct,
            access_method.amname AS access_method,
            index_record.indisvalid AS is_valid,
            index_record.indisready AS is_ready,
            index_record.indislive AS is_live
       FROM pg_index index_record
       JOIN pg_class relation ON relation.oid=index_record.indrelid
       JOIN pg_class index_relation ON index_relation.oid=index_record.indexrelid
       JOIN pg_am access_method ON access_method.oid=index_relation.relam
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public'
        AND relation.relname = ANY($1::text[])
        AND index_record.indisunique`,
    [readinessRelations]
  )).rows;
  const unsupportedShapes = rows.filter((row) => (
    row.key_count !== row.attribute_count
    || row.has_expressions
    || row.nulls_not_distinct
    || row.access_method !== "btree"
    || !row.is_valid
    || !row.is_ready
    || !row.is_live
  ));
  if (unsupportedShapes.length) {
    throw new Error(
      `required tables have unsupported unique index shapes: `
        + unsupportedShapes
          .map((row) => `${row.table_name}(${row.key_definitions})`)
          .join(", ")
    );
  }
  const actual = new Set(rows.map((row) => (
    `${row.table_name}|${row.key_definitions}|${normalizeDefinition(row.predicate)}`
  )));
  const missing = requiredUniqueIndexes.filter(([table, columns, predicate]) => (
    !actual.has(`${table}|${columns}|${normalizeDefinition(predicate)}`)
  ));
  if (missing.length) {
    throw new Error(
      `required unique indexes are missing or incompatible: `
        + missing.map(([table, columns]) => `${table}(${columns})`).join(", ")
    );
  }
  const allowed = new Set(
    [...constraintUniqueIndexes, ...requiredUniqueIndexes].map(
      ([table, columns, predicate]) => (
        `${table}|${columns}|${normalizeDefinition(predicate)}`
      )
    )
  );
  const unexpected = [...actual].filter((key) => !allowed.has(key));
  if (unexpected.length) {
    throw new Error(
      `required tables have unsupported unique indexes: ${unexpected.join(", ")}`
    );
  }
}

function semanticIndexDefinition(definition: string) {
  const marker = " ON public.";
  const markerIndex = definition.indexOf(marker);
  return markerIndex === -1
    ? definition
    : definition.slice(markerIndex + marker.length);
}

async function assertNonUniqueIndexes(database: DatabaseReader) {
  const rows = (await database.query<{
    table_name: string;
    definition: string;
    is_valid: boolean;
    is_ready: boolean;
    is_live: boolean;
  }>(
    `SELECT relation.relname AS table_name,
            pg_get_indexdef(index_record.indexrelid) AS definition,
            index_record.indisvalid AS is_valid,
            index_record.indisready AS is_ready,
            index_record.indislive AS is_live
       FROM pg_index index_record
       JOIN pg_class relation ON relation.oid=index_record.indrelid
       JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public'
        AND relation.relname = ANY($1::text[])
        AND NOT index_record.indisunique`,
    [readinessRelations]
  )).rows;
  const expected = new Set<string>(requiredNonUniqueIndexes);
  const actualDefinitions = rows.map((row) => (
    semanticIndexDefinition(row.definition)
  ));
  const actual = new Set(actualDefinitions);
  const missing = requiredNonUniqueIndexes.filter((definition) => (
    !actual.has(definition)
  ));
  const unexpected = rows.filter((row) => (
    !row.is_valid
    || !row.is_ready
    || !row.is_live
    || !expected.has(semanticIndexDefinition(row.definition))
  ));
  const duplicateDefinitions = actualDefinitions.filter((definition, index) => (
    actualDefinitions.indexOf(definition) !== index
  ));
  if (missing.length || unexpected.length || duplicateDefinitions.length) {
    throw new Error(
      `required non-unique indexes are missing or incompatible: `
        + [
          ...missing.map((definition) => `missing ${definition}`),
          ...unexpected.map((row) => row.definition),
          ...duplicateDefinitions.map((definition) => `duplicate ${definition}`)
        ].join(", ")
    );
  }
}

async function assertSeedRows(database: DatabaseReader) {
  const row = (await database.query<{
    revision_ready: boolean;
    local_storage_ready: boolean;
    none_theme_ready: boolean;
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
            ) AS none_theme_ready`
  )).rows[0];
  const missing = [
    !row?.revision_ready && "ready_image_revision singleton",
    !row?.local_storage_ready && "storage_backend.local",
    !row?.none_theme_ready && "theme.none"
  ].filter((value): value is string => Boolean(value));
  if (missing.length) {
    throw new Error(`required seed rows are missing or invalid: ${missing.join(", ")}`);
  }
}

/**
 * Read-only application-side contract for both clean installs and compatible
 * supersets. The two exact v4.6 legacy columns and its wider job-type CHECK are
 * accepted without restoring the removed producer or handler. Unrelated tables
 * remain harmless, while all write-affecting relation, column, constraint,
 * trigger, index, session and role semantics are fail-closed.
 */
export async function assertDatabaseStructure(database: DatabaseReader) {
  await assertRuntimeDatabaseAccess(database);
  await assertRelations(database);
  await assertColumns(database);
  await assertConstraints(database);
  await assertForeignKeyTriggers(database);
  await assertUniqueIndexes(database);
  await assertNonUniqueIndexes(database);
  await assertSeedRows(database);
}
