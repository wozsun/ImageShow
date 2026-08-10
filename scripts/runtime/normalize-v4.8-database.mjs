#!/usr/bin/env node

import process from "node:process";
import pg from "pg";

const { Client } = pg;

const currentTypes = Object.freeze({
  storage: Object.freeze(["local", "s3"]),
  job: Object.freeze([
    "move.cleanup",
    "import.cleanup",
    "trash.purge",
    "cache.rebuild"
  ])
});
const legacyTypes = Object.freeze({
  storage: Object.freeze([...currentTypes.storage, "webdav"]),
  job: Object.freeze(["thumb.generate", ...currentTypes.job])
});
const legacyColumns = Object.freeze([
  Object.freeze({ table: "metadata", column: "extra" }),
  Object.freeze({ table: "background_job", column: "result" })
]);
const typeConstraints = Object.freeze([
  Object.freeze({
    key: "storage",
    table: "storage_backend",
    name: "storage_backend_type_check",
    values: currentTypes.storage
  }),
  Object.freeze({
    key: "job",
    table: "background_job",
    name: "background_job_type_check",
    values: currentTypes.job
  })
]);

function parseMode(arguments_) {
  if (arguments_.length === 0) return "check";
  if (arguments_.length === 1 && arguments_[0] === "--check") return "check";
  if (arguments_.length === 1 && arguments_[0] === "--apply") return "apply";
  throw new Error("usage: normalize-v4.8-database.mjs [--check|--apply]");
}

function requiredEnvironment(name, { trim = true } = {}) {
  const rawValue = process.env[name] ?? "";
  const value = trim ? rawValue.trim() : rawValue;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function databaseConfig() {
  const rawPort = (process.env.DATABASE_PORT ?? "5432").trim();
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DATABASE_PORT must be an integer from 1 to 65535");
  }
  return {
    application_name: "imageshow-v4.8-database-normalizer",
    connectionTimeoutMillis: 10_000,
    host: process.env.DATABASE_HOST?.trim() || "postgresql",
    port,
    database: requiredEnvironment("DATABASE_NAME"),
    user: requiredEnvironment("DATABASE_USER"),
    password: requiredEnvironment("DATABASE_PASSWORD", { trim: false })
  };
}

function sameMembers(actual, expected) {
  return actual.length === expected.length
    && expected.every((value) => actual.includes(value));
}

function stripOuterParentheses(value) {
  let result = value.trim();
  while (result.startsWith("(") && result.endsWith(")")) {
    let depth = 0;
    let wrapsWholeExpression = true;
    for (let index = 0; index < result.length; index += 1) {
      const character = result[index];
      if (character === "(") depth += 1;
      if (character === ")") depth -= 1;
      if (depth === 0 && index < result.length - 1) {
        wrapsWholeExpression = false;
        break;
      }
    }
    if (!wrapsWholeExpression) break;
    result = result.slice(1, -1).trim();
  }
  return result;
}

function simpleMembershipValues(definition) {
  if (!definition?.startsWith("CHECK ") || !definition.endsWith(")")) return null;
  const expression = stripOuterParentheses(definition.slice(6).trim());
  const match = /^"?type"?\s*=\s*ANY\s*\(\s*ARRAY\s*\[(.*)\]\s*\)$/s.exec(
    expression
  );
  if (!match) return null;
  const members = match[1];
  const values = [];
  const remainder = members.replace(
    /'((?:''|[^'])*)'::text/g,
    (_token, value) => {
      values.push(value.replaceAll("''", "'"));
      return "";
    }
  );
  if (remainder.replace(/[\s,]/g, "") !== "") return null;
  if (values.length === 0 || new Set(values).size !== values.length) return null;
  return values;
}

function numberFromRow(row, key) {
  return Number(row?.[key] ?? 0);
}

async function inspectRelations(client) {
  const result = await client.query(`
    SELECT relation.relname AS table_name,
           relation.oid::text AS table_oid,
           relation.relkind,
           owner.rolname AS owner_name,
           pg_has_role(current_user, relation.relowner, 'MEMBER') AS can_alter,
           attribute.attname AS column_name,
           attribute.attnum,
           format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
           attribute.attnotnull AS not_null,
           attribute_default.oid::text AS default_oid,
           pg_get_expr(attribute_default.adbin, attribute_default.adrelid)
             AS column_default
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      JOIN pg_roles owner ON owner.oid=relation.relowner
      LEFT JOIN pg_attribute attribute
        ON attribute.attrelid=relation.oid
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND attribute.attname IN ('type', 'extra', 'result')
      LEFT JOIN pg_attrdef attribute_default
        ON attribute_default.adrelid=attribute.attrelid
       AND attribute_default.adnum=attribute.attnum
     WHERE namespace.nspname='public'
       AND relation.relname IN ('metadata', 'background_job', 'storage_backend')
     ORDER BY relation.relname, attribute.attnum
  `);
  const relations = {};
  for (const row of result.rows) {
    relations[row.table_name] ??= {
      exists: true,
      table_oid: row.table_oid,
      relkind: row.relkind,
      owner_name: row.owner_name,
      can_alter: row.can_alter,
      columns: {}
    };
    if (row.column_name) relations[row.table_name].columns[row.column_name] = row;
  }
  return relations;
}

async function inspectDependencies(client, column) {
  const result = await client.query(`
    SELECT dependency.classid::regclass::text AS dependent_catalog,
           dependency.objid::text,
           dependency.objsubid,
           dependency.deptype,
           pg_describe_object(
             dependency.classid,
             dependency.objid,
             dependency.objsubid
           ) AS dependent_object,
           dependent_constraint.contype AS constraint_type,
           dependent_constraint.conrelid::text AS constraint_table_oid,
           dependent_constraint.conkey AS constraint_columns,
           pg_get_constraintdef(dependent_constraint.oid, true)
             AS constraint_definition
      FROM pg_depend dependency
      LEFT JOIN pg_constraint dependent_constraint
        ON dependency.classid='pg_constraint'::regclass
       AND dependent_constraint.oid=dependency.objid
     WHERE dependency.refclassid='pg_class'::regclass
       AND dependency.refobjid=$1::oid
       AND dependency.refobjsubid=$2
     ORDER BY dependent_catalog, dependency.objid, dependency.objsubid
  `, [column.table_oid, column.attnum]);

  const dependencies = result.rows.map((row) => ({
    dependent_catalog: row.dependent_catalog,
    deptype: row.deptype,
    dependent_object: row.dependent_object
  }));
  const unknown = result.rows.filter((row) => {
    if (
      row.dependent_catalog === "pg_attrdef"
      && row.deptype === "a"
      && row.objid === column.default_oid
    ) return false;
    return !(
      row.dependent_catalog === "pg_constraint"
      && row.deptype === "a"
      && row.constraint_type === "n"
      && row.constraint_table_oid === column.table_oid
      && Array.isArray(row.constraint_columns)
      && row.constraint_columns.length === 1
      && row.constraint_columns[0] === column.attnum
      && row.constraint_definition === `NOT NULL ${column.column_name}`
    );
  }).map((row) => row.dependent_object);
  return { dependencies, unknown };
}

async function inspectLegacyColumn(client, relations, specification) {
  const relation = relations[specification.table];
  const column = relation?.columns[specification.column];
  if (!relation) {
    return { ...specification, exists: false, table_exists: false };
  }
  const total = await client.query(
    `SELECT count(*)::text AS total_rows FROM public.${specification.table}`
  );
  if (!column) {
    return {
      ...specification,
      exists: false,
      table_exists: true,
      total_rows: numberFromRow(total.rows[0], "total_rows"),
      non_null_rows: 0,
      non_default_rows: 0,
      dependencies: [],
      unknown_dependencies: []
    };
  }
  const counts = column.data_type === "jsonb"
    ? await client.query(`
        SELECT count(*) FILTER (WHERE ${specification.column} IS NOT NULL)::text
                 AS non_null_rows,
               count(*) FILTER (
                 WHERE ${specification.column} IS DISTINCT FROM '{}'::jsonb
               )::text AS non_default_rows
          FROM public.${specification.table}
      `)
    : await client.query(`
        SELECT count(*) FILTER (WHERE ${specification.column} IS NOT NULL)::text
                 AS non_null_rows
          FROM public.${specification.table}
      `);
  const dependencyInspection = await inspectDependencies(client, column);
  return {
    ...specification,
    exists: true,
    table_exists: true,
    data_type: column.data_type,
    not_null: column.not_null,
    column_default: column.column_default,
    total_rows: numberFromRow(total.rows[0], "total_rows"),
    non_null_rows: numberFromRow(counts.rows[0], "non_null_rows"),
    non_default_rows: column.data_type === "jsonb"
      ? numberFromRow(counts.rows[0], "non_default_rows")
      : null,
    dependencies: dependencyInspection.dependencies,
    unknown_dependencies: dependencyInspection.unknown
  };
}

async function inspectConstraint(client, relations, specification) {
  const result = await client.query(`
    SELECT constraint_.contype,
           constraint_.convalidated,
           constraint_.connoinherit,
           constraint_.conkey,
           pg_get_constraintdef(constraint_.oid, true) AS definition
      FROM pg_constraint constraint_
     WHERE constraint_.conrelid=to_regclass($1)
       AND constraint_.conname=$2
  `, [`public.${specification.table}`, specification.name]);
  const row = result.rows[0];
  if (!row) return { ...specification, exists: false, state: "missing" };
  const typeColumn = relations[specification.table]?.columns.type;
  const values = simpleMembershipValues(row.definition);
  let state = "unknown";
  if (
    row.contype === "c"
    && row.convalidated
    && !row.connoinherit
    && typeColumn
    && Array.isArray(row.conkey)
    && row.conkey.length === 1
    && row.conkey[0] === typeColumn.attnum
    && values
  ) {
    if (sameMembers(values, currentTypes[specification.key])) state = "current";
    else if (sameMembers(values, legacyTypes[specification.key])) state = "legacy";
  }
  return {
    ...specification,
    exists: true,
    definition: row.definition,
    validated: row.convalidated,
    columns: row.conkey,
    membership_values: values,
    state
  };
}

async function groupedCounts(client, table) {
  const result = await client.query(
    `SELECT type, count(*)::text AS count
       FROM public.${table}
      GROUP BY type
      ORDER BY type`
  );
  return Object.fromEntries(
    result.rows.map((row) => [row.type, Number(row.count)])
  );
}

function replacementDdl(specification) {
  const values = specification.values
    .map((value) => `'${value.replaceAll("'", "''")}'`)
    .join(", ");
  return [
    `ALTER TABLE public.${specification.table} DROP CONSTRAINT ${specification.name};`,
    `ALTER TABLE public.${specification.table} ADD CONSTRAINT ${specification.name} CHECK (type IN (${values}));`
  ];
}

async function inspectDatabase(client) {
  const identityResult = await client.query(`
    SELECT current_database() AS database,
           current_user AS user,
           inet_server_addr()::text AS server_address,
           inet_server_port() AS server_port,
           current_setting('server_version') AS server_version
  `);
  const sessionResult = await client.query(`
    SELECT pid, usename, application_name, client_addr::text AS client_address,
           state
      FROM pg_stat_activity
     WHERE datname=current_database()
       AND backend_type='client backend'
       AND pid <> pg_backend_pid()
     ORDER BY pid
  `);
  const relations = await inspectRelations(client);
  const blockers = [];
  for (const table of ["metadata", "background_job", "storage_backend"]) {
    const relation = relations[table];
    if (!relation || !["r", "p"].includes(relation.relkind)) {
      blockers.push(`required table public.${table} is missing or is not a table`);
    } else if (!relation.can_alter) {
      blockers.push(
        `current user cannot alter public.${table} owned by ${relation.owner_name}`
      );
    }
  }
  for (const table of ["background_job", "storage_backend"]) {
    if (relations[table] && relations[table].columns.type?.data_type !== "text") {
      blockers.push(`required column public.${table}.type is missing or is not text`);
    }
  }

  const columns = [];
  for (const specification of legacyColumns) {
    const column = await inspectLegacyColumn(client, relations, specification);
    columns.push(column);
    if (!column.exists) continue;
    if (
      column.data_type !== "jsonb"
      || !column.not_null
      || column.column_default !== "'{}'::jsonb"
    ) {
      blockers.push(
        `public.${column.table}.${column.column} does not match the known legacy JSONB shape`
      );
    }
    if (column.unknown_dependencies.length > 0) {
      blockers.push(
        `public.${column.table}.${column.column} has unknown dependencies: `
        + column.unknown_dependencies.join(", ")
      );
    }
  }

  const storageRows = relations.storage_backend?.columns.type
    ? await groupedCounts(client, "storage_backend")
    : {};
  const jobRows = relations.background_job?.columns.type
    ? await groupedCounts(client, "background_job")
    : {};
  const unsupportedStorageTypes = Object.keys(storageRows).filter(
    (value) => !currentTypes.storage.includes(value)
  );
  const unsupportedJobTypes = Object.keys(jobRows).filter(
    (value) => !currentTypes.job.includes(value)
  );
  if (unsupportedStorageTypes.length > 0) {
    blockers.push(`unsupported storage rows exist: ${unsupportedStorageTypes.join(", ")}`);
  }
  if (unsupportedJobTypes.length > 0) {
    blockers.push(`unsupported background job rows exist: ${unsupportedJobTypes.join(", ")}`);
  }

  const constraints = [];
  for (const specification of typeConstraints) {
    const constraint = await inspectConstraint(client, relations, specification);
    constraints.push(constraint);
    if (constraint.state === "missing") {
      blockers.push(
        `required constraint public.${constraint.table}.${constraint.name} is missing`
      );
    } else if (constraint.state === "unknown") {
      blockers.push(
        `constraint public.${constraint.table}.${constraint.name} has an unknown shape`
      );
    }
  }

  const pendingDdl = [];
  for (const column of columns) {
    if (column.exists) {
      pendingDdl.push(
        `ALTER TABLE public.${column.table} DROP COLUMN IF EXISTS ${column.column};`
      );
    }
  }
  for (const constraint of constraints) {
    if (constraint.state === "legacy") pendingDdl.push(...replacementDdl(constraint));
  }
  const warnings = [];
  for (const column of columns) {
    if ((column.non_default_rows ?? 0) > 0) {
      warnings.push(
        `public.${column.table}.${column.column} contains `
        + `${column.non_default_rows} non-default JSONB rows; --apply will drop them`
      );
    }
  }
  if (sessionResult.rowCount > 0) {
    warnings.push(
      `${sessionResult.rowCount} other database connection(s) remain; stop ImageShow before --apply`
    );
  }
  return {
    target: identityResult.rows[0],
    other_client_connections: sessionResult.rows,
    row_counts: {
      storage_by_type: storageRows,
      background_job_by_type: jobRows,
      webdav: storageRows.webdav ?? 0,
      thumb_generate: jobRows["thumb.generate"] ?? 0
    },
    legacy_columns: columns,
    type_constraints: constraints,
    pending_ddl: pendingDdl,
    blockers,
    warnings,
    ready_to_apply: blockers.length === 0 && sessionResult.rowCount === 0
  };
}

function printReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function check(client) {
  await client.query("BEGIN TRANSACTION READ ONLY");
  try {
    await client.query("SET LOCAL statement_timeout = '60s'");
    const inspection = await inspectDatabase(client);
    await client.query("COMMIT");
    printReport({ format_version: 1, mode: "check", inspection });
    if (!inspection.ready_to_apply) process.exitCode = 2;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function apply(client) {
  let committed = false;
  await client.query("BEGIN");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const beforeLock = await inspectDatabase(client);
    if (beforeLock.blockers.length > 0 || beforeLock.other_client_connections.length > 0) {
      await client.query("ROLLBACK");
      printReport({
        format_version: 1,
        mode: "apply",
        status: "blocked",
        inspection: beforeLock
      });
      process.exitCode = 2;
      return;
    }
    await client.query(`
      LOCK TABLE public.metadata, public.background_job, public.storage_backend
        IN ACCESS EXCLUSIVE MODE
    `);
    const before = await inspectDatabase(client);
    if (!before.ready_to_apply) {
      await client.query("ROLLBACK");
      printReport({
        format_version: 1,
        mode: "apply",
        status: "blocked",
        inspection: before
      });
      process.exitCode = 2;
      return;
    }

    const executedDdl = [];
    for (const column of before.legacy_columns) {
      if (!column.exists) continue;
      const statement = `ALTER TABLE public.${column.table} DROP COLUMN IF EXISTS ${column.column}`;
      await client.query(statement);
      executedDdl.push(`${statement};`);
    }
    for (const constraint of before.type_constraints) {
      if (constraint.state !== "legacy") continue;
      const statements = replacementDdl(constraint);
      for (const statement of statements) {
        await client.query(statement.slice(0, -1));
        executedDdl.push(statement);
      }
    }

    const transactionalAfter = await inspectDatabase(client);
    if (
      transactionalAfter.blockers.length > 0
      || transactionalAfter.pending_ddl.length > 0
      || !transactionalAfter.ready_to_apply
    ) {
      throw new Error("post-DDL inspection did not match the normalized database shape");
    }
    await client.query("COMMIT");
    committed = true;

    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL statement_timeout = '60s'");
    const after = await inspectDatabase(client);
    await client.query("COMMIT");
    if (after.blockers.length > 0 || after.pending_ddl.length > 0) {
      throw new Error("committed DDL did not pass the final read-only inspection");
    }
    printReport({
      format_version: 1,
      mode: "apply",
      status: executedDdl.length > 0 ? "applied" : "already_normalized",
      before,
      executed_ddl: executedDdl,
      after
    });
  } catch (error) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined);
    if (committed) {
      throw new Error(
        `database commit succeeded but final inspection failed; rerun --check: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}

let client;
try {
  const mode = parseMode(process.argv.slice(2));
  client = new Client(databaseConfig());
  await client.connect();
  if (mode === "apply") await apply(client);
  else await check(client);
} catch (error) {
  console.error(`[database-normalization] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await client?.end().catch(() => undefined);
}
